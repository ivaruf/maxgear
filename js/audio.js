// Procedural Web Audio: SFX palette + a lightweight generative synthwave loop.
// No assets, no network. The context is created lazily on the first user gesture
// (audio.unlock(), called from main.js). Every entry point is a no-op if the
// AudioContext is unavailable or the game is muted, and nothing here throws.

let ctx = null;
let master = null;   // mute gate
let sfxBus = null;
let musicBus = null;
let noiseBuf = null;
let muted = false;

const SFX_GAIN = 0.35;
const MUSIC_GAIN = 0.08;      // deliberately quiet — it sits under the SFX
const BOSS_MUSIC_MUL = 1.35;

function ensure() {
  if (ctx) {
    if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) { /* ignore */ } }
    return ctx;
  }
  try {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_GAIN;
    sfxBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_GAIN * (bossMode ? BOSS_MUSIC_MUL : 1);
    musicBus.connect(master);
    noiseBuf = makeNoise(1.5);
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

function makeNoise(sec) {
  const len = Math.max(1, (sec * ctx.sampleRate) | 0);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

const rnd = (a, b) => a + Math.random() * (b - a);

// ---- primitives --------------------------------------------------------------
// One pitched voice. `at` is an absolute context time (defaults to now + delay).
function tone(o) {
  if (muted || !ctx) return;
  try {
    const t0 = o.at != null ? o.at : ctx.currentTime + (o.delay || 0);
    const dur = o.dur != null ? o.dur : 0.1;
    const f0 = o.freq != null ? o.freq : 440;
    const f1 = o.end != null ? o.end : f0;
    const peak = Math.max(o.gain != null ? o.gain : 0.3, 0.0005);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + Math.min(o.attack != null ? o.attack : 0.005, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let head = osc;
    if (o.cut) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.cut, t0);
      if (o.cutEnd) f.frequency.exponentialRampToValueAtTime(Math.max(o.cutEnd, 40), t0 + dur);
      head = head.connect(f);
    }
    head.connect(g).connect(o.bus || sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  } catch (e) { /* audio is never critical */ }
}

// Filtered noise burst from a shared buffer (random offset => no two are alike).
function noiseHit(o) {
  if (muted || !ctx || !noiseBuf) return;
  try {
    o = o || {};
    const t0 = o.at != null ? o.at : ctx.currentTime + (o.delay || 0);
    const dur = o.dur != null ? o.dur : 0.15;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate != null ? o.rate : 1;

    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(o.gain != null ? o.gain : 0.3, 0.0005), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let head = src;
    if (o.cut) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.cut, t0);
      if (o.cutEnd) f.frequency.exponentialRampToValueAtTime(Math.max(o.cutEnd, 40), t0 + dur);
      head = head.connect(f);
    }
    if (o.hp) {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = o.hp;
      head = head.connect(f);
    }
    head.connect(g).connect(o.bus || sfxBus);
    const off = Math.random() * Math.max(0, noiseBuf.duration - dur - 0.06);
    src.start(t0, off, dur + 0.06);
  } catch (e) { /* audio is never critical */ }
}

// ---- generative music --------------------------------------------------------
// 2 bars of 4/4 as 16 eighth notes: Am - F - C - G, octave-pulse bass + arp.
// Boss mode layers in a sub drone, offbeat hats and a square counter-line.
const ROOT_HZ = 110;                       // A2
const BPM = 104;
const STEP_DUR = 60 / BPM / 2;             // eighth note
const LOOKAHEAD = 0.3;                     // seconds scheduled ahead of now
const CHORDS = [
  { root: 0, triad: [0, 3, 7] },           // Am
  { root: -4, triad: [-4, 0, 3] },         // F
  { root: 3, triad: [3, 7, 10] },          // C
  { root: -2, triad: [-2, 2, 5] },         // G
];
const hz = (semi) => ROOT_HZ * Math.pow(2, semi / 12);

let bossMode = false;
let musicTimer = null;
let nextStepTime = 0;
let stepIndex = 0;

