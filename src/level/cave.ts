import { CAVE_HEIGHT, FINAL_LEN, STEP, W } from '../config';
import { getLifeSeed } from '../runs/runStore';

export type CorridorKind = 'main' | 'wide' | 'narrow';

/** 높이 h0~h1 구간의 통로. STEP 간격으로 중심/폭을 샘플링해 둔다. */
export interface Corridor {
  h0: number;
  h1: number;
  cx: Float32Array;
  w: Float32Array;
  kind: CorridorKind;
}

export interface Shard {
  x: number;
  h: number;
}

/** 갈림길 하나. corridors는 갈라져 나온 두 통로의 인덱스. */
export interface Fork {
  h0: number;
  corridors: [number, number];
}

/**
 * 터널 다발이 지나가는 2D 경로. 통로 좌표 (s = 진행 거리, u = 다발 안의 가로 위치 0~W)를
 * 월드 좌표로 감아 올린다. 경로는 휘고, 크게 돌고, U턴해서 뒤로 가기도 한다.
 */
export interface Path {
  x: Float32Array;
  y: Float32Array;
  /** 진행 방향 (0 = 화면 위쪽, 시계 방향 +) */
  th: Float32Array;
}

export interface Cave {
  seed: number;
  height: number;
  corridors: Corridor[];
  shards: Shard[];
  forks: Fork[];
  path: Path;
}

/** 판마다 막히는 통로: 통로 인덱스 → 막힌 높이 */
export type Blocked = Map<number, number>;

const EDGE = 14;
/** 나란한 통로 사이 벽의 최소 두께 */
const GAP = 36;
/** 흔들림을 더한 뒤에도 지켜야 하는 최소 벽 두께 */
const MIN_WALL = 22;
/** 갈라진 통로가 완전히 벌어지기까지 걸리는 높이 */
const SPLIT_RAMP = 260;
/** 갈림길에서 낙석이 놓이는 높이 (벌어진 뒤라 한쪽만 막힌다) */
const BLOCK_AFTER = 300;
const MAX_LANES = 3;
const MIN_LANES = 2;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 생성 중인 통로 하나 (시뮬레이션 상태) */
interface Lane {
  index: number;
  kind: CorridorKind;
  h0: number;
  cx: number[];
  w: number[];
  /** 흔들림을 뺀 기준 중심 */
  c: number;
  /** 기준 중심의 가로 속도 (방향을 바꿀 때 꺾이지 않고 휘어지도록) */
  v: number;
  wCur: number;
  tc: number;
  tw: number;
  age: number;
  nextRetarget: number;
  /** 흔들림 전체 폭 (큰 굽이 70% + 잔 굽이 30%) */
  wiggleAmp: number;
  /** 빽빽할 때 흔들림을 줄이는 배율 (서서히 변한다) */
  ampK: number;
  /** 겹침 보정량. 한 번에 옮기지 않고 서서히 따라가서 벽이 튀지 않게 한다. */
  adj: number;
  wAdj: number;
  wiggleFreq: number;
  wigglePh: number;
  wiggle2Freq: number;
  wiggle2Ph: number;
  mergeWith: Lane | null;
  /** 이번 스텝에 기록된 실제 중심 */
  out: number;
}

function baseWidth(kind: CorridorKind, p: number) {
  if (kind === 'narrow') return lerp(54, 42, p);
  if (kind === 'wide') return lerp(110, 84, p);
  return lerp(132, 88, p);
}

/**
 * 동굴 = 여러 갈래의 통로가 나란히 구불거리며 올라가는 구조.
 * 통로는 갈라지기도(split) 합쳐지기도(merge) 한다. 한 번 다른 갈래를 고르면 한참 동안 다른 길을 간다.
 */
