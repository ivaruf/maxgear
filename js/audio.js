// Web Audio SFX, fully procedural (no assets). Context is created lazily on
// first user gesture (audio.unlock() is called from main.js input handling).
// UI/audio-agent: improve sounds freely, keep the exported API identical.

let ctx = null;
let muted = false;
let master = null;

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function beep({ freq = 440, end = freq, dur = 0.1, type = 'square', gain = 0.5, delay = 0 }) {
  if (muted || !ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(end, 1), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.15, gain = 0.3, delay = 0 }) {
  if (muted || !ctx) return;
  const t0 = ctx.currentTime + delay;
  const len = Math.max(1, (dur * ctx.sampleRate) | 0);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start(t0);
}

let lastShoot = 0;
export const audio = {
  unlock() { ensure(); },
  toggleMute() { muted = !muted; return muted; },
  isMuted() { return muted; },

  shoot() {
    // throttle: at high fire rates only every few shots make a sound
    const now = performance.now();
    if (now - lastShoot < 70) return;
    lastShoot = now;
    beep({ freq: 720, end: 340, dur: 0.06, type: 'square', gain: 0.12 });
  },
  hit() { beep({ freq: 250, end: 140, dur: 0.05, type: 'triangle', gain: 0.2 }); },
  enemyDie() { beep({ freq: 320, end: 60, dur: 0.18, type: 'sawtooth', gain: 0.25 }); noise({ dur: 0.1, gain: 0.12 }); },
  explode() { noise({ dur: 0.35, gain: 0.4 }); beep({ freq: 120, end: 30, dur: 0.3, type: 'sine', gain: 0.5 }); },
  hurt() { beep({ freq: 180, end: 70, dur: 0.2, type: 'sawtooth', gain: 0.4 }); },
  pickup() { beep({ freq: 660, end: 990, dur: 0.12, type: 'sine', gain: 0.3 }); },
  gateGood() { beep({ freq: 520, end: 780, dur: 0.14, type: 'triangle', gain: 0.35 }); beep({ freq: 780, end: 1040, dur: 0.14, type: 'triangle', gain: 0.3, delay: 0.09 }); },
  gateBad() { beep({ freq: 300, end: 150, dur: 0.25, type: 'sawtooth', gain: 0.35 }); },
  bossRoar() { beep({ freq: 90, end: 45, dur: 0.7, type: 'sawtooth', gain: 0.6 }); noise({ dur: 0.5, gain: 0.25 }); },
  win() { [523, 659, 784, 1046].forEach((f, i) => beep({ freq: f, dur: 0.22, type: 'triangle', gain: 0.35, delay: i * 0.13 })); },
  lose() { [330, 262, 208, 165].forEach((f, i) => beep({ freq: f, dur: 0.3, type: 'sawtooth', gain: 0.3, delay: i * 0.16 })); },
  click() { beep({ freq: 880, end: 660, dur: 0.05, type: 'sine', gain: 0.2 }); },
};
