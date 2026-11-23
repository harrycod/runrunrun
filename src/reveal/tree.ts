import { STEP, W } from '../config';
import type { RunRecord } from '../runs/runStore';

/** 이 간격(xs 인덱스)마다 가지의 점을 하나씩 둔다 */
const SAMPLE = 5;
/** 같은 길로 가다 끝난 판도 끝나기 이만큼(인덱스) 전부터는 제 가지로 뻗는다 */
const TWIG = 150;
/** 줄기를 부드럽게 다듬는 이동평균 반경 (인덱스) */
const TRUNK_SMOOTH = 160;

export interface Pt {
  x: number;
  y: number;
  /** 원래 게임에서의 높이 (성장 애니메이션 순서) */
  h: number;
}

export interface Branch {
  run: RunRecord;
  parent: Branch | null;
  /** 부모에게서 갈라진 높이 인덱스 */
  d: number;
  pts: Pt[];
  descendants: number;
  baseWidth: number;
  isTrunk: boolean;
  /** 나비에 밀린 지점 → 꽃 */
  flowers: Pt[];
  /** 장식용 잔가지 (판 기록과 무관, 나무를 풍성하게 보이게) */
  twigs: Pt[][];
}

export interface Tree {
  branches: Branch[];
  trunk: Branch;
  maxH: number;
}

/** 이만큼 좌우로 벌어진 채 */
const DIVERGE_PX = 70;
/** 이만큼(인덱스) 이어지면 갈라진 것으로 본다 */
const DIVERGE_HOLD = 25;

/**
 * 두 판이 갈라진 지점. 판마다 맵이 달라서 '어느 통로'로는 비교할 수 없으므로,
 * 실제로 지나간 좌우 위치가 충분히, 충분히 오래 벌어지기 시작한 곳을 갈라진 곳으로 본다.
 */
function divergeIdx(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > DIVERGE_PX) {
      run++;
      if (run >= DIVERGE_HOLD) return i - DIVERGE_HOLD + 1;
    } else run = 0;
  }
  return n - 1;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function smoothed(xs: number[], i: number) {
  let sum = 0;
  let cnt = 0;
  for (let j = Math.max(0, i - TRUNK_SMOOTH); j <= Math.min(xs.length - 1, i + TRUNK_SMOOTH); j++) {
    sum += xs[j];
    cnt++;
  }
  return sum / cnt;
}

function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** 부모 가지에서 idx 높이에 해당하는 점과 진행 방향 */
function pointOn(b: Branch, idx: number): { p: Pt; ang: number } {
  const j = Math.max(0, Math.min(b.pts.length - 1, Math.round((idx - b.d) / SAMPLE)));
  const p = b.pts[j];
  const q = b.pts[Math.min(b.pts.length - 1, j + 1)];
  const r = b.pts[Math.max(0, j - 1)];
  const ang = q === r ? 0 : Math.atan2(q.x - r.x, -(q.y - r.y));
  return { p, ang };
}

/**
 * 모든 판의 궤적을 한 그루의 나무로 엮는다.
 * - 꼭대기에 닿은 마지막 판이 줄기
 * - 나머지 판은 가장 오래 같은 길을 걸었던 판에서 갈라져 나온 가지
 *   (일찍 끝난 판은 짧은 잔가지, 멀리 간 판은 긴 가지)
 */