export function generateCave(seed: number): Cave {
  const rng = mulberry32(seed);
  const corridors: Corridor[] = [];
  const shards: Shard[] = [];
  const forks: Fork[] = [];
  const top = CAVE_HEIGHT + 1200;
  const mergeAllFrom = CAVE_HEIGHT - FINAL_LEN - 1800;

  const newLane = (h: number, c: number, w: number, kind: CorridorKind): Lane => {
    const index = corridors.length;
    corridors.push(null as unknown as Corridor); // 끝날 때 채운다
    return {
      index,
      kind,
      h0: h,
      cx: [],
      w: [],
      c,
      v: 0,
      wCur: w,
      tc: c,
      tw: w,
      age: 0,
      nextRetarget: h + 200,
      wiggleAmp: 56 + rng() * 34,
      ampK: 1,
      adj: 0,
      wAdj: 0,
      wiggleFreq: 0.006 + rng() * 0.005,
      wigglePh: rng() * Math.PI * 2,
      wiggle2Freq: 0.013 + rng() * 0.008,
      wiggle2Ph: rng() * Math.PI * 2,
      mergeWith: null,
      out: c,
    };
  };

  const finish = (lane: Lane) => {
    const cor: Corridor = {
      h0: lane.h0,
      h1: lane.h0 + (lane.cx.length - 1) * STEP,
      cx: Float32Array.from(lane.cx),
      w: Float32Array.from(lane.w),
      kind: lane.kind,
    };
    corridors[lane.index] = cor;
    const spacing = lane.kind === 'narrow' ? 110 : lane.kind === 'wide' ? 420 : 240;
    for (let h = cor.h0 + spacing / 2; h < cor.h1; h += spacing) {
      const i = Math.round((h - cor.h0) / STEP);
      const spread = Math.max(0, cor.w[i] / 2 - 16);
      shards.push({ x: cor.cx[i] + (rng() - 0.5) * spread, h: cor.h0 + i * STEP });
    }
  };

  let lanes: Lane[] = [newLane(0, W / 2, 200, 'main')];
  let nextEvent = 450;
  /** 목표 통로 수: 일정 구간마다 MIN_LANES~MAX_LANES 중 랜덤으로 다시 뽑는다 */
  let wantLanes = 2;
  let nextWant = 900;

  for (let h = 0; h <= top; h += STEP) {
    const p = Math.min(1, h / CAVE_HEIGHT);
    const summit = h > CAVE_HEIGHT - 300;
    // 마지막 어둠 구간: 굽이를 줄여 완만하게 (들어서기 600 전부터 서서히)
    const finalK = smooth(clamp((h - (CAVE_HEIGHT - FINAL_LEN - 600)) / 600, 0, 1));

    // --- 갈라지기 / 합쳐지기 ---
    if (h >= nextEvent) {
      nextEvent = h + 260 + rng() * 380;
      if (h >= nextWant) {
        // 대개는 개수를 바꿔서 자주 갈라지고 합쳐지게 한다 (= 갈림길이 많아진다)
        if (rng() < 0.75) wantLanes = wantLanes >= MAX_LANES ? MAX_LANES - 1 : wantLanes + 1;
        wantLanes = Math.max(MIN_LANES, Math.min(MAX_LANES, wantLanes));
        nextWant = h + 450 + rng() * 500;
      }
      const free = lanes.filter((l) => !l.mergeWith);
      // 합쳐지는 중인 쌍은 하나로 센다
      const count = free.length + (lanes.length - free.length) / 2;
      if (h > mergeAllFrom) {
        // 마지막 구간 전에 모두 한 길로 모인다
        if (free.length >= 2) {
          const sorted = [...free].sort((a, b) => a.c - b.c);
          const k = Math.floor(rng() * (sorted.length - 1));
          sorted[k].mergeWith = sorted[k + 1];
          sorted[k + 1].mergeWith = sorted[k];
        }
      } else if (count < wantLanes && lanes.length < MAX_LANES) {
        // 한 통로만 남았으면 바로 다시 갈라진다
        const cands = free.filter((l) => l.age > (count < MIN_LANES ? 120 : 360));
        if (cands.length > 0) {
          const parent = cands[Math.floor(rng() * cands.length)];
          const narrowFirst = rng() < 0.5;
          const kinds: CorridorKind[] = narrowFirst ? ['narrow', 'wide'] : ['wide', 'narrow'];
          // 한쪽이 넓은 '안전한 길'이 아니라 둘 다 평범한 길일 때도 있다
          if (rng() < 0.3) kinds[narrowFirst ? 0 : 1] = 'main';
          const children = kinds.map((kind) => {
            const child = newLane(h, parent.out, parent.wCur, kind);
            child.v = parent.v;
            child.ampK = parent.ampK;
            // 굽이 폭을 이어받아야 가장자리 제한이 첫 칸에서 바뀌지 않는다
            child.wiggleAmp = parent.wiggleAmp;
            // 흔들림 리듬도 이어받아 갓 갈라진 두 통로가 서로 교차하지 않게
            child.wiggleFreq = parent.wiggleFreq;
            child.wigglePh = parent.wigglePh;
            child.wiggle2Freq = parent.wiggle2Freq;
            child.wiggle2Ph = parent.wiggle2Ph;
            child.tw = baseWidth(kind, p);
            return child;
          });
          children[0].tc = parent.out - 130;
          children[1].tc = parent.out + 130;
          parent.cx.push(parent.out);
          parent.w.push(parent.wCur);
          finish(parent);
          forks.push({ h0: h, corridors: [children[0].index, children[1].index] });
          lanes = lanes.filter((l) => l !== parent).concat(children);
        }
      } else if (count > wantLanes && free.length >= 2) {
        const sorted = [...free].sort((a, b) => a.c - b.c);
        const k = Math.floor(rng() * (sorted.length - 1));
        if (sorted[k].age > 420 && sorted[k + 1].age > 420) {
          sorted[k].mergeWith = sorted[k + 1];
          sorted[k + 1].mergeWith = sorted[k];
        }
      }
    }

    // --- 목표 갱신 ---
    for (const l of lanes) {
      if (summit) {
        l.tc = W / 2;
        l.tw = 300;
      } else if (l.mergeWith) {
        const mid = (l.c + l.mergeWith.c) / 2;
        l.tc = mid;
        l.tw = Math.max(baseWidth('main', p), (l.tw + l.mergeWith.tw) / 2);
      } else if (h >= l.nextRetarget && l.age > SPLIT_RAMP) {
        l.nextRetarget = h + 140 + rng() * 240;
        // 대개는 반대편으로 크게 쓸고 지나가게 해서 굽이를 크게 만든다
        if (finalK > 0) l.tc = W / 2 + (rng() - 0.5) * lerp(W - 140, 120, finalK);
        else if (rng() < 0.7) l.tc = l.c < W / 2 ? W * 0.62 + rng() * (W * 0.38 - 70) : 70 + rng() * (W * 0.38 - 70);
        else l.tc = 70 + rng() * (W - 140);
        l.tw = baseWidth(l.kind, p) * (0.85 + rng() * 0.3);
      }
    }

    // --- 이동 ---
    // 위치를 직접 밀지 않고 속도에 힘을 더한다. 그래서 피할 때도 꺾이지 않고 휘어 돈다.
    /** 지금 실제로 흔들리는 폭 (새 통로는 0에서 서서히 커진다) */
    const effAmp = (l: Lane) => l.wiggleAmp * l.ampK * smooth(Math.min(1, l.age / SPLIT_RAMP));
    const pairNeed = (a: Lane, b: Lane) => {
      const ramp = smooth(Math.min(1, Math.min(a.age, b.age) / SPLIT_RAMP));
      return ((a.wCur + b.wCur) / 2 + GAP + effAmp(a) + effAmp(b)) * ramp;
    };
    const bounds = (l: Lane) => [l.wCur / 2 + EDGE + effAmp(l) * 0.8, W - l.wCur / 2 - EDGE - effAmp(l) * 0.8];
    const crowdK = lanes.length >= 3 ? 0.6 : 1;
    for (const l of lanes) l.ampK += (crowdK - l.ampK) * 0.012;
    for (const l of lanes) {
      // 임계 감쇠 스프링: 목표가 바뀌어도 속도가 연속이다
      const omega = l.mergeWith ? 0.07 : l.age < SPLIT_RAMP ? 0.06 : 0.065;
      l.v += (l.tc - l.c) * omega * omega - l.v * 2 * omega;
      const [lo, hi] = bounds(l);
      if (l.c < lo + 30) l.v += (lo + 30 - l.c) * 0.004;
      if (l.c > hi - 30) l.v -= (l.c - (hi - 30)) * 0.004;
    }
    lanes.sort((a, b) => a.c - b.c);
    for (let i = 0; i < lanes.length - 1; i++) {
      const a = lanes[i];
      const b = lanes[i + 1];
      if (a.mergeWith === b) continue;
      // 미리, 넉넉하게 피한다. 서로 다가오는 속도도 줄인다.
      const deficit = pairNeed(a, b) + 80 - (b.c - a.c);
      if (deficit > 0) {
        a.v -= deficit * 0.005;
        b.v += deficit * 0.005;
        const closing = a.v - b.v;
        if (closing > 0) {
          a.v -= closing * 0.15;
          b.v += closing * 0.15;
        }
      }
    }
    for (const l of lanes) {
      l.v = clamp(l.v, -6, 6);
      l.c += l.v;
      l.wCur += (l.tw - l.wCur) * 0.02;
    }

    // --- 최후의 안전장치: 그래도 겹치면 위치를 바로잡는다 (속도도 맞춰서 다음 스텝이 튀지 않게) ---
    for (let pass = 0; pass < 1; pass++) {
      lanes.sort((a, b) => a.c - b.c);
      for (let i = 0; i < lanes.length - 1; i++) {
        const a = lanes[i];
        const b = lanes[i + 1];
        if (a.mergeWith === b) continue;
        const gap = b.c - a.c;
        const need = pairNeed(a, b);
        if (gap < need) {
          // 한 스텝에 조금씩만 옮겨서 벽이 꺾이지 않게
          const push = Math.min(2.5, (need - gap) / 2);
          a.c -= push;
          b.c += push;
          const vm = (a.v + b.v) / 2;
          a.v = Math.min(a.v, vm);
          b.v = Math.max(b.v, vm);
        }
      }
      for (const l of lanes) {
        const [lo, hi] = bounds(l);
        if (l.c < lo) {
          l.c = lo;
          l.v = Math.max(0, l.v);
        } else if (l.c > hi) {
          l.c = hi;
          l.v = Math.min(0, l.v);
        }
      }
    }
    // 그래도 공간이 모자라면 폭을 줄인다
    const need = lanes.reduce((s, l) => s + l.wCur + l.wiggleAmp * l.ampK * 1.6, 0) + GAP * (lanes.length - 1) + EDGE * 2;
    if (need > W) for (const l of lanes) l.wCur *= 0.995;

    // --- 기록 ---
    const outW = new Map<Lane, number>();
    const raw = new Map<Lane, number>();
    for (const l of lanes) {
      // 정상에 가까워질수록 흔들림을 서서히 줄인다
      const calm = clamp((CAVE_HEIGHT - 200 - h) / 700, 0, 1) * lerp(1, 0.3, finalK);
      const wig = l.wiggleAmp * l.ampK * smooth(Math.min(1, l.age / SPLIT_RAMP)) * smooth(calm);
      const wave = 0.7 * Math.sin(h * l.wiggleFreq + l.wigglePh) + 0.3 * Math.sin(h * l.wiggle2Freq + l.wiggle2Ph);
      l.out = clamp(l.c + wave * wig, l.wCur / 2 + EDGE, W - l.wCur / 2 - EDGE);
      raw.set(l, l.out);
      outW.set(l, l.wCur);
    }
    // 흔들림까지 더한 실제 위치에서 다시 한 번 벽 두께를 보장한다 (모자라면 이번 스텝만 폭을 줄인다)
    for (let pass = 0; pass < 3; pass++) {
      const sorted = [...lanes].sort((a, b) => a.out - b.out);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (a.mergeWith === b) continue;
        const ramp = smooth(Math.min(1, Math.min(a.age, b.age) / SPLIT_RAMP));
        const need = ((outW.get(a)! + outW.get(b)!) / 2 + MIN_WALL) * ramp;
        const gap = b.out - a.out;
        if (gap >= need) continue;
        const push = (need - gap) / 2;
        a.out = clamp(a.out - push, outW.get(a)! / 2 + EDGE, W - outW.get(a)! / 2 - EDGE);
        b.out = clamp(b.out + push, outW.get(b)! / 2 + EDGE, W - outW.get(b)! / 2 - EDGE);
        const left = need - (b.out - a.out);
        if (left > 0 && pass === 2) {
          outW.set(a, Math.max(36, outW.get(a)! - left));
          outW.set(b, Math.max(36, outW.get(b)! - left));
        }
      }
    }
    for (const l of lanes) {
      const r = raw.get(l)!;
      l.adj += (l.out - r - l.adj) * 0.2;
      l.wAdj += (outW.get(l)! - l.wCur - l.wAdj) * 0.2;
      l.out = r + l.adj;
      l.cx.push(l.out);
      l.w.push(l.wCur + l.wAdj);
      l.age += STEP;
    }

    // --- 합쳐짐 완료 ---
    for (const a of [...lanes]) {
      const b = a.mergeWith;
      if (!b || !lanes.includes(a) || !lanes.includes(b)) continue;
      if (Math.abs(a.out - b.out) < 4 && Math.abs(a.wCur - b.wCur) < 6) {
        finish(a);
        finish(b);
        // 두 통로의 합집합을 그대로 이어받아 폭이 튀지 않게
        const lo = Math.min(a.out - a.wCur / 2, b.out - b.wCur / 2);
        const hi = Math.max(a.out + a.wCur / 2, b.out + b.wCur / 2);
        const merged = newLane(h, (lo + hi) / 2, hi - lo, 'main');
        merged.v = (a.v + b.v) / 2;
        merged.wiggleAmp = Math.min(a.wiggleAmp, b.wiggleAmp);
        merged.ampK = Math.min(a.ampK, b.ampK);
        // 흔들림은 0부터 다시 서서히 커진다 (합쳐지는 지점에서 벽이 턱지지 않게)
        merged.wigglePh = a.wigglePh;
        merged.wiggleFreq = a.wiggleFreq;
        merged.wiggle2Freq = a.wiggle2Freq;
        merged.wiggle2Ph = a.wiggle2Ph;
        // 다음 스텝부터 적용될 가장자리 제한을 첫 위치에도 똑같이 적용해 튀지 않게
        merged.c = clamp(merged.c, merged.wCur / 2 + EDGE, W - merged.wCur / 2 - EDGE);
        merged.out = merged.c;
        merged.cx.push(merged.c);
        merged.w.push(merged.wCur);
        lanes = lanes.filter((l) => l !== a && l !== b).concat(merged);
      }
    }
  }

  for (const l of lanes) finish(l);
  shards.sort((a, b) => a.h - b.h);
  // 화면은 위로만 올라간다 (2D로 휘는 경로는 조작이 직관적이지 않아 쓰지 않음)
  const path = straightPath(CAVE_HEIGHT + 3200);
  return { seed, height: CAVE_HEIGHT, corridors, shards, forks, path };
}

