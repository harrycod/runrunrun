import * as Phaser from 'phaser';
import { FINAL_LEN, H_SCREEN, PLAYER_R, PLAYER_SCREEN_Y, STEP, W } from '../config';
import {
  sfxAbsorb,
  sfxAscend,
  sfxButterfly,
  sfxCrash,
  sfxFizzle,
  sfxShard,
  toggleMute,
  unlockAudio,
} from '../audio/sfx';
import { duckMusic, playMusic, preloadMusic, setMuffle, stopMusic } from '../audio/music';
import {
  type Blocked,
  type Cave,
  centerAt,
  getCave,
  rollBlocked,
  headingAt,
  isOpen,
  toWorld,
} from '../level/cave';
import { IS_MOBILE } from '../platform';
import { clearRuns, loadRuns, newLife, type RunRecord, saveRun } from '../runs/runStore';

const ENERGY_MAX = 100;
const ENERGY_DRAIN = 5.5; // 초당
const SHARD_GAIN = 9;
const SHARD_PICK_R = 18;
const MAX_GHOSTS = 5;
const MAX_GUIDES = 48;
const KEY_SPEED = 400;
const POINTER_MAX_SPEED = 500;
const SPEED_START = 290;
const SPEED_END = 540;
/** 1보다 작으면 초반부터 빠르게 가속한다 */
const SPEED_CURVE = 0.75;
const BUTTERFLY_HIT_R = 22;
const BUTTERFLY_KICK = 300;
const DARK_ALPHA = 0.985;
const CAVE_CHUNK = 1200;
/** 화면 아래/위로 이만큼까지만 그린다 */
const VIEW_BELOW = 450;
const VIEW_ABOVE = 1100;
const GHOST_TRAIL = 12;
/** 마지막 구간에 들어서서 어두워지는 데 걸리는 거리 (빠른 속도에서도 약 1.5초) */
const FINAL_FADE = 900;
/** 터치 드래그 감도: 손가락이 움직인 거리의 몇 배를 움직일지 */
const TOUCH_SENS = 1.5;

const COLOR_WALL = 0x05060a;
const COLOR_EDGE = 0x334060;
const COLOR_FLOOR = 0x1c2335;
const COLOR_ROCK = 0x5a6478;
export const COLOR_PLAYER = 0xffe2a0;
export const COLOR_GHOST = 0x9cc8ff;

type State = 'ready' | 'play' | 'dead' | 'top';