function musicStep(i, t) {
  const ch = CHORDS[(i >> 2) & 3];
  // bass: driving eighths, octave jump on the 3rd of each group
  tone({
    at: t, dur: STEP_DUR * 0.85, type: 'sawtooth', bus: musicBus,
    freq: hz(ch.root - 12 + (i % 4 === 2 ? 12 : 0)),
    gain: 0.5, cut: 460, attack: 0.006,
  });
  // arpeggio on the offbeats, two octaves up
  if (i % 2 === 1) {
    tone({
      at: t, dur: STEP_DUR * 0.75, type: 'triangle', bus: musicBus,
      freq: hz(ch.triad[(i >> 1) % 3] + 24),
      gain: 0.16, cut: 3200,
    });
  }
  if (bossMode) {
    if (i % 8 === 0) {
      tone({ at: t, dur: STEP_DUR * 3.6, type: 'sine', bus: musicBus, freq: hz(ch.root - 24), gain: 0.5, cut: 180, attack: 0.05 });
    }
    if (i % 2 === 1) noiseHit({ at: t, dur: 0.045, gain: 0.05, hp: 5200, bus: musicBus });
    if (i % 4 === 3) {
      tone({ at: t, dur: STEP_DUR * 1.1, type: 'square', bus: musicBus, freq: hz(ch.triad[2] + 12), gain: 0.09, cut: 1800 });
    }
  }
}

function musicTick() {
  if (!ctx) return;
  // resync after a suspended/backgrounded tab instead of firing a burst
  if (nextStepTime < ctx.currentTime - 0.2) {
    nextStepTime = ctx.currentTime + 0.05;
    stepIndex = 0;
  }
  while (nextStepTime < ctx.currentTime + LOOKAHEAD) {
    if (!muted) musicStep(stepIndex, nextStepTime);
    nextStepTime += STEP_DUR;
    stepIndex = (stepIndex + 1) & 15;
  }
}

function startMusic() {
  if (!ctx || musicTimer) return;
  try {
    nextStepTime = ctx.currentTime + 0.12;
    stepIndex = 0;
    musicTimer = setInterval(musicTick, 45);
  } catch (e) { musicTimer = null; }
}

function rampBus(bus, value, tau) {
  if (!ctx || !bus) return;
  try {
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setTargetAtTime(value, ctx.currentTime, tau);
  } catch (e) {
    try { bus.gain.value = value; } catch (e2) { /* ignore */ }
  }
}

// ---- public API --------------------------------------------------------------
let lastShoot = 0;
let lastCharge = 0;