let cached: Cave | null = null;
/** 지금 삶의 동굴 */
export function getCave(): Cave {
  const seed = getLifeSeed();
  if (!cached || cached.seed !== seed) cached = generateCave(seed);
  return cached;
}

/** 이번 판의 낙석: 갈림길마다 일정 확률로 한쪽이 막힌다 (양쪽이 다 막히지는 않는다) */
export function rollBlocked(cave: Cave, chance = 0.45): Blocked {
  const blocked: Blocked = new Map();
  for (const f of cave.forks) {
    if (Math.random() >= chance) continue;
    const ci = f.corridors[Math.random() < 0.5 ? 0 : 1];
    const cor = cave.corridors[ci];
    const bh = f.h0 + BLOCK_AFTER;
    if (bh < cor.h1 - 40) blocked.set(ci, bh);
  }
  return blocked;
}

/** (x, h) 위치에 반지름 r 짜리 원이 통로 안에 온전히 들어가는지 */
export function isOpen(cave: Cave, h: number, x: number, r: number, blocked?: Blocked): boolean {
  for (let ci = 0; ci < cave.corridors.length; ci++) {
    const cor = cave.corridors[ci];
    if (h < cor.h0 || h > cor.h1) continue;
    const bh = blocked?.get(ci);
    if (bh !== undefined && h >= bh - 14) continue;
    const i = Math.round((h - cor.h0) / STEP);
    if (Math.abs(x - cor.cx[i]) <= cor.w[i] / 2 - r) return true;
  }
  return false;
}

