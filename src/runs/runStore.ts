import { CAVE_VERSION } from '../config';

/** 한 판의 기록. 나중에 엔딩에서 나무의 가지가 된다. */
export interface RunRecord {
  /** STEP 간격 높이마다의 x 좌표 */
  xs: number[];
  endH: number;
  reachedTop: boolean;
  /** 나비에 밀린 지점 */
  kicks: { h: number; x: number }[];
}

const KEY = `parallel-lives:runs:v${CAVE_VERSION}`;
const LIFE_KEY = `parallel-lives:life:v${CAVE_VERSION}`;
let runs: RunRecord[] | null = null;
let lifeSeed: number | null = null;

/** 한 번의 삶(엔딩까지) 동안 유지되는 동굴 시드 */
export function getLifeSeed(): number {
  if (lifeSeed !== null) return lifeSeed;
  try {
    const raw = localStorage.getItem(LIFE_KEY);
    if (raw) lifeSeed = Number(raw);
  } catch {
    // noop
  }
  if (lifeSeed === null || !Number.isFinite(lifeSeed)) newLife();
  return lifeSeed!;
}

/** 새 삶: 동굴 지형이 새로 만들어진다 */
export function newLife() {
  lifeSeed = Math.floor(Math.random() * 2 ** 31);
  try {
    localStorage.setItem(LIFE_KEY, String(lifeSeed));
  } catch {
    // noop
  }
}

export function loadRuns(): RunRecord[] {
  if (runs) return runs;
  try {
    const raw = localStorage.getItem(KEY);
    runs = raw ? (JSON.parse(raw) as RunRecord[]) : [];
  } catch {
    runs = [];
  }
  return runs;
}

export function saveRun(run: RunRecord) {
  const all = loadRuns();
  all.push(run);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 저장 실패해도 이번 세션 메모리에는 남는다
  }
}

export function clearRuns() {
  runs = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // noop
  }
}
