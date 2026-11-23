import { audioGraph } from './sfx';

/**
 * 배경음악. 효과음과 같은 AudioContext를 쓰고, 씬이 바뀌어도 끊기지 않도록 모듈 단위로 상태를 가진다.
 *
 * 체인: source → trackGain → lowpass(마지막 어둠 구간용) → musicBus → master
 */

type TrackKey = 'run' | 'tree';

const MUSIC_GAIN = 0.55;
/** 플레이 곡은 끝의 페이드아웃이 시작되기 전에 처음(조용한 인트로)으로 크로스페이드한다 */
const RUN_LOOP_AT = 176;
const RUN_CROSSFADE = 5;
const OPEN_HZ = 20000;
const CLOSED_HZ = 420;

const buffers = new Map<TrackKey, AudioBuffer>();
const loading = new Map<TrackKey, Promise<AudioBuffer | null>>();

let bus: GainNode | null = null;
let filter: BiquadFilterNode | null = null;

interface Playing {
  key: TrackKey;
  src: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
}
let current: Playing | null = null;
let loopTimer: number | undefined;
let wanted: TrackKey | null = null;

function pickFormat(): 'ogg' | 'm4a' {
  const a = document.createElement('audio');
  return a.canPlayType('audio/ogg; codecs=opus') ? 'ogg' : 'm4a';
}

function graph() {
  const g = audioGraph();
  if (!g) return null;
  if (!bus || !filter) {
    filter = g.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = OPEN_HZ;
    filter.Q.value = 0.7;
    bus = g.ctx.createGain();
    bus.gain.value = MUSIC_GAIN;
    filter.connect(bus);
    bus.connect(g.master);
  }
  return { ctx: g.ctx, filter, bus };
}

async function load(key: TrackKey): Promise<AudioBuffer | null> {
  const cached = buffers.get(key);
  if (cached) return cached;
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      const g = graph();
      if (!g) return null;
      const fmt = pickFormat();
      try {
        const res = await fetch(`audio/${key}.${fmt}`);
        const data = await res.arrayBuffer();
        const buf = await g.ctx.decodeAudioData(data);
        buffers.set(key, buf);
        return buf;
      } catch {
        // ogg 디코딩에 실패하는 브라우저는 m4a로 한 번 더
        if (fmt === 'ogg') {
          try {
            const res = await fetch(`audio/${key}.m4a`);
            const buf = await g.ctx.decodeAudioData(await res.arrayBuffer());
            buffers.set(key, buf);
            return buf;
          } catch {
            return null;
          }
        }
        return null;
      }
    })();
    loading.set(key, p);
  }
  return p;
}

/** 미리 받아두기 (첫 재생 지연 방지) */
export function preloadMusic() {
  void load('run');
  void load('tree');
}

function startSource(key: TrackKey, buf: AudioBuffer, fadeIn: number, offset = 0) {
  const g = graph()!;
  const t = g.ctx.currentTime;
  const src = g.ctx.createBufferSource();
  src.buffer = buf;
  const gain = g.ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(1, t + Math.max(0.05, fadeIn));
  src.connect(gain);
  gain.connect(g.filter);
  src.start(t, offset);
  return { key, src, gain, startedAt: t - offset };
}

function fadeOutAndStop(p: Playing, seconds: number) {
  const g = graph()!;
  const t = g.ctx.currentTime;
  p.gain.gain.cancelScheduledValues(t);
  p.gain.gain.setValueAtTime(Math.max(0.0001, p.gain.gain.value), t);
  p.gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  p.src.stop(t + seconds + 0.05);
}

function scheduleRunLoop() {
  window.clearInterval(loopTimer);
  loopTimer = window.setInterval(() => {
    const g = graph();
    if (!g || !current || current.key !== 'run') return;
    if (g.ctx.currentTime - current.startedAt < RUN_LOOP_AT) return;
    const buf = buffers.get('run');
    if (!buf) return;
    fadeOutAndStop(current, RUN_CROSSFADE);
    current = startSource('run', buf, RUN_CROSSFADE * 0.6);
  }, 250);
}

/** 해당 곡이 이미 흐르고 있으면 그대로 두고, 아니면 이전 곡을 페이드아웃하고 시작한다 */
export async function playMusic(key: TrackKey, fadeIn = 1.5) {
  wanted = key;
  if (current?.key === key) return;
  const buf = await load(key);
  if (!buf || wanted !== key || current?.key === key) return;
  if (current) fadeOutAndStop(current, 1.5);
  current = startSource(key, buf, fadeIn);
  if (key === 'run') scheduleRunLoop();
  else window.clearInterval(loopTimer);
}

export function stopMusic(fadeOut = 2) {
  wanted = null;
  window.clearInterval(loopTimer);
  if (current) fadeOutAndStop(current, fadeOut);
  current = null;
}

/** 0 = 활짝 열림, 1 = 물속처럼 먹먹함 */
export function setMuffle(amount: number) {
  const g = graph();
  if (!g) return;
  const a = Math.max(0, Math.min(1, amount));
  const hz = OPEN_HZ * Math.pow(CLOSED_HZ / OPEN_HZ, a);
  g.filter.frequency.setTargetAtTime(hz, g.ctx.currentTime, 0.15);
}

/** 죽었을 때 음악이 잠깐 가라앉았다가 돌아온다 */
export function duckMusic() {
  const g = graph();
  if (!g) return;
  const t = g.ctx.currentTime;
  g.bus.gain.cancelScheduledValues(t);
  g.bus.gain.setValueAtTime(g.bus.gain.value, t);
  g.bus.gain.linearRampToValueAtTime(MUSIC_GAIN * 0.25, t + 0.08);
  g.bus.gain.linearRampToValueAtTime(MUSIC_GAIN, t + 1.6);
}