/** 해당 높이의 통로 중심 (여러 갈래면 첫 번째 통로) */
export function centerAt(cave: Cave, h: number): number {
  for (const cor of cave.corridors) {
    if (h < cor.h0 || h > cor.h1) continue;
    return cor.cx[Math.round((h - cor.h0) / STEP)];
  }
  return W / 2;
}

// ---------------------------------------------------------------------------
// 2D 경로
// ---------------------------------------------------------------------------

/** 최대 곡률. 반지름이 다발 폭의 절반보다 커야 안쪽 벽이 접히지 않는다. */
const K_MAX = 1 / 330;
/** 지나온 길과 지켜야 하는 거리 (다발 폭 + 여유) */
const CLEAR = 660;
/** 이 거리(인덱스)보다 오래된 점만 '지나온 길'로 본다 */
const OLD = 150;
const CELL = 300;
/** 최근 OLD 구간 안에서 허용하는 누적 회전 (U턴 = π) */
const MAX_WINDOW_TURN = Math.PI * 1.05;

type Mode = 'straight' | 'gentle' | 'strong' | 'hairpin' | 'snake' | 'goal';

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function tryPath(rng: () => number, len: number) {
  const n = Math.round(len / STEP) + 1;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pth = new Float32Array(n);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const nearest = (x: number, y: number) => {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    let best = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const list = grid.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const j of list) best = Math.min(best, Math.hypot(px[j] - x, py[j] - y));
      }
    }
    return best;
  };

  // 끝점: 출발점 위쪽 어딘가. 후반으로 갈수록 그쪽으로 끌린다.
  const goal = { x: (rng() - 0.5) * 1600, y: -len * (0.35 + rng() * 0.15) };

  let x = 0;
  let y = 0;
  let th = 0;
  let k = 0;
  let kt = 0;
  let segLeft = 400;
  let mode: Mode = 'straight';
  let snakeSign = 1;
  let minClear = Infinity;
  const summitFrom = len - 3200 - 200;

  /** kt를 유지했을 때 앞으로의 최소 여유 거리 */
  const clearanceFor = (target: number, i: number) => {
    let sx = x;
    let sy = y;
    let sth = th;
    let sk = k;
    let worst = Infinity;
    for (let m = 1; m <= 110; m++) {
      sk += (target - sk) * 0.08;
      sth += sk * STEP;
      sx += Math.sin(sth) * STEP;
      sy -= Math.cos(sth) * STEP;
      if (m % 3 !== 0) continue;
      worst = Math.min(worst, nearest(sx, sy));
      // 최근 구간과도 겹치면 안 된다 (같은 방향으로 너무 많이 돌면)
      const back = i + m - OLD;
      if (back > 0 && back < i && Math.abs(angleDiff(sth, pth[back])) > MAX_WINDOW_TURN) worst = Math.min(worst, 0);
    }
    return worst;
  };

  const pickMode = (i: number): [Mode, number, number] => {
    const p = (i * STEP) / len;
    const sign = rng() < 0.5 ? -1 : 1;
    if (p > 0.62 && rng() < 0.55) {
      const want = Math.atan2(goal.x - x, -(goal.y - y));
      const diff = angleDiff(want, th);
      return ['goal', Math.max(-K_MAX, Math.min(K_MAX, diff * 0.004)), 300 + rng() * 300];
    }
    const r = rng();
    if (r < 0.12) return ['straight', 0, 150 + rng() * 300];
    if (r < 0.36) return ['gentle', sign * K_MAX * (0.2 + rng() * 0.3), 250 + rng() * 450];
    if (r < 0.62) return ['strong', sign * K_MAX * (0.6 + rng() * 0.4), 200 + rng() * 400];
    if (r < 0.8) return ['hairpin', sign * K_MAX * (0.92 + rng() * 0.08), (Math.PI / K_MAX) * (0.85 + rng() * 0.25)];
    return ['snake', sign * K_MAX * (0.5 + rng() * 0.4), 160 + rng() * 200];
  };

  for (let i = 0; i < n; i++) {
    px[i] = x;
    py[i] = y;
    pth[i] = th;
    // 충분히 오래된 점을 '지나온 길'에 등록
    const old = i - OLD;
    if (old >= 0 && old % 2 === 0) {
      const kk = key(px[old], py[old]);
      const list = grid.get(kk);
      if (list) list.push(old);
      else grid.set(kk, [old]);
    }
    if (i % 4 === 0 && i > OLD) minClear = Math.min(minClear, nearest(x, y));

    if (i * STEP > summitFrom) {
      kt = 0;
    } else {
      segLeft -= STEP;
      if (mode === 'snake' && segLeft <= 0 && rng() < 0.75) {
        // 뱀처럼 좌우로 번갈아
        snakeSign = -snakeSign;
        kt = -kt;
        segLeft = 160 + rng() * 200;
      } else if (segLeft <= 0) {
        const [m, target, l] = pickMode(i);
        mode = m;
        kt = target;
        segLeft = l;
        snakeSign = Math.sign(kt) || 1;
      }
      // 앞길이 지나온 길과 부딪히면 다른 방향을 고른다
      if (i % 5 === 0) {
        if (clearanceFor(kt, i) < CLEAR) {
          const options = [-kt, 0, K_MAX, -K_MAX, K_MAX * 0.5, -K_MAX * 0.5];
          let best = kt;
          let bestC = -1;
          for (const o of options) {
            const c = clearanceFor(o, i);
            if (c > bestC) {
              bestC = c;
              best = o;
            }
          }
          kt = best;
          mode = 'strong';
          segLeft = 200;
        }
      }
    }

    k += (kt - k) * 0.08;
    k = Math.max(-K_MAX, Math.min(K_MAX, k));
    th += k * STEP;
    x += Math.sin(th) * STEP;
    y -= Math.cos(th) * STEP;
  }
  return { path: { x: px, y: py, th: pth } as Path, minClear };
}