export const audio = {
  unlock() { if (ensure()) startMusic(); },

  toggleMute() {
    muted = !muted;
    rampBus(master, muted ? 0 : 1, 0.03);
    return muted;
  },
  isMuted() { return muted; },

  // Music intensity switch — safe to call every frame (ignores no-op changes).
  setBossMode(on) {
    const v = !!on;
    if (v === bossMode) return;
    bossMode = v;
    rampBus(musicBus, MUSIC_GAIN * (v ? BOSS_MUSIC_MUL : 1), 0.45);
  },

  shoot() {
    if (muted || !ctx) return;
    const t = ctx.currentTime;
    const gap = t - lastShoot;
    if (gap < 0.045) return;              // hard throttle at extreme fire rates
    lastShoot = t;
    const soft = gap < 0.13 ? 0.45 : 1;   // softer tick while spraying
    const d = rnd(-70, 70);
    tone({ freq: 700 + d, end: 320, dur: 0.05, type: 'square', gain: 0.1 * soft, detune: d, cut: 4200 });
    noiseHit({ dur: 0.028, gain: 0.05 * soft, hp: 2000 });
  },

  // pitch-varied so rapid fire reads as texture instead of a machine gun buzz
  hit() {
    const r = rnd(0.85, 1.2);
    tone({ freq: 250 * r, end: 130 * r, dur: 0.045, type: 'triangle', gain: 0.16, detune: rnd(-50, 50) });
    noiseHit({ dur: 0.03, gain: 0.06, hp: 1400, rate: rnd(0.9, 1.3) });
  },

  enemyDie() {
    const r = rnd(0.9, 1.12);
    tone({ freq: 330 * r, end: 62, dur: 0.17, type: 'sawtooth', gain: 0.2, cut: 2400, cutEnd: 500 });
    noiseHit({ dur: 0.12, gain: 0.11, cut: 3000, cutEnd: 700, rate: rnd(0.85, 1.15) });
  },

  // layered: sub thump + body + debris noise sweep + short crack
  explode() {
    const r = rnd(0.9, 1.1);
    tone({ freq: 150 * r, end: 26, dur: 0.34, type: 'sine', gain: 0.5, attack: 0.008 });
    tone({ freq: 96 * r, end: 40, dur: 0.22, type: 'triangle', gain: 0.26, delay: 0.005 });
    noiseHit({ dur: 0.4, gain: 0.34, cut: 2400, cutEnd: 260, rate: rnd(0.8, 1.1) });
    noiseHit({ dur: 0.06, gain: 0.16, hp: 2600 });
  },

  hurt() {
    tone({ freq: 190, end: 68, dur: 0.2, type: 'sawtooth', gain: 0.36, cut: 1400, cutEnd: 300 });
    tone({ freq: 128, end: 52, dur: 0.26, type: 'square', gain: 0.14, detune: -28 });
    noiseHit({ dur: 0.14, gain: 0.14, cut: 1200 });
  },

  pickup() {
    tone({ freq: 660, end: 700, dur: 0.07, type: 'sine', gain: 0.24 });
    tone({ freq: 990, end: 1050, dur: 0.11, type: 'sine', gain: 0.22, delay: 0.06 });
  },

  gateGood() {
    [523, 659, 880].forEach((f, i) => {
      tone({ freq: f, end: f * 1.01, dur: 0.16, type: 'triangle', gain: 0.3 - i * 0.05, delay: i * 0.07 });
    });
    noiseHit({ dur: 0.12, gain: 0.05, hp: 4000 });
  },

  gateBad() {
    tone({ freq: 300, end: 140, dur: 0.26, type: 'sawtooth', gain: 0.3, cut: 1600, cutEnd: 320 });
    tone({ freq: 296, end: 138, dur: 0.26, type: 'sawtooth', gain: 0.22, detune: 34 });  // sour beating
    noiseHit({ dur: 0.2, gain: 0.12, cut: 900 });
  },

  // NEW: chargeable gate got shot. `progress` (0..1, optional) raises the pitch
  // so pumping a gate reads as a rising ladder.
  gateCharge(progress) {
    if (muted || !ctx) return;
    const t = ctx.currentTime;
    if (t - lastCharge < 0.035) return;
    lastCharge = t;
    const p = Math.max(0, Math.min(typeof progress === 'number' ? progress : 0, 1));
    const f = 900 + p * 900;
    tone({ freq: f, end: f * 1.5, dur: 0.05, type: 'square', gain: 0.13, detune: rnd(-25, 25), cut: 6000 });
    noiseHit({ dur: 0.02, gain: 0.05, hp: 5000 });
  },

  bossRoar() {
    tone({ freq: 92, end: 44, dur: 0.75, type: 'sawtooth', gain: 0.55, cut: 900, cutEnd: 160 });
    tone({ freq: 46, end: 30, dur: 0.9, type: 'sine', gain: 0.45 });
    tone({ freq: 140, end: 520, dur: 0.5, type: 'square', gain: 0.12, delay: 0.1, cut: 2200 });
    noiseHit({ dur: 0.6, gain: 0.22, cut: 1800, cutEnd: 300 });
  },

  win() {
    [523, 659, 784, 1046].forEach((f, i) => {
      tone({ freq: f, dur: 0.24, type: 'triangle', gain: 0.32, delay: i * 0.12 });
      tone({ freq: f / 2, dur: 0.3, type: 'sawtooth', gain: 0.1, delay: i * 0.12, cut: 900 });
    });
    tone({ freq: 1046, dur: 0.9, type: 'triangle', gain: 0.22, delay: 0.52 });
  },

  lose() {
    [330, 262, 208, 156].forEach((f, i) => {
      tone({ freq: f, end: f * 0.94, dur: 0.34, type: 'sawtooth', gain: 0.26, delay: i * 0.17, cut: 1300, cutEnd: 500 });
    });
    noiseHit({ dur: 0.7, gain: 0.09, cut: 700, delay: 0.5 });
  },

  click() { tone({ freq: 880, end: 620, dur: 0.05, type: 'sine', gain: 0.2 }); },
};