/** 마지막 어둠 구간에서 길을 밝혀주는 이전 판들의 빛 */
interface Guide {
  img: Phaser.GameObjects.Image;
  state: 'fly' | 'wait' | 'merge';
  x: number;
  h: number;
  sx: number;
  sh: number;
  tx: number;
  th: number;
  t: number;
  dur: number;
  phase: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 카메라가 플레이어보다 이만큼 앞(진행 거리)을 화면 중앙에 둔다 */
const CAM_AHEAD = H_SCREEN * (PLAYER_SCREEN_Y - 0.5);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export class RunScene extends Phaser.Scene {
  private cave!: Cave;
  private state: State = 'ready';
  private h = 0;
  private x = W / 2;
  private vx = 0;
  private kick = 0;
  private energy = ENERGY_MAX;
  private usePointer = false;
  /** 모바일: 손가락이 움직인 만큼(상대) 빛이 움직인다 */
  private touchMode = IS_MOBILE;
  private dragFrom: { ptrX: number; x: number } | null = null;
  private touchTarget: number | null = null;
  private dragId: number | null = null;
  /** 화면 좌우 버튼: 누르고 있는 포인터 → 방향 */
  private buttonHeld = new Map<number, -1 | 1>();
  private btnLeft!: Phaser.GameObjects.Graphics;
  private btnRight!: Phaser.GameObjects.Graphics;
  private xs: number[] = [];
  private kicks: { h: number; x: number }[] = [];
  private butterflyHit = new Set<number>();
  /** 판마다 랜덤: 나비 위치, 낙석으로 막힌 갈림길 */
  private butterflies: { h: number; dir: 1 | -1 }[] = [];
  private blocked: Blocked = new Map();
  private ghosts: RunRecord[] = [];
  private pastRuns: RunRecord[] = [];
  private runNumber = 1;
  private bestH = 0;
  private finalStart = 0;
  private guides: Guide[] = [];
  private guidesSpawned = false;
  private boost = 0;
  private absorbed = 0;
  private totalGuides = 0;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyW!: Phaser.Input.Keyboard.Key;
  private keyS!: Phaser.Input.Keyboard.Key;

  private player!: Phaser.GameObjects.Image;
  private dark!: Phaser.GameObjects.RenderTexture;
  private trailGfx!: Phaser.GameObjects.Graphics;
  private ghostGfx!: Phaser.GameObjects.Graphics;
  private butterflyGfx!: Phaser.GameObjects.Graphics;
  private shardImgs: Phaser.GameObjects.Image[] = [];
  private shardTaken: boolean[] = [];
  private caveChunks: { h0: number; h1: number; objs: Phaser.GameObjects.Graphics[] }[] = [];
  private burst!: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparkle!: Phaser.GameObjects.Particles.ParticleEmitter;

  private heightText!: Phaser.GameObjects.Text;
  private energyBar!: Phaser.GameObjects.Rectangle;
  private lastHeightLabel = -1;

  /** HUD와 어둠은 회전하지 않는 별도 카메라로 그린다 */
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private uiObjects: Phaser.GameObjects.GameObject[] = [];
  /** 화면은 회전하지 않는다 (toScreen 계산용으로만 남김) */
  private camRot = 0;
  private camCenter = { x: 0, y: 0 };

  constructor() {
    super('Run');
  }

  create() {
    // scene.restart()는 같은 인스턴스를 재사용하므로 상태를 여기서 초기화
    // 맵은 한 번의 삶(엔딩까지) 동안 매 판 같다
    this.cave = getCave();
    this.state = 'ready';
    this.h = 0;
    this.x = W / 2;
    this.vx = 0;
    this.kick = 0;
    this.energy = ENERGY_MAX;
    this.xs = [];
    this.kicks = [];
    this.butterflyHit = new Set();
    this.butterflies = [];
    for (let bh = 1400 + Math.random() * 800; bh < this.cave.height - 2400; bh += 1000 + Math.random() * 1400) {
      this.butterflies.push({ h: Math.round(bh), dir: Math.random() < 0.5 ? -1 : 1 });
    }
    // 지형은 같고, 낙석으로 막히는 갈림길만 판마다 랜덤
    this.blocked = rollBlocked(this.cave);
    this.shardImgs = [];
    this.shardTaken = [];
    this.uiObjects = [];
    this.buttonHeld = new Map();
    this.dragId = null;
    this.dragFrom = null;
    this.touchTarget = null;
    this.guides = [];
    this.guidesSpawned = false;
    this.boost = 0;
    this.absorbed = 0;
    this.totalGuides = 0;
    this.finalStart = this.cave.height - FINAL_LEN;

    this.pastRuns = loadRuns().slice();
    this.runNumber = this.pastRuns.length + 1;
    this.bestH = this.pastRuns.reduce((m, r) => Math.max(m, r.endH), 0);
    this.ghosts = this.pastRuns.slice(-MAX_GHOSTS);

    this.makeTextures();
    this.drawCave();
    this.drawRocks();
    this.drawBestLine();

    this.cave.shards.forEach((s) => {
      const p = this.wp(s.h, s.x);
      this.shardImgs.push(this.add.image(p.x, p.y, 'shard').setDepth(2).setBlendMode(Phaser.BlendModes.ADD));
      this.shardTaken.push(false);
    });

    // 화면 고정 어둠. 매 프레임 빛이 있는 자리를 지운다.
    this.dark = this.add.renderTexture(0, 0, W, H_SCREEN).setOrigin(0, 0).setScrollFactor(0).setDepth(10);
    this.uiObjects.push(this.dark);
    this.ghostGfx = this.add.graphics().setDepth(11).setBlendMode(Phaser.BlendModes.ADD);
    this.butterflyGfx = this.add.graphics().setDepth(12);
    this.trailGfx = this.add.graphics().setDepth(13).setBlendMode(Phaser.BlendModes.ADD);
    this.player = this.add
      .image(this.x, 0, 'glow')
      .setDepth(14)
      .setTint(COLOR_PLAYER)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.burst = this.add
      .particles(0, 0, 'glow', {
        speed: { min: 40, max: 260 },
        lifespan: 800,
        scale: { start: 0.45, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: COLOR_PLAYER,
        blendMode: Phaser.BlendModes.ADD,
        emitting: false,
      })
      .setDepth(15);
    this.sparkle = this.add
      .particles(0, 0, 'glow', {
        speed: { min: 20, max: 90 },
        lifespan: 400,
        scale: { start: 0.25, end: 0 },
        alpha: { start: 0.9, end: 0 },
        tint: 0x9fe8ff,
        blendMode: Phaser.BlendModes.ADD,
        emitting: false,
      })
      .setDepth(15);

    this.createHud();
    this.createButtons();
    this.setupCameras();
    this.setupInput();
    preloadMusic();
    void playMusic('run');
    this.syncCamera();
    this.syncVisuals(0);

    this.time.delayedCall(this.runNumber === 1 ? 1200 : 450, () => {
      if (this.state === 'ready') this.state = 'play';
    });
  }

  // ---------- 준비 ----------

  private makeTextures() {
    if (!this.textures.exists('glow')) {
      const t = this.textures.createCanvas('glow', 64, 64)!;
      const ctx = t.getContext();
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      t.refresh();
    }
    if (!this.textures.exists('shard')) {
      const t = this.textures.createCanvas('shard', 16, 16)!;
      const ctx = t.getContext();
      ctx.fillStyle = '#9fe8ff';
      ctx.beginPath();
      ctx.moveTo(8, 1);
      ctx.lineTo(13, 8);
      ctx.lineTo(8, 15);
      ctx.lineTo(3, 8);
      ctx.closePath();
      ctx.fill();
      t.refresh();
    }
    if (!this.textures.exists('hole')) {
      // 어둠을 지우는 붓: 가운데는 완전히, 바깥으로 갈수록 덜 지운다
      const size = 256;
      const t = this.textures.createCanvas('hole', size, size)!;
      const ctx = t.getContext();
      const r = size / 2;
      const g = ctx.createRadialGradient(r, r, 0, r, r, r);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.22, 'rgba(255,255,255,1)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      t.refresh();
    }
  }

  /**
   * 동굴은 높이 조각으로 나눠 그리고, 화면 근처 조각만 보이게 한다.
   * (Graphics는 보일 때마다 다각형을 다시 계산하므로, 전체를 한 번에 그리면 모바일에서 느려진다)
   */
  private drawCave() {
    this.cameras.main.setBackgroundColor(COLOR_WALL);
    this.caveChunks = [];
    const top = this.cave.corridors.reduce((m, c) => Math.max(m, c.h1), 0);
    // 테두리 색으로 살짝 넓게 먼저 칠하고, 그 위에 바닥색을 칠해 통로 합집합의 외곽선만 남긴다
    const layers: [number, number, number][] = [
      [COLOR_EDGE, 3, 0],
      [COLOR_FLOOR, 0, 0.5],
    ];
    for (let c0 = 0; c0 < top; c0 += CAVE_CHUNK) {
      const objs: Phaser.GameObjects.Graphics[] = [];
      for (const [color, pad, depth] of layers) {
        const g = this.add.graphics().setDepth(depth);
        g.fillStyle(color, 1);
        for (const cor of this.cave.corridors) {
          if (cor.h1 < c0 || cor.h0 > c0 + CAVE_CHUNK) continue;
          const i0 = Math.max(0, Math.floor((c0 - cor.h0) / STEP) - 2);
          const i1 = Math.min(cor.cx.length - 1, Math.ceil((c0 + CAVE_CHUNK - cor.h0) / STEP) + 2);
          if (i1 - i0 < 1) continue;
          const left: Phaser.Math.Vector2[] = [];
          const right: Phaser.Math.Vector2[] = [];
          for (let i = i0; i <= i1; i++) {
            const h = cor.h0 + i * STEP;
            const half = cor.w[i] / 2 + pad;
            const l = this.wp(h, cor.cx[i] - half);
            const r = this.wp(h, cor.cx[i] + half);
            left.push(new Phaser.Math.Vector2(l.x, l.y));
            right.push(new Phaser.Math.Vector2(r.x, r.y));
          }
          g.fillPoints(left.concat(right.reverse()), true);
        }
        objs.push(g);
      }
      this.caveChunks.push({ h0: c0, h1: c0 + CAVE_CHUNK, objs });
    }
  }

  /** 이번 판에 막힌 갈림길. 어둠 위에 흐릿하게 그려서 멀리서도 보이게 한다. */
  private drawRocks() {
    const g = this.add.graphics().setDepth(11);
    let n = 0;
    for (const [ci, bh] of this.blocked) {
      const cor = this.cave.corridors[ci];
      const i = Math.round((bh - cor.h0) / STEP);
      const cx = cor.cx[i];
      const half = cor.w[i] / 2 + 6;
      for (let x = cx - half; x <= cx + half; x += 11) {
        n++;
        const r = 8 + ((n * 37) % 7);
        const p = this.wp(bh + (((n * 53) % 11) - 5), x);
        g.fillStyle(COLOR_ROCK, 0.55).fillCircle(p.x, p.y, r);
        g.fillStyle(0xb8c4da, 0.18).fillCircle(p.x - r * 0.3, p.y - r * 0.35, r * 0.45);
      }
    }
  }

  private drawBestLine() {
    if (this.bestH <= 0) return;
    const g = this.add.graphics().setDepth(11);
    g.lineStyle(1, COLOR_GHOST, 0.35);
    for (let x = 0; x < W; x += 14) {
      const a = this.wp(this.bestH, x);
      const b = this.wp(this.bestH, x + 7);
      g.lineBetween(a.x, a.y, b.x, b.y);
    }
  }

  private createHud() {
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '20px', color: '#c9d4ea' };
    this.heightText = this.add.text(16, 14, '0m', style).setScrollFactor(0).setDepth(20).setAlpha(0.8);
    const runLabel = this.add
      .text(W - 16, 14, `#${this.runNumber}`, style)
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(20)
      .setAlpha(0.5);
    // 게이지는 사각형 두 개. 매 프레임 다시 그리지 않고 가로 배율만 바꾼다.
    const barBg = this.add.rectangle(W / 2 - 80, H_SCREEN - 24, 160, 3, 0xffffff, 0.08).setOrigin(0, 0).setScrollFactor(0).setDepth(20);
    this.energyBar = this.add.rectangle(W / 2 - 80, H_SCREEN - 24, 160, 3, COLOR_PLAYER, 0.8).setOrigin(0, 0).setScrollFactor(0).setDepth(20);
    this.lastHeightLabel = -1;
    this.uiObjects.push(this.heightText, runLabel, barBg, this.energyBar);

    if (this.runNumber === 1) {
      const hint = this.add
        .text(W / 2, H_SCREEN * 0.84, IS_MOBILE ? '좌우로 끌기' : '← →   /   마우스', { ...style, fontSize: '18px' })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(20)
        .setAlpha(0.7);
      this.uiObjects.push(hint);
      this.tweens.add({ targets: hint, alpha: 0, delay: 3000, duration: 1200 });
    }
  }

  /** 화면 아래 양쪽의 좌우 버튼 */
  private createButtons() {
    const make = (dir: -1 | 1) => {
      const r = this.buttonRect(dir);
      const g = this.add.graphics().setScrollFactor(0).setDepth(21);
      g.fillStyle(0xffffff, 0.06).fillRoundedRect(r.x, r.y, r.w, r.h, 22);
      g.lineStyle(1.5, 0xc9d4ea, 0.25).strokeRoundedRect(r.x, r.y, r.w, r.h, 22);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      g.fillStyle(0xc9d4ea, 0.55).fillTriangle(cx + dir * 16, cy, cx - dir * 12, cy - 18, cx - dir * 12, cy + 18);
      this.uiObjects.push(g);
      return g;
    };
    this.btnLeft = make(-1);
    this.btnRight = make(1);
  }

  private buttonRect(dir: -1 | 1) {
    const w = 112;
    const h = 96;
    const y = H_SCREEN - h - 44;
    return { x: dir < 0 ? 16 : W - 16 - w, y, w, h };
  }

  /** 화면 좌표의 포인터가 좌우 버튼 위인지 (-1 왼쪽, 1 오른쪽, 0 아님) */
  private hitButton(p: { x: number; y: number }): -1 | 0 | 1 {
    for (const dir of [-1, 1] as const) {
      const r = this.buttonRect(dir);
      if (p.x >= r.x - 8 && p.x <= r.x + r.w + 8 && p.y >= r.y - 8 && p.y <= r.y + r.h + 8) return dir;
    }
    return 0;
  }

  private setupCameras() {
    const main = this.cameras.main;
    this.uiCam = this.cameras.add(0, 0, W, H_SCREEN);
    main.ignore(this.uiObjects);
    this.uiCam.ignore(this.children.list.filter((o) => !this.uiObjects.includes(o)));
  }

  /** 새로 만든 월드 오브젝트는 UI 카메라에서 빼야 한다 */
  private worldObj<T extends Phaser.GameObjects.GameObject>(o: T): T {
    this.uiCam?.ignore(o);
    return o;
  }

  /** 통로 좌표 (진행 거리 h, 가로 위치 x) → 월드 좌표 */
  private wp(h: number, x: number) {
    return toWorld(this.cave, h, x);
  }

  /** 월드 좌표 → 화면 좌표 (메인 카메라의 중심/회전 기준) */
  private toScreen(p: { x: number; y: number }) {
    const dx = p.x - this.camCenter.x;
    const dy = p.y - this.camCenter.y;
    const c = Math.cos(this.camRot);
    const s = Math.sin(this.camRot);
    return { x: W / 2 + dx * c - dy * s, y: H_SCREEN / 2 + dx * s + dy * c };
  }

  private setupInput() {
    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyW = kb.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyS = kb.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    kb.on('keydown', () => {
      this.usePointer = false;
      unlockAudio();
    });
    // 두 손가락(버튼 + 드래그, 또는 양쪽 버튼)까지 받는다
    if (this.input.manager.pointersTotal < 3) this.input.addPointer(3 - this.input.manager.pointersTotal);
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.buttonHeld.has(p.id)) {
        // 누른 채로 다른 버튼으로 미끄러지면 방향이 바뀐다
        const dir = this.hitButton(p);
        if (dir) this.buttonHeld.set(p.id, dir);
        return;
      }
      if (this.touchMode) {
        if (this.dragFrom && this.dragId === p.id) {
          this.touchTarget = Phaser.Math.Clamp(this.dragFrom.x + (p.x - this.dragFrom.ptrX) * TOUCH_SENS, 0, W);
        }
      } else if (!this.hitButton(p)) {
        this.usePointer = true;
      }
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      unlockAudio();
      const dir = this.hitButton(p);
      if (dir) {
        this.buttonHeld.set(p.id, dir);
        this.usePointer = false;
        return;
      }
      if (this.touchMode) {
        this.dragId = p.id;
        this.dragFrom = { ptrX: p.x, x: this.x };
        this.touchTarget = this.x;
      } else {
        this.usePointer = true;
      }
    });
    const release = (p: Phaser.Input.Pointer) => {
      this.buttonHeld.delete(p.id);
      if (this.dragId === p.id) {
        this.dragId = null;
        this.dragFrom = null;
        this.touchTarget = null;
      }
    };
    this.input.on('pointerup', release);
    this.input.on('pointerupoutside', release);
    kb.on('keydown-M', () => toggleMute());
    // 개발용: R 키로 기록 초기화
    kb.on('keydown-R', () => {
      clearRuns();
      newLife();
      this.scene.restart();
    });
  }

  // ---------- 루프 ----------

  update(time: number, delta: number) {
    const dt = Math.min(delta, 50) / 1000;
    if (this.state === 'play') this.step(dt);
    this.updateGuides(dt);
    this.boost *= Math.exp(-2 * dt);
    this.updateMuffle();
    this.syncCamera();
    this.syncVisuals(time);
  }

  private inFinal() {
    return this.h > this.finalStart;
  }

  private step(dt: number) {
    const progress = this.h / this.cave.height;
    const speed = SPEED_START + (SPEED_END - SPEED_START) * Math.pow(Math.min(1, progress), SPEED_CURVE);
    this.h += speed * dt;
    // 빨라질수록 벽이 기우는 속도도 빨라지므로 좌우 이동도 같이 빨라진다
    const lateral = 0.6 + 0.4 * (speed / 150);

    // 통로를 가로지르는 방향 (화면 기준). 화면은 돌지 않으므로 입력을 이 방향으로 투영한다.
    const th = headingAt(this.cave, this.h);
    const rx = Math.cos(th);
    const ry = Math.sin(th);
    let btnDir = 0;
    for (const d of this.buttonHeld.values()) btnDir += d;
    if (btnDir !== 0) {
      // 화면 좌우 버튼
      this.vx = lerp(this.vx, Math.sign(btnDir) * KEY_SPEED * lateral, 1 - Math.exp(-14 * dt));
    } else if (this.touchMode && this.touchTarget !== null) {
      // 손을 떼면 그 자리에서 곧게 올라간다
      const target = this.touchTarget;
      const max = POINTER_MAX_SPEED * 1.3 * lateral;
      this.vx = Phaser.Math.Clamp((target - this.x) * 14 * lateral, -max, max);
    } else if (this.usePointer) {
      // 마우스가 가리키는 곳에 가장 가까운 통로 위치
      const ptr = this.input.activePointer;
      const wx = this.camCenter.x + (ptr.x - W / 2);
      const wy = this.camCenter.y + (ptr.y - H_SCREEN / 2);
      const c = this.wp(this.h, W / 2);
      const target = W / 2 + (wx - c.x) * rx + (wy - c.y) * ry;
      const max = POINTER_MAX_SPEED * lateral;
      this.vx = Phaser.Math.Clamp((target - this.x) * 9 * lateral, -max, max);
    } else {
      const ix = (this.cursors.right.isDown || this.keyD.isDown ? 1 : 0) - (this.cursors.left.isDown || this.keyA.isDown ? 1 : 0);
      const iy = (this.cursors.down.isDown || this.keyS.isDown ? 1 : 0) - (this.cursors.up.isDown || this.keyW.isDown ? 1 : 0);
      const len = Math.hypot(ix, iy) || 1;
      const want = Phaser.Math.Clamp(((ix * rx + iy * ry) / len) * 1.4, -1, 1);
      this.vx = lerp(this.vx, want * KEY_SPEED * lateral, 1 - Math.exp(-14 * dt));
    }
    this.x += (this.vx + this.kick) * dt;
    this.kick *= Math.exp(-3 * dt);

    this.record();

    // 마지막 구간에서는 빛이 줄지 않는다. 대신 내 빛만으로는 거의 안 보인다.
    if (!this.inFinal()) this.energy -= ENERGY_DRAIN * dt;
    this.collectShards();
    this.updateButterflies();

    if (!this.guidesSpawned && this.h > this.finalStart + 220) this.spawnGuides();

    if (!isOpen(this.cave, this.h, this.x, PLAYER_R, this.blocked)) {
      this.die(true);
    } else if (this.energy <= 0) {
      this.energy = 0;
      this.die(false);
    } else if (this.h >= this.cave.height) {
      this.reachTop();
    }
  }

  private record() {
    const idx = Math.floor(this.h / STEP);
    const rx = Math.round(this.x);
    while (this.xs.length <= idx) this.xs.push(rx);
  }

  private collectShards() {
    const shards = this.cave.shards;
    for (let i = 0; i < shards.length; i++) {
      const s = shards[i];
      if (s.h < this.h - 40) continue;
      if (s.h > this.h + 40) break;
      if (this.shardTaken[i]) continue;
      if (Math.hypot(s.x - this.x, s.h - this.h) < SHARD_PICK_R) {
        this.shardTaken[i] = true;
        this.shardImgs[i].setVisible(false);
        this.energy = Math.min(ENERGY_MAX, this.energy + SHARD_GAIN);
        const p = this.wp(s.h, s.x);
        this.sparkle.explode(8, p.x, p.y);
        sfxShard();
      }
    }
  }

  /** 나비 위치는 플레이어 높이에 대한 함수라서 매 판 똑같이 움직인다 */
  private butterflyPos(i: number, time: number) {
    const b = this.butterflies[i];
    const p = (this.h - (b.h - 700)) / 1000;
    if (p < 0 || p > 1) return null;
    const x = (b.dir > 0 ? lerp(-30, W + 30, p) : lerp(W + 30, -30, p)) + Math.sin(time * 0.003 + i) * 10;
    const h = b.h + Math.sin(time * 0.005 + i * 1.7) * 25;
    return { x, h };
  }

  private updateButterflies() {
    const time = this.time.now;
    for (let i = 0; i < this.butterflies.length; i++) {
      if (this.butterflyHit.has(i)) continue;
      const pos = this.butterflyPos(i, time);
      if (!pos) continue;
      if (Math.hypot(pos.x - this.x, pos.h - this.h) < BUTTERFLY_HIT_R) {
        this.butterflyHit.add(i);
        this.kick = this.butterflies[i].dir * BUTTERFLY_KICK;
        this.kicks.push({ h: Math.round(this.h), x: Math.round(this.x) });
        const p = this.wp(pos.h, pos.x);
        this.sparkle.explode(10, p.x, p.y);
        sfxButterfly();
      }
    }
  }

  // ---------- 마지막 구간: 이전 판들이 길을 밝힌다 ----------

  private spawnGuides() {
    this.guidesSpawned = true;
    let runs = this.pastRuns;
    if (runs.length === 0) return;
    if (runs.length > MAX_GUIDES) {
      const step = runs.length / MAX_GUIDES;
      runs = Array.from({ length: MAX_GUIDES }, (_, k) => this.pastRuns[Math.floor(k * step)]);
    }
    // 오래된 판부터, 아래에서 차례로 올라와 앞길에 자리를 잡는다
    const from = this.h + 260;
    const to = this.cave.height - 60;
    const n = runs.length;
    this.totalGuides = n;
    runs.forEach((run, k) => {
      const th = from + ((k + 0.5) / n) * (to - from);
      const cx = centerAt(this.cave, th);
      const side = k % 2 === 0 ? -1 : 1;
      const sx = run.xs[run.xs.length - 1] ?? W / 2;
      const sh = this.h - 360 - (k % 5) * 30;
      const sp = this.wp(sh, sx);
      const img = this.add
        .image(sp.x, sp.y, 'glow')
        .setDepth(11)
        .setTint(COLOR_GHOST)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.45)
        .setAlpha(0);
      this.worldObj(img);
      this.guides.push({
        img,
        state: 'fly',
        x: sx,
        h: sh,
        sx,
        sh,
        tx: cx + side * (12 + (k % 3) * 8),
        th,
        t: -k * 0.07,
        dur: 1.4 + (k % 4) * 0.15,
        phase: k * 1.3,
      });
    });
  }

  private updateGuides(dt: number) {
    for (let i = this.guides.length - 1; i >= 0; i--) {
      const g = this.guides[i];
      g.t += dt;
      if (g.state === 'fly') {
        if (g.t <= 0) continue;
        const p = Math.min(1, g.t / g.dur);
        const e = easeOutCubic(p);
        // 목표 지점은 계속 위로 멀어지므로 플레이어 기준으로 따라잡는다
        g.x = lerp(g.sx, g.tx, e) + Math.sin(p * Math.PI) * 40 * Math.sin(g.phase);
        g.h = lerp(g.sh, g.th, e);
        g.img.setAlpha(Math.min(1, p * 3));
        if (p >= 1) g.state = 'wait';
      } else if (g.state === 'wait') {
        g.x = g.tx + Math.sin(this.time.now * 0.002 + g.phase) * 4;
        if (this.h > g.th - 30) {
          g.state = 'merge';
          g.img.setTint(COLOR_PLAYER);
        }
      } else {
        // 지나가는 나에게 빛을 건네고 사라진다
        const k = 1 - Math.exp(-7 * dt);
        g.x = lerp(g.x, this.x, k);
        g.h = lerp(g.h, this.h, k) + 0;
        if (Math.hypot(g.x - this.x, g.h - this.h) < 10) {
          const pp = this.wp(this.h, this.x);
          this.sparkle.explode(6, pp.x, pp.y);
          this.boost = Math.min(0.6, this.boost + 0.18);
          sfxAbsorb(this.absorbed++);
          g.img.destroy();
          this.guides.splice(i, 1);
          continue;
        }
      }
      const gp = this.wp(g.h, g.x);
      g.img.setPosition(gp.x, gp.y);
    }
  }

  /** 마지막 구간에 들어서면 음악이 먹먹해지고, 이전 판들의 빛을 받을 때마다 조금씩 다시 열린다 */
  private updateMuffle() {
    if (this.state === 'dead') return;
    const closing = Phaser.Math.Clamp((this.h - this.finalStart) / FINAL_FADE, 0, 1);
    const opened = this.totalGuides > 0 ? this.absorbed / this.totalGuides : 0;
    setMuffle(closing * (1 - opened));
  }

  // ---------- 끝 ----------

  private finishRun(reachedTop: boolean) {
    saveRun({ xs: this.xs, endH: Math.round(this.h), reachedTop, kicks: this.kicks });
  }

  private die(crashed: boolean) {
    this.state = 'dead';
    this.finishRun(false);
    duckMusic();
    this.player.setVisible(false);
    if (crashed) {
      const p = this.wp(this.h, this.x);
      this.burst.explode(36, p.x, p.y);
      this.cameras.main.shake(180, 0.008);
      sfxCrash();
    } else {
      const p = this.wp(this.h, this.x);
      this.burst.explode(12, p.x, p.y);
      sfxFizzle();
    }
    this.time.delayedCall(900, () => this.scene.restart());
  }

  private reachTop() {
    this.state = 'top';
    this.finishRun(true);
    // 빛 속으로 올라가며 하얗게 번진다
    this.tweens.add({ targets: this, h: this.h + 500, duration: 2200, ease: 'Sine.easeIn' });
    this.tweens.add({ targets: this, boost: 2.5, duration: 2200, ease: 'Sine.easeIn' });
    this.cameras.main.fadeOut(2200, 226, 234, 246);
    this.uiCam.fadeOut(2200, 226, 234, 246);
    sfxAscend();
    stopMusic(2.2);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start('Reveal');
    });
  }

  // ---------- 그리기 ----------

  /** 화면은 위로만 스크롤한다. 통로 다발의 가운데를 화면 가운데에 두고 플레이어는 아래쪽에 고정. */
  private syncCamera() {
    this.camCenter = this.wp(this.h + CAM_AHEAD, W / 2);
    this.cameras.main.centerOn(this.camCenter.x, this.camCenter.y);
  }

  /** 내 빛의 반경 배율. 마지막 구간에 들어서면 급격히 좁아진다. */
  private visionScale() {
    const base = lerp(2.0, 3.6, this.energy / ENERGY_MAX);
    const f = Phaser.Math.Clamp((this.h - this.finalStart) / FINAL_FADE, 0, 1);
    // 어둡지만 바로 앞 길은 보이게. 도와줄 이전 판이 적을수록 덜 어둡게.
    const helpers = Math.min(1, this.pastRuns.length / 8);
    const finalVision = lerp(2.3, 1.6, helpers);
    return lerp(base, finalVision, f) + this.boost * 1.6;
  }

  private syncVisuals(time: number) {
    const pw = this.wp(this.h, this.x);
    this.player.setPosition(pw.x, pw.y).setScale(0.55 + Math.sin(time * 0.008) * 0.04 + this.boost * 0.4);

    // 어둠
    const erase = Phaser.BlendModes.ERASE;
    this.dark.clear().fill(0x000000, DARK_ALPHA);
    if (this.state !== 'dead') {
      const sp = this.toScreen(pw);
      this.dark.stamp('hole', undefined, sp.x, sp.y, { scale: this.visionScale(), blendMode: erase });
    }
    for (const g of this.guides) {
      if (g.img.alpha <= 0) continue;
      const s = (1.9 + Math.sin(time * 0.003 + g.phase) * 0.12) * g.img.alpha;
      const sp = this.toScreen(this.wp(g.h, g.x));
      this.dark.stamp('hole', undefined, sp.x, sp.y, { scale: s, blendMode: erase });
    }
    this.dark.render();

    const idx = Math.floor(this.h / STEP);

    // 내 궤적
    this.trailGfx.clear();
    this.drawTrail(this.trailGfx, this.xs, idx, 30, COLOR_PLAYER, 0.5);

    // 이전 판들의 고스트
    this.ghostGfx.clear();
    for (const g of this.ghosts) {
      const endIdx = Math.floor(g.endH / STEP);
      if (idx <= endIdx) {
        this.drawTrail(this.ghostGfx, g.xs, idx, GHOST_TRAIL, COLOR_GHOST, 0.22);
        const gp = this.wp(this.h, g.xs[Math.min(idx, g.xs.length - 1)]);
        this.ghostGfx.fillStyle(COLOR_GHOST, 0.12).fillCircle(gp.x, gp.y, 10);
        this.ghostGfx.fillStyle(COLOR_GHOST, 0.45).fillCircle(gp.x, gp.y, 3.5);
      } else if (this.h - g.endH < 160) {
        // 이 높이에서 꺼진 고스트는 잠깐 잔상만 남는다
        const a = 1 - (this.h - g.endH) / 160;
        const gp = this.wp(g.endH, g.xs[g.xs.length - 1]);
        this.ghostGfx.lineStyle(1.5, COLOR_GHOST, 0.4 * a).strokeCircle(gp.x, gp.y, 6 + (1 - a) * 14);
      }
    }

    // 나비
    this.butterflyGfx.clear();
    for (let i = 0; i < this.butterflies.length; i++) {
      const pos = this.butterflyPos(i, time);
      if (!pos) continue;
      const bp = this.wp(pos.h, pos.x);
      this.drawButterfly(bp.x, bp.y, time + i * 300, this.butterflyHit.has(i));
    }

    // 화면 근처만 그린다
    const lo = this.h - VIEW_BELOW;
    const hi = this.h + VIEW_ABOVE;
    for (const ch of this.caveChunks) {
      const vis = ch.h1 > lo && ch.h0 < hi;
      for (const o of ch.objs) if (o.visible !== vis) o.setVisible(vis);
    }
    const s = 0.85 + Math.sin(time * 0.006) * 0.15;
    const shards = this.cave.shards;
    for (let i = 0; i < this.shardImgs.length; i++) {
      const vis = !this.shardTaken[i] && shards[i].h > lo && shards[i].h < hi;
      const img = this.shardImgs[i];
      if (img.visible !== vis) img.setVisible(vis);
      if (vis) img.setScale(s);
    }

    // 좌우 버튼 눌림 표시
    const held = [...this.buttonHeld.values()];
    this.btnLeft.setAlpha(held.includes(-1) ? 1 : 0.6);
    this.btnRight.setAlpha(held.includes(1) ? 1 : 0.6);

    // HUD
    // 텍스트는 다시 그리는 비용이 커서 숫자가 바뀔 때만 갱신
    const meters = Math.floor(Math.min(this.h, this.cave.height) / 10);
    if (meters !== this.lastHeightLabel) {
      this.lastHeightLabel = meters;
      this.heightText.setText(`${meters}m`);
    }
    const e = this.energy / ENERGY_MAX;
    this.energyBar.scaleX = Math.max(0.001, e);
    this.energyBar.fillColor = e < 0.25 ? 0xff9a7a : COLOR_PLAYER;
  }

  private drawTrail(g: Phaser.GameObjects.Graphics, xs: number[], idx: number, len: number, color: number, alpha: number) {
    const end = Math.min(idx, xs.length - 1);
    const start = Math.max(0, end - len);
    for (let k = start; k < end; k++) {
      const a = alpha * ((k - start) / len);
      const p = this.wp(k * STEP, xs[k]);
      const q = this.wp((k + 1) * STEP, xs[k + 1]);
      g.lineStyle(2, color, a).lineBetween(p.x, p.y, q.x, q.y);
    }
  }

  private drawButterfly(x: number, y: number, t: number, touched: boolean) {
    const flap = Math.abs(Math.sin(t * 0.02));
    const g = this.butterflyGfx;
    const color = touched ? 0xffc6e8 : 0xf4b6ff;
    const alpha = touched ? 0.35 : 0.9;
    g.fillStyle(color, alpha);
    g.fillEllipse(x - 5 * flap, y - 2, 10 * flap + 1, 12);
    g.fillEllipse(x + 5 * flap, y - 2, 10 * flap + 1, 12);
    g.fillEllipse(x - 4 * flap, y + 5, 7 * flap + 1, 7);
    g.fillEllipse(x + 4 * flap, y + 5, 7 * flap + 1, 7);
    g.fillStyle(0xffffff, alpha).fillRect(x - 0.75, y - 5, 1.5, 12);
  }
}