/** 지나온 길과 겹치지 않는 경로가 나올 때까지 몇 번 시도한다 */
export function generatePath(seed: number, len: number): Path {
  let best: { path: Path; minClear: number } | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = tryPath(mulberry32((seed ^ 0x9e3779b9) + attempt * 7919), len);
    if (!best || r.minClear > best.minClear) best = r;
    if (r.minClear >= CLEAR * 0.9) break;
  }
  return best!.path;
}

/** 곧게 위로 올라가는 경로 */
export function straightPath(len: number): Path {
  const n = Math.round(len / STEP) + 1;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const th = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = -i * STEP;
  return { x, y, th };
}

/** 통로 좌표 (s, u) → 월드 좌표 */
export function toWorld(cave: Cave, s: number, u: number): { x: number; y: number } {
  const p = cave.path;
  const f = Math.max(0, Math.min(p.x.length - 1.001, s / STEP));
  const i = Math.floor(f);
  const t = f - i;
  const x = p.x[i] + (p.x[i + 1] - p.x[i]) * t;
  const y = p.y[i] + (p.y[i + 1] - p.y[i]) * t;
  const th = p.th[i] + angleDiff(p.th[i + 1], p.th[i]) * t;
  const off = u - W / 2;
  return { x: x + Math.cos(th) * off, y: y + Math.sin(th) * off };
}

/** 해당 거리에서 다발의 진행 방향 */
export function headingAt(cave: Cave, s: number): number {
  const p = cave.path;
  const i = Math.max(0, Math.min(p.th.length - 1, Math.round(s / STEP)));
  return p.th[i];
}

export { angleDiff };