export function buildTree(runs: RunRecord[], trunkPx: number): Tree {
  const trunkRun = [...runs].reverse().find((r) => r.reachedTop) ?? runs[runs.length - 1];
  const maxH = trunkRun.endH;

  // 높이 → 화면 길이 (선형). 판들은 대개 첫 갈림길에서 이미 갈라지므로,
  // 낮게 갈라진 큰 가지들이 위로 뻗는 꽃병 모양 나무가 된다.
  const warp = (h: number) => (h / maxH) * trunkPx;

  const trunk: Branch = {
    run: trunkRun,
    parent: null,
    d: 0,
    pts: [],
    descendants: 0,
    baseWidth: 0,
    isTrunk: true,
    flowers: [],
    twigs: [],
  };
  for (let i = 0; i < trunkRun.xs.length; i += SAMPLE) {
    const h = i * STEP;
    trunk.pts.push({ x: (smoothed(trunkRun.xs, i) - W / 2) * 0.07, y: -warp(h), h });
  }

  // 오래 산 판일수록 굵은 가지가 되도록 먼저 배치
  const others = runs.filter((r) => r !== trunkRun).sort((a, b) => b.endH - a.endH);
  const placed: Branch[] = [trunk];
  /** 같은 부모의 비슷한 높이에서 갈라진 가지 수. 같은 자리에서 여러 번 끝난 판들을 부채꼴로 펼친다. */
  const siblings = new Map<string, number>();
  /** 오른쪽 가지 총길이 - 왼쪽 가지 총길이 (좌우 균형용) */
  let balance = 0;

  // 1단계: 각 판이 어느 판에서, 어디서 갈라졌는지 (모양과 무관한 구조만)
  const plan: { run: RunRecord; parent: RunRecord; d: number }[] = [];
  const placedRuns: { run: RunRecord; d: number }[] = [{ run: trunkRun, d: 0 }];
  for (const run of others) {
    const latest = Math.max(0, run.xs.length - 1 - TWIG);
    let parent = trunkRun;
    let d = -1;
    for (const cand of placedRuns) {
      const di = Math.min(divergeIdx(run.xs, cand.run.xs), latest, cand.run.xs.length - 1);
      if (di >= cand.d && di > d) {
        d = di;
        parent = cand.run;
      }
    }
    d = Math.max(0, d);
    plan.push({ run, parent, d });
    placedRuns.push({ run, d });
  }

  // 줄기에 붙는 가지는 갈라진 순서를 지키면서 줄기 높이 18~82%에 고르게 나눠 붙인다
  const maxIdx = maxH / STEP;
  const trunkKids = plan.filter((q) => q.parent === trunkRun).sort((a, b) => a.d - b.d);
  const attachOf = new Map<RunRecord, number>();
  trunkKids.forEach((q, i) => {
    const f = trunkKids.length === 1 ? 0.45 : i / (trunkKids.length - 1);
    // 너무 고르면 생선뼈처럼 보이므로 살짝 흐트러뜨린다
    const jitter = (hash(i * 3.7 + 1) - 0.5) * (0.6 / Math.max(2, trunkKids.length));
    attachOf.set(q.run, Math.round(maxIdx * Math.min(0.84, Math.max(0.16, 0.18 + 0.64 * f + jitter))));
  });

  // 2단계: 모양 만들기
  const branchOf = new Map<RunRecord, Branch>([[trunkRun, trunk]]);
  plan.forEach(({ run, parent: parentRun, d }, n) => {
    const parent = branchOf.get(parentRun)!;
    const attachIdx = attachOf.get(run) ?? d;
    const { p: start, ang: parentAng } = pointOn(parent, attachIdx);
    const attachFrac = Math.min(1, -start.y / Math.max(1, trunkPx));

    const probe = Math.min(run.xs.length - 1, d + 3);
    const sideRaw = (run.xs[probe] ?? 0) - (parentRun.xs[probe] ?? run.xs[probe] ?? 0);
    const key = `${placed.indexOf(parent)}:${Math.round(attachIdx / 25)}`;
    const sib = siblings.get(key) ?? 0;
    siblings.set(key, sib + 1);
    // 실제로 확실히 한쪽으로 갔으면 그쪽, 애매하면 가지가 적은 쪽으로 뻗어 좌우 균형을 맞춘다
    const baseSide = Math.abs(sideRaw) > 60 ? Math.sign(sideRaw) : balance > 0 ? -1 : balance < 0 ? 1 : hash(n) < 0.5 ? -1 : 1;
    const side = sib % 2 === 0 ? baseSide : -baseSide;
    balance += side * (run.xs.length - d);
    // 낮은 가지는 옆으로 넓게, 높은 가지는 위로
    const spread = (lerp(1.25, 0.6, attachFrac) + Math.floor(sib / 2) * 0.06 + hash(n + 7) * 0.2) * (parent.isTrunk ? 1 : 0.75);
    const lenJitter = 0.85 + hash(n + 13) * 0.3;

    const branch: Branch = {
      run,
      parent,
      d,
      pts: [start],
      descendants: 0,
      baseWidth: 0,
      isTrunk: false,
      flowers: [],
      twigs: [],
    };
    const total = Math.max(1, run.xs.length - 1 - d);
    const steps = Math.max(3, Math.ceil(total / SAMPLE));
    // 길이: 갈라진 뒤 산 만큼. 너무 짧은 판도 오래 산 판일수록 길게 최소 길이를 보장한다.
    const natural = (total * STEP / maxH) * trunkPx * 0.72;
    // 줄기 높이에 비례: 오래 산 판일수록 길게
    const minLen = trunkPx * (parent.isTrunk ? 0.16 + 0.34 * (run.endH / maxH) : 0.08 + 0.16 * (run.endH / maxH));
    // 가운데~윗부분 가지가 가장 길어서 둥근 수관이 된다
    const crown = parent.isTrunk ? 0.65 + 0.75 * Math.sin(Math.PI * Math.min(1, attachFrac * 1.1)) : 1;
    const want = Math.max(natural, minLen) * crown * lenJitter;
    const segLen = want / steps;
    let { x, y } = start;
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      // 처음엔 옆으로 뻗고, 갈수록 빛(위)을 향해 휜다
      const ang = parentAng + side * spread * (1 - 0.45 * t) + Math.sin(j * 0.6 + n) * 0.05;
      x += Math.sin(ang) * segLen;
      y -= Math.cos(ang) * segLen;
      // 자라는 순서: 붙은 자리에서부터
      branch.pts.push({ x, y, h: start.h + t * total * STEP });
    }
    placed.push(branch);
    branchOf.set(run, branch);
  });

  // 자손 수 → 굵기
  for (let i = placed.length - 1; i > 0; i--) {
    const b = placed[i];
    if (b.parent) b.parent.descendants += b.descendants + 1;
  }
  for (const b of placed) {
    // 굵기: 매달린 가지 수 + 그 판이 산 길이
    const lifeLen = (b.run.xs.length - b.d) / Math.max(1, maxH / STEP);
    b.baseWidth = b.isTrunk
      ? 6 + Math.sqrt(b.descendants + 1) * 1.6
      : 1.2 + Math.sqrt(b.descendants + 1) * 1.1 + lifeLen * 5;
  }

  // 나비에 밀린 지점마다 꽃
  for (const b of placed) {
    for (const kick of b.run.kicks) {
      const idx = Math.floor(kick.h / STEP);
      let owner: Branch | null = b;
      while (owner && idx < owner.d) owner = owner.parent;
      if (!owner) continue;
      owner.flowers.push(pointOn(owner, idx).p);
    }
  }

  // 잔가지: 가지 길이에 비례해 몇 개씩, 위쪽을 향해 짧게
  placed.forEach((b, bi) => {
    let lenPx = 0;
    for (let j = 1; j < b.pts.length; j++) lenPx += Math.hypot(b.pts[j].x - b.pts[j - 1].x, b.pts[j].y - b.pts[j - 1].y);
    const count = Math.min(b.isTrunk ? 14 : 7, Math.floor(lenPx / (b.isTrunk ? 26 : 20)));
    for (let t = 0; t < count; t++) {
      const f = b.isTrunk ? 0.25 + 0.7 * ((t + hash(bi * 31 + t)) / count) : 0.2 + 0.75 * hash(bi * 17 + t * 3.1);
      const j = Math.max(1, Math.min(b.pts.length - 2, Math.round(f * (b.pts.length - 1))));
      if (b.pts.length < 3) break;
      const base = b.pts[j];
      const dir = Math.atan2(b.pts[j + 1].x - b.pts[j - 1].x, -(b.pts[j + 1].y - b.pts[j - 1].y));
      const side = (t + bi) % 2 === 0 ? 1 : -1;
      const len = (b.isTrunk ? 14 : 8) + hash(bi * 7 + t * 13) * (b.isTrunk ? 22 : 12);
      const twig: Pt[] = [base];
      let { x, y } = base;
      for (let k = 1; k <= 3; k++) {
        const ang = dir + side * (0.9 - 0.25 * k) * (0.8 + hash(bi + t * 5) * 0.4);
        x += (Math.sin(ang) * len) / 3;
        y -= (Math.cos(ang) * len) / 3;
        twig.push({ x, y, h: base.h + k * 150 });
      }
      b.twigs.push(twig);
    }
  });

  return { branches: placed, trunk, maxH };
}

/** 나무 전체를 담는 사각형 */
export function treeBounds(tree: Tree) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of tree.branches) {
    for (const p of b.pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, maxX, minY, maxY };
}
