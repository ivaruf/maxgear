// Procedural Web Audio: SFX palette + a lightweight generative loop.
// STEAMPUNK voicing: iron clanks, steam hiss, brass bells and a music-box /
// brass-organ take on the same Am-F-C-G loop. Same API, same scheduler.
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
// `bp`/`bpEnd`/`q` sweep a bandpass (that's the steam-hiss / vent voice) and
// `attack` swells the burst in instead of striking it.
function noiseHit(o) {
  if (muted || !ctx || !noiseBuf) return;
  try {
    o = o || {};
    const t0 = o.at != null ? o.at : ctx.currentTime + (o.delay || 0);
    const dur = o.dur != null ? o.dur : 0.15;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate != null ? o.rate : 1;

    const peak = Math.max(o.gain != null ? o.gain : 0.3, 0.0005);
    const atk = Math.min(o.attack || 0, dur * 0.6);
    const g = ctx.createGain();
    if (atk > 0) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + atk);
    } else {
      g.gain.setValueAtTime(peak, t0);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let head = src;
    if (o.bp) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = o.q != null ? o.q : 1.2;
      f.frequency.setValueAtTime(o.bp, t0);
      if (o.bpEnd) f.frequency.exponentialRampToValueAtTime(Math.max(o.bpEnd, 40), t0 + dur);
      head = head.connect(f);
    }
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
// Same progression and same scheduler as v1.0 — only the voicing moved to
// brass-organ bass + music-box arp + a chord bell, at a slightly slower gait.
// Boss mode layers in a sub drone, offbeat steam chuffs and a counter-line.
const ROOT_HZ = 110;                       // A2
const BPM = 96;
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
  // bass: brass-organ eighths, octave jump on the 3rd of each group
  tone({
    at: t, dur: STEP_DUR * 0.8, type: 'square', bus: musicBus,
    freq: hz(ch.root - 12 + (i % 4 === 2 ? 12 : 0)),
    gain: 0.4, cut: 380, attack: 0.014,
  });
  // music-box arpeggio on the offbeats, two octaves up (short, plucked)
  if (i % 2 === 1) {
    tone({
      at: t, dur: STEP_DUR * 0.55, type: 'square', bus: musicBus,
      freq: hz(ch.triad[(i >> 1) % 3] + 24),
      gain: 0.1, cut: 2200, attack: 0.003,
    });
  } else if (i % 4 === 0) {
    // small brass bell on the chord change (never stacks with the arp)
    tone({
      at: t, dur: STEP_DUR * 1.7, type: 'triangle', bus: musicBus,
      freq: hz(ch.triad[0] + 12), gain: 0.075, cut: 2600, attack: 0.006,
    });
  }
  if (bossMode) {
    if (i % 8 === 0) {
      tone({ at: t, dur: STEP_DUR * 3.6, type: 'sine', bus: musicBus, freq: hz(ch.root - 24), gain: 0.5, cut: 180, attack: 0.05 });
    }
    // offbeat steam chuff instead of a hat
    if (i % 2 === 1) noiseHit({ at: t, dur: 0.055, gain: 0.05, bp: 4200, q: 1.6, attack: 0.008, bus: musicBus });
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
let lastHit = 0;
let lastDie = 0;
let lastBoom = 0;

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

  // iron-on-iron clank: body thud + inharmonic metallic partials. Pitch-varied so
  // rapid fire reads as texture; the partials thin out while the player sprays.
  hit() {
    if (muted || !ctx) return;
    const t = ctx.currentTime;
    const dense = t - lastHit < 0.05;
    lastHit = t;
    const r = rnd(0.85, 1.2);
    tone({ at: t, freq: 250 * r, end: 130 * r, dur: 0.045, type: 'triangle', gain: 0.15, detune: rnd(-50, 50) });
    tone({ at: t, freq: 1860 * r, end: 1620 * r, dur: 0.036, type: 'square', gain: dense ? 0.035 : 0.06, cut: 6200 });
    if (!dense) tone({ at: t + 0.004, freq: 3120 * r, dur: 0.026, type: 'triangle', gain: 0.035 });
    noiseHit({ at: t, dur: 0.03, gain: 0.055, hp: 2600, rate: rnd(0.9, 1.3) });
  },

  // scrap-iron collapse + a short vent of steam
  enemyDie() {
    if (muted || !ctx) return;
    const t = ctx.currentTime;
    const dense = t - lastDie < 0.06;
    lastDie = t;
    const r = rnd(0.9, 1.12);
    tone({ at: t, freq: 330 * r, end: 62, dur: 0.17, type: 'sawtooth', gain: 0.18, cut: 2000, cutEnd: 420 });
    tone({ at: t, freq: 1450 * r, end: 1180 * r, dur: 0.05, type: 'square', gain: dense ? 0.03 : 0.055, cut: 5200 });
    noiseHit({ at: t, dur: 0.12, gain: 0.1, cut: 3000, cutEnd: 700, rate: rnd(0.85, 1.15) });
    if (!dense) {
      noiseHit({ at: t + 0.05, dur: 0.2, gain: 0.06, bp: 2400, bpEnd: 900, q: 1, attack: 0.02 });
    }
  },

  // layered: sub thump + body + debris noise sweep + crack, then a steam-hiss tail
  explode() {
    if (muted || !ctx) return;
    const t = ctx.currentTime;
    // chain-reaction builds fire these in clusters: only the first blast of a
    // cluster gets the long steam tail, so they never pile into mush
    const dense = t - lastBoom < 0.09;
    lastBoom = t;
    const r = rnd(0.9, 1.1);
    tone({ at: t, freq: 150 * r, end: 26, dur: 0.34, type: 'sine', gain: 0.5, attack: 0.008 });
    tone({ at: t + 0.005, freq: 96 * r, end: 40, dur: 0.22, type: 'triangle', gain: 0.26 });
    noiseHit({ at: t, dur: 0.4, gain: 0.34, cut: 2400, cutEnd: 260, rate: rnd(0.8, 1.1) });
    noiseHit({ at: t, dur: 0.06, gain: 0.16, hp: 2600 });
    // ruptured boiler: bandpass sweeping down out of the blast
    if (!dense) {
      noiseHit({ at: t + 0.07, dur: 0.52, gain: 0.15, bp: 3400, bpEnd: 900, q: 0.9, attack: 0.05, rate: 0.85 });
    }
  },

  hurt() {
    tone({ freq: 190, end: 68, dur: 0.2, type: 'sawtooth', gain: 0.34, cut: 1400, cutEnd: 300 });
    tone({ freq: 128, end: 52, dur: 0.26, type: 'square', gain: 0.14, detune: -28 });
    tone({ freq: 1180, end: 900, dur: 0.06, type: 'square', gain: 0.07, cut: 4200 });   // hull clang
    noiseHit({ dur: 0.14, gain: 0.13, cut: 1200 });
    noiseHit({ delay: 0.08, dur: 0.3, gain: 0.1, bp: 2000, bpEnd: 700, q: 0.9, attack: 0.03 });  // steam leak
  },

  // light 'ting' — a struck brass pin
  pickup() {
    tone({ freq: 1568, dur: 0.09, type: 'sine', gain: 0.2, attack: 0.002 });
    tone({ freq: 2350, dur: 0.05, type: 'sine', gain: 0.09 });
    tone({ freq: 2093, dur: 0.17, type: 'triangle', gain: 0.1, delay: 0.045 });
  },

  // two-note brass bell (strike + fifth above), each with bell partials
  gateGood() {
    const bell = (f, g, d) => {
      tone({ freq: f, dur: 0.5, type: 'triangle', gain: g, delay: d, attack: 0.004, cut: 3600 });
      tone({ freq: f * 2.76, dur: 0.26, type: 'sine', gain: g * 0.35, delay: d });
      tone({ freq: f * 5.4, dur: 0.12, type: 'sine', gain: g * 0.16, delay: d });
    };
    bell(587, 0.26, 0);        // D5
    bell(880, 0.22, 0.13);     // A5
    noiseHit({ dur: 0.1, gain: 0.05, hp: 4200 });
  },

  gateBad() {
    tone({ freq: 300, end: 140, dur: 0.26, type: 'sawtooth', gain: 0.3, cut: 1600, cutEnd: 320 });
    tone({ freq: 296, end: 138, dur: 0.26, type: 'sawtooth', gain: 0.22, detune: 34 });  // sour beating
    noiseHit({ dur: 0.2, gain: 0.12, cut: 900 });
    noiseHit({ delay: 0.05, dur: 0.28, gain: 0.09, bp: 700, bpEnd: 260, q: 3, rate: 0.7 });  // gear grind
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
    tone({ at: t, freq: f, end: f * 1.5, dur: 0.05, type: 'square', gain: 0.12, detune: rnd(-25, 25), cut: 6000 });
    tone({ at: t, freq: f * 2.6, dur: 0.03, type: 'triangle', gain: 0.045 });   // anvil ting
    noiseHit({ at: t, dur: 0.02, gain: 0.05, hp: 5000 });
  },

  // IRONCLAD: foghorn blend (detuned low voices) + steam whistle + pressure release
  bossRoar() {
    tone({ freq: 78, end: 74, dur: 1.05, type: 'sawtooth', gain: 0.42, cut: 520, cutEnd: 300, attack: 0.13 });
    tone({ freq: 58, end: 55, dur: 1.15, type: 'sine', gain: 0.45, attack: 0.1 });
    tone({ freq: 117, end: 110, dur: 0.95, type: 'triangle', gain: 0.2, detune: 12, cut: 900, attack: 0.16 });
    tone({ freq: 880, end: 838, dur: 0.6, type: 'square', gain: 0.075, delay: 0.16, cut: 2600, attack: 0.05 });
    tone({ freq: 892, end: 850, dur: 0.6, type: 'square', gain: 0.055, delay: 0.16, detune: 18, cut: 2600, attack: 0.05 });
    noiseHit({ delay: 0.1, dur: 0.85, gain: 0.2, bp: 2600, bpEnd: 700, q: 0.8, attack: 0.12 });
    noiseHit({ dur: 0.35, gain: 0.12, cut: 1400, cutEnd: 320 });
  },

  // brass fanfare + a bell and one long steam release
  win() {
    [523, 659, 784, 1046].forEach((f, i) => {
      tone({ freq: f, dur: 0.26, type: 'square', gain: 0.2, delay: i * 0.12, cut: 2400, attack: 0.012 });
      tone({ freq: f * 2, dur: 0.16, type: 'triangle', gain: 0.07, delay: i * 0.12 });
      tone({ freq: f / 2, dur: 0.3, type: 'sawtooth', gain: 0.1, delay: i * 0.12, cut: 700 });
    });
    tone({ freq: 1046, dur: 1, type: 'triangle', gain: 0.2, delay: 0.52, attack: 0.01 });
    tone({ freq: 1568, dur: 0.7, type: 'sine', gain: 0.09, delay: 0.56 });
    noiseHit({ delay: 0.5, dur: 0.5, gain: 0.07, bp: 3000, bpEnd: 1200, q: 1, attack: 0.06 });
  },

  // the boiler dies: descending brass + pressure bleeding away
  lose() {
    [330, 262, 208, 156].forEach((f, i) => {
      tone({ freq: f, end: f * 0.94, dur: 0.34, type: 'sawtooth', gain: 0.24, delay: i * 0.17, cut: 1300, cutEnd: 500 });
    });
    tone({ freq: 98, end: 62, dur: 0.9, type: 'sine', gain: 0.22, delay: 0.5 });
    noiseHit({ delay: 0.5, dur: 0.9, gain: 0.1, bp: 1800, bpEnd: 300, q: 0.7, attack: 0.12 });
    noiseHit({ dur: 0.7, gain: 0.07, cut: 700, delay: 0.55 });
  },

  // brass toggle switch
  click() {
    tone({ freq: 880, end: 620, dur: 0.05, type: 'sine', gain: 0.18 });
    tone({ freq: 2100, dur: 0.03, type: 'square', gain: 0.05, cut: 5200 });
    noiseHit({ dur: 0.02, gain: 0.05, hp: 3200 });
  },
};
