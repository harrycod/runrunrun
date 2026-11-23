import * as Phaser from 'phaser';
import { H_SCREEN, W } from '../config';
import { playMusic, stopMusic } from '../audio/music';
import { sfxBloom, sfxSeed, unlockAudio } from '../audio/sfx';
import { type Branch, buildTree, type Tree, treeBounds } from '../reveal/tree';
import { clearRuns, loadRuns, newLife } from '../runs/runStore';
import { COLOR_GHOST, COLOR_PLAYER } from './RunScene';

const GROW_MS = 7000;
const GROUND_Y = H_SCREEN - 110;
const TRUNK_PX = 500;
// 차갑고 조용한 새벽 직전. 따뜻한 색은 줄기 끝의 '내 빛' 하나만 남긴다.
const COLOR_BARK = 0xc3ccd9;
/** 밑동은 짙게, 가지 끝으로 갈수록 밝게 */
const COLOR_BARK_BASE = 0x6f7c93;
const COLOR_BARK_TIP = 0xe4eaf4;
/** 가지를 따라 맺히는 빛망울 색 */
const LEAF_TINTS = [0xdde8ff, 0xd6d3ee, 0xbfd6ff, 0xeef2ff];
/** 빛망울 최대 개수 (모바일 성능) */
const MAX_LEAVES = 360;
const COLOR_FLOWER = 0xd6d3ee;
const COLOR_BLOOM = 0xdde8ff;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpColor = (a: number, b: number, t: number) => {
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return (r << 16) | (g << 8) | bl;
};
/** 장면마다 같은 모양이 나오도록 쓰는 간단한 난수 */
function seeded(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 반전 엔딩.
 * 지금까지 했던 모든 판의 궤적이 한 그루의 나무로 자라난다.
 * 마지막 판(지금의 나)이 줄기, 끝난 판들이 가지, 나비에 밀린 자리는 꽃.
 */
export class RevealScene extends Phaser.Scene {
  private tree!: Tree;
  private sx = 1;
  private sy = 1;
  private ox = 0;
  private oy = 0;
  private elapsed = 0;
  /** 밤 배경 위에 새벽 배경을 겹쳐 두고 투명도만 바꾼다 */
  private dawn!: Phaser.GameObjects.Graphics;
  /** 이미 자란 나무는 텍스처에 한 번만 그려 둔다 (매 프레임 다시 그리지 않음) */
  private treeRT!: Phaser.GameObjects.RenderTexture;
  private staticGlowRT!: Phaser.GameObjects.RenderTexture;
  private tmpTree!: Phaser.GameObjects.Graphics;
  private tmpGlow!: Phaser.GameObjects.Graphics;
  /** 매 프레임 바뀌는 빛만 그린다 (자라는 가지 끝, 꽃봉오리 맥동) */
  private glowGfx!: Phaser.GameObjects.Graphics;
  private drawnUpTo = new Map<Branch, number>();
  private twigDrawn = new Map<Phaser.Types.Math.Vector2Like[], number>();
  private flowersDrawn = new Set<object>();
  private leaves = 0;
  private leafStamped = false;
  private rng: () => number = Math.random;
  private tipLight!: Phaser.GameObjects.Image;
  private bloomed = new Set<Branch>();
  private bloomEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private moteEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private done = false;

  constructor() {
    super('Reveal');
  }

  create() {
    this.elapsed = 0;
    this.done = false;
    this.bloomed = new Set();
    this.drawnUpTo = new Map();
    this.twigDrawn = new Map();
    this.flowersDrawn = new Set();
    this.leaves = 0;

    const runs = loadRuns();
    this.tree = buildTree(runs, TRUNK_PX);
    this.rng = seeded(runs.length * 7919 + this.tree.maxH);

    // 화면에 맞게 배치
    const b = treeBounds(this.tree);
    const fitH = (GROUND_Y - 90) / Math.max(1, b.maxY - b.minY);
    // 높이는 그대로 두고, 넓으면 가로만 좁힌다
    this.sy = Math.min(1, fitH);
    // 줄기 밑동을 항상 화면 가운데에 두고, 더 멀리 뻗은 쪽에 맞춰 가로를 줄인다
    const baseX = this.tree.trunk.pts[0].x;
    const reach = Math.max(baseX - b.minX, b.maxX - baseX, 1);
    this.sx = Math.min(this.sy, (W / 2 - 24) / reach);
    this.ox = W / 2 - baseX * this.sx;
    this.oy = GROUND_Y;

    // 밤 → 새벽: 두 그라데이션을 한 번씩만 그리고 위쪽의 투명도만 바꾼다
    const night = this.add.graphics();
    night.fillGradientStyle(0x05060a, 0x05060a, 0x0a0c16, 0x0a0c16, 1).fillRect(0, 0, W, H_SCREEN);
    this.dawn = this.add.graphics().setAlpha(0);
    this.dawn.fillGradientStyle(0x101726, 0x101726, 0x2b3a55, 0x2b3a55, 1).fillRect(0, 0, W, H_SCREEN);

    // 땅
    const ground = this.add.graphics();
    ground.fillStyle(0x06080d, 1);
    ground.fillEllipse(W / 2, GROUND_Y + 150, W * 1.6, 320);

    this.staticGlowRT = this.add.renderTexture(0, 0, W, H_SCREEN).setOrigin(0, 0).setBlendMode(Phaser.BlendModes.ADD);
    this.glowGfx = this.add.graphics().setBlendMode(Phaser.BlendModes.ADD);
    this.treeRT = this.add.renderTexture(0, 0, W, H_SCREEN).setOrigin(0, 0);
    this.tmpTree = this.make.graphics({}, false);
    this.tmpGlow = this.make.graphics({}, false);
    this.drawRootsAndGround();

    this.tipLight = this.add
      .image(this.ox, this.oy, 'glow')
      .setTint(COLOR_PLAYER)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.7);

    this.bloomEmitter = this.add.particles(0, 0, 'glow', {
      speed: { min: 10, max: 60 },
      lifespan: 900,
      scale: { start: 0.3, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: COLOR_GHOST,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    this.moteEmitter = this.add.particles(0, 0, 'glow', {
      speedY: { min: -40, max: -15 },
      speedX: { min: -12, max: 12 },
      lifespan: 4000,
      scale: { start: 0.18, end: 0 },
      alpha: { start: 0.45, end: 0 },
      tint: [COLOR_BLOOM, COLOR_GHOST, COLOR_FLOWER],
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });

    this.cameras.main.fadeIn(1800, 226, 234, 246);
    void playMusic('tree', 2.5);
  }

  private toScreen(x: number, y: number) {
    return { x: this.ox + x * this.sx, y: this.oy + y * this.sy };
  }

  update(_time: number, delta: number) {
    this.elapsed += delta;
    const t = Math.min(1, this.elapsed / GROW_MS);
    const growH = t * this.tree.maxH * 1.02;

    this.dawn.setAlpha(Math.min(1, this.elapsed / (GROW_MS + 2500)));
    this.drawTree(growH);

    if (t >= 1 && !this.done) this.finish();
  }

  private drawTree(growH: number) {
    const g = this.tmpTree;
    const sg = this.tmpGlow;
    const glow = this.glowGfx;
    g.clear();
    sg.clear();
    glow.clear();
    let bakedTree = false;
    let bakedGlow = false;

    for (const b of this.tree.branches) {
      if (b.pts.length === 0 || b.pts[0].h > growH) continue;
      const n = b.pts.length;
      let lastVisible = 0;
      while (lastVisible + 1 < n && b.pts[lastVisible + 1].h <= growH) lastVisible++;

      // 새로 자란 구간만 텍스처에 덧그린다
      const from = (this.drawnUpTo.get(b) ?? 0) + 1;
      for (let j = from; j <= lastVisible; j++) {
        this.drawSegment(g, b, j);
        this.maybeLeaf(b, j);
        bakedTree = true;
      }
      if (lastVisible >= from) this.drawnUpTo.set(b, lastVisible);

      const tip = this.toScreen(b.pts[lastVisible].x, b.pts[lastVisible].y);
      const finished = lastVisible === n - 1;

      if (b.isTrunk) {
        // 줄기 끝은 내가 조종하던 그 빛
        this.tipLight.setPosition(tip.x, tip.y);
      } else if (!finished) {
        // 자라는 중인 가지 끝은 그 판의 고스트 빛
        glow.fillStyle(COLOR_GHOST, 0.25).fillCircle(tip.x, tip.y, 6);
        glow.fillStyle(COLOR_GHOST, 0.8).fillCircle(tip.x, tip.y, 2);
      } else {
        // 끝난 가지는 꽃봉오리처럼 빛난다
        if (!this.bloomed.has(b)) {
          this.bloomed.add(b);
          this.bloomEmitter.explode(6, tip.x, tip.y);
          sfxBloom(b.run.endH / this.tree.maxH);
          sg.fillStyle(COLOR_BLOOM, 0.7).fillCircle(tip.x, tip.y, 2);
          bakedGlow = true;
        }
        const pulse = 0.75 + Math.sin(this.elapsed * 0.003 + b.d) * 0.25;
        glow.fillStyle(COLOR_BLOOM, 0.1 * pulse).fillCircle(tip.x, tip.y, 8);
      }

      for (const tw of b.twigs) {
        if (tw[0].h > growH) continue;
        const done = this.twigDrawn.get(tw) ?? 0;
        let k = done + 1;
        for (; k < tw.length && tw[k].h <= growH; k++) {
          const p = this.toScreen(tw[k - 1].x, tw[k - 1].y);
          const q = this.toScreen(tw[k].x, tw[k].y);
          g.lineStyle(Math.max(0.8, 1.8 - k * 0.4), lerpColor(COLOR_BARK, COLOR_BARK_TIP, k / 3), 0.75).lineBetween(p.x, p.y, q.x, q.y);
          if (k === tw.length - 1) {
            this.stampLeaf(q.x, q.y, 0.09 + this.rng() * 0.06, 0.5);
            bakedGlow = true;
          }
          bakedTree = true;
        }
        if (k - 1 > done) this.twigDrawn.set(tw, k - 1);
      }

      for (const f of b.flowers) {
        if (f.h > growH || this.flowersDrawn.has(f)) continue;
        this.flowersDrawn.add(f);
        const sp = this.toScreen(f.x, f.y);
        this.drawFlower(sg, sp.x, sp.y);
        bakedGlow = true;
      }
    }

    if (bakedTree) {
      this.treeRT.draw(g, 0, 0);
      this.treeRT.render();
    }
    if (bakedGlow) this.staticGlowRT.draw(sg, 0, 0);
    if (bakedGlow || this.leafStamped) {
      this.staticGlowRT.render();
      this.leafStamped = false;
    }
  }

  /** 가지 굵기: 밑에서 끝으로 매끄럽게 가늘어진다 */
  private widthAt(b: Branch, j: number) {
    const n = b.pts.length;
    const t = j / Math.max(1, n - 1);
    const taper = b.isTrunk ? lerp(1, 0.3, Math.pow(t, 0.8)) : lerp(1, 0.18, Math.pow(t, 0.7));
    // 줄기 밑동은 살짝 넓게 퍼진다
    const flare = b.isTrunk ? 1 + 0.9 * Math.pow(Math.max(0, 1 - t * 8), 2) : 1;
    return Math.max(0.9, b.baseWidth * taper * flare * this.sy + 0.5);
  }

  /** 한 마디를 사다리꼴로 채워서 끊김 없이 가늘어지는 가지를 그린다 */
  private drawSegment(g: Phaser.GameObjects.Graphics, b: Branch, j: number) {
    const p = this.toScreen(b.pts[j - 1].x, b.pts[j - 1].y);
    const q = this.toScreen(b.pts[j].x, b.pts[j].y);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const w0 = this.widthAt(b, j - 1) / 2;
    const w1 = this.widthAt(b, j) / 2;
    // 밑동(낮은 곳)은 짙고 위로·끝으로 갈수록 밝다
    const along = j / Math.max(1, b.pts.length - 1);
    const height = Math.min(1, -b.pts[j].y / (TRUNK_PX * 0.9));
    const tone = Math.min(1, (b.isTrunk ? 0.15 : 0.35) + height * 0.45 + along * 0.35);
    const color = lerpColor(COLOR_BARK_BASE, COLOR_BARK_TIP, tone);
    g.fillStyle(color, 1);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(p.x + nx * w0, p.y + ny * w0),
        new Phaser.Math.Vector2(q.x + nx * w1, q.y + ny * w1),
        new Phaser.Math.Vector2(q.x - nx * w1, q.y - ny * w1),
        new Phaser.Math.Vector2(p.x - nx * w0, p.y - ny * w0),
      ],
      true,
    );
    g.fillCircle(q.x, q.y, w1);
  }

  /** 바깥쪽 가지를 따라 잎처럼 보이는 빛망울을 흩뿌린다 (한 번만 굽는다) */
  private maybeLeaf(b: Branch, j: number) {
    if (this.leaves >= MAX_LEAVES) return;
    const along = j / Math.max(1, b.pts.length - 1);
    const chance = b.isTrunk ? (along > 0.55 ? 0.18 : 0) : along > 0.35 ? 0.32 + along * 0.3 : 0;
    if (this.rng() > chance) return;
    const q = this.toScreen(b.pts[j].x, b.pts[j].y);
    const spread = 6 + along * 12;
    const count = 1 + Math.floor(this.rng() * 2);
    for (let k = 0; k < count; k++) {
      this.stampLeaf(q.x + (this.rng() - 0.5) * spread * 2, q.y + (this.rng() - 0.7) * spread * 1.6, 0.08 + this.rng() * 0.14, 0.25 + this.rng() * 0.35);
    }
  }

  private stampLeaf(x: number, y: number, scale: number, alpha: number) {
    if (this.leaves >= MAX_LEAVES) return;
    this.leaves++;
    const tint = LEAF_TINTS[Math.floor(this.rng() * LEAF_TINTS.length)];
    this.staticGlowRT.stamp('glow', undefined, x, y, { scale, alpha, tint });
    this.leafStamped = true;
  }

  /** 밑동의 뿌리와 땅의 은은한 빛 (처음에 한 번만) */
  private drawRootsAndGround() {
    const base = this.toScreen(this.tree.trunk.pts[0].x, 0);
    // 땅에 번지는 빛
    this.staticGlowRT.stamp('glow', undefined, base.x, base.y + 6, { scaleX: 5.5, scaleY: 1.1, alpha: 0.16, tint: 0x9cb4e0 });
    const g = this.tmpTree;
    g.clear();
    const trunkW = this.widthAt(this.tree.trunk, 0);
    const roots = 5;
    for (let r = 0; r < roots; r++) {
      const side = r % 2 === 0 ? -1 : 1;
      const spread = (0.35 + (r / roots) * 0.9) * side;
      const len = 26 + this.rng() * 30;
      let x = base.x + side * trunkW * 0.25;
      let y = base.y - 2;
      let w = trunkW * (0.32 - r * 0.03);
      for (let k = 0; k < 6; k++) {
        const ang = spread * (1.1 + k * 0.08);
        const nx2 = x + Math.sin(ang) * (len / 6) * 1.6;
        const ny2 = y + Math.abs(Math.cos(ang)) * (len / 6) * 0.35;
        g.lineStyle(Math.max(0.8, w), COLOR_BARK_BASE, 1).lineBetween(x, y, nx2, ny2);
        x = nx2;
        y = ny2;
        w *= 0.72;
      }
    }
    this.treeRT.draw(g, 0, 0);
    this.treeRT.render();
    g.clear();
    this.staticGlowRT.render();
  }

  private drawFlower(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    g.fillStyle(COLOR_FLOWER, 0.6);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.fillCircle(x + Math.cos(a) * 3.2, y + Math.sin(a) * 3.2, 2.4);
    }
    g.fillStyle(0xeef2ff, 0.9).fillCircle(x, y, 1.4);
  }

  private finish() {
    this.done = true;

    // 모든 가지 끝에서 빛 가루가 피어오른다
    const tips = this.tree.branches.map((b) => {
      const p = b.pts[b.pts.length - 1];
      return this.toScreen(p.x, p.y);
    });

    // 각 가지 끝의 빛이 줄기 꼭대기로 올라가 수관(꽃 무리)이 된다.
    // 마지막 어둠에서 이전 판들이 나에게 빛을 건넸던 것처럼.
    const crown = { x: this.tipLight.x, y: this.tipLight.y + 18 };
    const blossoms: { x: number; y: number }[] = [];
    const branches = this.tree.branches.filter((b) => !b.isTrunk);
    branches.forEach((b, i) => {
      const p = b.pts[b.pts.length - 1];
      const from = this.toScreen(p.x, p.y);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      const to = { x: crown.x + Math.cos(a) * 105 * r, y: crown.y + Math.sin(a) * 62 * r - 18 };
      blossoms.push(to);
      const light = this.add
        .image(from.x, from.y, 'glow')
        .setTint(COLOR_GHOST)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.22);
      this.tweens.add({
        targets: light,
        x: to.x,
        y: to.y,
        delay: 400 + i * 70,
        duration: 1700,
        ease: 'Sine.easeInOut',
        onComplete: () => {
          light.setTint(COLOR_BLOOM);
          this.bloomEmitter.explode(3, to.x, to.y);
          sfxBloom(0.5 + Math.random() * 0.5, 0.6);
          this.tweens.add({
            targets: light,
            scale: { from: 0.3, to: 0.2 },
            duration: 1400 + Math.random() * 800,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
          });
        },
      });
    });
    const crownDone = 400 + branches.length * 70 + 1700;

    // 수관과 가지 끝에서 빛 가루가 피어오른다
    const sources = tips.concat(blossoms);
    this.time.addEvent({
      delay: 110,
      repeat: -1,
      callback: () => {
        const p = sources[Math.floor(Math.random() * sources.length)];
        this.moteEmitter.emitParticleAt(p.x, p.y, 1);
      },
    });

    // 줄기 끝의 빛 하나가 씨앗처럼 바람을 타고 떠난다
    this.time.delayedCall(crownDone + 1200, () => {
      const seed = this.add
        .image(this.tipLight.x, this.tipLight.y, 'glow')
        .setTint(COLOR_PLAYER)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.35);
      sfxSeed();
      this.tweens.add({
        targets: seed,
        x: W + 40,
        duration: 5200,
        ease: 'Sine.easeIn',
      });
      this.tweens.add({
        targets: seed,
        y: { from: seed.y, to: seed.y - 220 },
        duration: 5200,
        ease: 'Sine.easeInOut',
      });
    });

    // 다시 시작: 기록을 비우고 새 삶을 시작한다
    this.time.delayedCall(crownDone + 5200, () => {
      const dot = this.add.circle(W / 2, H_SCREEN - 40, 3, COLOR_PLAYER, 1).setAlpha(0);
      this.tweens.add({ targets: dot, alpha: 0.8, duration: 900, yoyo: true, repeat: -1 });
      this.input.once('pointerdown', () => this.restart());
      this.input.keyboard?.once('keydown', () => this.restart());
    });
  }

  private restart() {
    unlockAudio();
    stopMusic(1.2);
    this.cameras.main.fadeOut(1200, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      clearRuns();
      newLife();
      this.scene.start('Run');
    });
  }
}
