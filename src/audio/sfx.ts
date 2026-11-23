/**
 * Web Audio로 직접 합성하는 효과음.
 * 모든 음은 배경음악 조(ROOT)에 맞춘 음계에서 고른다. 곡의 조가 바뀌면 ROOT만 바꾸면 된다.
 */

/** 기준음 (MIDI). 62 = D4 */
const ROOT = 62;
/** 플레이 중: 단조 펜타토닉 */
const MINOR_PENTA = [0, 3, 5, 7, 10];
/** 나비: 장조 펜타토닉 */
const MAJOR_PENTA = [0, 2, 4, 7, 9];
/** 길잡이 빛 / 엔딩: 3음(장/단)을 뺀 열린 음계. 달지도 슬프지도 않게. */
const OPEN = [0, 2, 5, 7, 10];

const MASTER_GAIN = 0.45;
const REVERB_WET = 0.35;

let ctx: AudioContext | null = null;
let master: GainNode;
let dry: GainNode;
let wet: GainNode;
let muted = false;

let shardCombo = 0;
let lastShardAt = 0;
let nextBloomAt = 0;

function midiToHz(m: number) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function scaleNote(scale: number[], degree: number, octaveOffset = 0) {
  const oct = Math.floor(degree / scale.length);
  const i = ((degree % scale.length) + scale.length) % scale.length;
  return ROOT + scale[i] + 12 * (oct + octaveOffset);
}

function makeImpulse(c: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    return null;
  }
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER_GAIN;
  master.connect(ctx.destination);

  dry = ctx.createGain();
  dry.gain.value = 1;
  dry.connect(master);

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx, 2.8, 2.5);
  wet = ctx.createGain();
  wet.gain.value = REVERB_WET;
  wet.connect(reverb);
  reverb.connect(master);
  return ctx;
}

/** 음악 모듈과 같은 컨텍스트·마스터 볼륨을 공유한다 */
export function audioGraph(): { ctx: AudioContext; master: GainNode } | null {
  const c = ensure();
  return c ? { ctx: c, master } : null;
}

/** 브라우저 자동재생 정책 때문에 첫 입력 때 호출해야 소리가 난다 */
export function unlockAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') void c.resume();
}

export function toggleMute() {
  muted = !muted;
  if (ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.05);
  return muted;
}

function out(c: AudioContext, reverbAmount = 1) {
  const g = c.createGain();
  g.connect(dry);
  if (reverbAmount > 0) {
    const send = c.createGain();
    send.gain.value = reverbAmount;
    g.connect(send);
    send.connect(wet);
  }
  return g;
}

interface ToneOpts {
  freq: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  decay?: number;
  when?: number;
  glideTo?: number;
  reverb?: number;
}

function tone({ freq, type = 'sine', gain = 0.3, attack = 0.005, decay = 0.4, when = 0, glideTo, reverb = 1 }: ToneOpts) {
  const c = ensure();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + when;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + attack + decay);
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  osc.connect(env);
  env.connect(out(c, reverb));
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

/** 종소리: 기본음 + 비정수배 배음 */
function bell(midi: number, gain: number, decay: number, when = 0) {
  const f = midiToHz(midi);
  tone({ freq: f, gain, decay, when, attack: 0.004 });
  tone({ freq: f * 2.76, gain: gain * 0.25, decay: decay * 0.4, when, attack: 0.002 });
  tone({ freq: f * 5.4, gain: gain * 0.08, decay: decay * 0.2, when, attack: 0.001 });
}

function noise(duration: number, gain: number, cutoff: number, when = 0) {
  const c = ensure();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + when;
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cutoff, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(60, cutoff * 0.15), t + duration);
  const env = c.createGain();
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(lp);
  lp.connect(env);
  env.connect(out(c, 0.6));
  src.start(t);
}

// ---------- 게임 이벤트 ----------

/** 빛 조각: 이어서 먹으면 음이 한 칸씩 올라간다 */
export function sfxShard() {
  const now = performance.now();
  shardCombo = now - lastShardAt < 1200 ? shardCombo + 1 : 0;
  lastShardAt = now;
  const midi = scaleNote(MINOR_PENTA, Math.min(shardCombo, 9), 1);
  tone({ freq: midiToHz(midi), type: 'triangle', gain: 0.16, decay: 0.35 });
  tone({ freq: midiToHz(midi + 12), gain: 0.05, decay: 0.2 });
}

/** 나비: 흔들리는 풍경 소리 */
export function sfxButterfly() {
  const start = Math.floor(Math.random() * 3);
  for (let i = 0; i < 4; i++) {
    bell(scaleNote(MAJOR_PENTA, start + i * 2, 2), 0.07, 0.9, i * 0.07 + Math.random() * 0.02);
  }
}

/** 벽에 부딪힘: 거칠지 않은 먹먹한 "툭" */
export function sfxCrash() {
  tone({ freq: 150, glideTo: 45, gain: 0.45, attack: 0.003, decay: 0.35, reverb: 0.5 });
  noise(0.25, 0.18, 700);
}

/** 빛이 다 떨어짐: 사그라드는 소리 */
export function sfxFizzle() {
  tone({ freq: midiToHz(ROOT + 12), glideTo: midiToHz(ROOT - 5), gain: 0.12, attack: 0.02, decay: 0.9 });
  noise(0.6, 0.05, 2500);
}

/** 마지막 구간에서 이전 판의 빛을 흡수: 열린 음이 한 음씩 쌓인다 */
export function sfxAbsorb(index: number) {
  const degree = index % 12;
  bell(scaleNote(OPEN, degree, 0), 0.1, 2.4);
}

/** 꼭대기: 빛 속으로 올라가는 화음 (3음 없는 5도 쌓기) */
export function sfxAscend() {
  [0, 7, 12, 14, 19].forEach((iv, i) => {
    tone({ freq: midiToHz(ROOT + iv), gain: 0.07, attack: 0.6 + i * 0.15, decay: 2.2, when: i * 0.12 });
  });
}

/**
 * 엔딩에서 가지 끝이 필 때. 높이(0~1)에 따라 음 높이가 달라서
 * 나무가 자라는 동안 지금까지의 판들이 하나의 선율처럼 울린다.
 */
export function sfxBloom(heightRatio: number, gain = 1) {
  const c = ensure();
  if (!c) return;
  const degree = Math.round(Math.max(0, Math.min(1, heightRatio)) * 10);
  const now = c.currentTime;
  const when = Math.max(0, nextBloomAt - now);
  nextBloomAt = now + when + 0.07;
  bell(scaleNote(OPEN, degree, 0), 0.045 * gain, 2.2, when);
}

/** 씨앗이 바람을 타고 떠남 */
export function sfxSeed() {
  tone({ freq: midiToHz(ROOT + 19), glideTo: midiToHz(ROOT + 31), gain: 0.05, attack: 0.4, decay: 2.5 });
}
