// Audio: rendered assets, one music bed, two buses the player controls.
//
// Every sound MAXGEAR makes is a file now. The effects are the thirteen Sonic
// Pi pieces in tools/audio (rebuild them with tools/audio/build.sh); the music
// bed is the maxgear theme. What used to live in this file — an oscillator
// bank and a generative Am-F-C-G scheduler — is gone, because a recorded iron
// clank carries the steampunk voicing further than two oscillators and a
// noise buffer ever did.
//
// The graph:
//   buffer source -> per-voice gain -> sfxBus  -> master -> destination
//                                     musicBus ^
// master is the mute gate. sfxBus and musicBus carry the player's two sliders,
// remembered in localStorage (see STORE_KEY). Everything is created lazily on
// the first user gesture (audio.unlock(), called from main.js); every entry
// point is a no-op before that, and a file that fails to load warns once and
// then plays nothing. Audio is never allowed to break the game.
//
// The API is unchanged from the synthesised version: same thirteen methods,
// same throttles, same clustering behaviour. What used to thin a sound by
// dropping its partials now thins it by pulling its gain, and what used to
// vary pitch with an oscillator frequency now varies playbackRate — a spray of
// shots must still read as texture rather than one file on repeat.

const BASE = 'assets/audio/';
const STORE_KEY = 'maxgear.audio.v1';

const EFFECTS = [
  'shoot', 'hit', 'enemy-die', 'explode', 'hurt', 'pickup',
  'gate-good', 'gate-bad', 'gate-charge', 'boss-roar', 'win', 'lose', 'click',
];
const MUSIC = 'music-theme';

// The theme is mastered loud and the effects are mixed to peak at -8 dBFS, so
// the bed sits well below them by default. Both are the player's to change.
const DEFAULT_MUSIC = 0.5;
const DEFAULT_SFX = 0.85;
// Boss mode is the only music intensity lever a single fixed track has, so it
// works by DUCKING everything else instead of pushing past the slider: normal
// play runs at 80% of what the player asked for, the end fight at 100%.
const CALM_MUSIC_MUL = 0.8;

let ctx = null;
let master = null;    // mute gate
let sfxBus = null;
let musicBus = null;
let musicNode = null; // the looping bed, once started
let bossMode = false;
let warned = false;   // one console warning per session, not one per shot

const buffers = new Map();   // name -> AudioBuffer, once decoded
const pending = new Map();   // name -> Promise, from the moment it is asked for

// ---- persisted preferences ---------------------------------------------------
// One record, one key (hub storage convention: <slug>.<thing>.v<n>). Mute is
// remembered too, which the synthesised version never did.
const prefs = { music: DEFAULT_MUSIC, sfx: DEFAULT_SFX, muted: false };

try {
  const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (raw && typeof raw === 'object') {
    if (typeof raw.music === 'number') prefs.music = clamp01(raw.music);
    if (typeof raw.sfx === 'number') prefs.sfx = clamp01(raw.sfx);
    prefs.muted = !!raw.muted;
  }
} catch (e) { /* private mode, or a corrupt record: the defaults are fine */ }

function savePrefs() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); }
  catch (e) { /* not remembered this time */ }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
const rnd = (a, b) => a + Math.random() * (b - a);

// ---- graph -------------------------------------------------------------------
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
    master.gain.value = prefs.muted ? 0 : 1;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = prefs.sfx;
    sfxBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = musicLevel();
    musicBus.connect(master);
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

function musicLevel() { return prefs.music * (bossMode ? 1 : CALM_MUSIC_MUL); }

// Setting a level while muted clears the mute: dragging a slider and hearing
// nothing is the kind of thing a player reads as a broken game. Returns true
// when it actually cleared one, so the caller knows to repaint the HUD button.
function unmute() {
  if (!prefs.muted) return false;
  prefs.muted = false;
  savePrefs();
  rampBus(master, 1, 0.03);
  return true;
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

// ---- loading -----------------------------------------------------------------
// Decoded buffers land in `buffers`; a sound that is asked for before its file
// arrives is SKIPPED rather than queued. Queueing would fire a clank a second
// late, and every effect is preloaded on unlock anyway, so this only ever
// affects the first moments of a session.
//
// A failed load stays in `pending` as a settled promise ON PURPOSE. Dropping
// it would look like "not loaded yet" to the next shot, and the next shot is
// 50 ms away — a missing file would turn into a fetch twenty times a second.
function load(name) {
  if (!ctx) return Promise.resolve(null);
  if (buffers.has(name)) return Promise.resolve(buffers.get(name));
  const inFlight = pending.get(name);
  if (inFlight) return inFlight;

  const p = fetch(`${BASE}${name}.m4a`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((data) => ctx.decodeAudioData(data))
    .then((buf) => {
      buffers.set(name, buf);
      return buf;
    })
    .catch((err) => {
      if (!warned) {
        warned = true;
        console.warn(`MAXGEAR audio: "${name}" unavailable — the game runs silent`, err);
      }
      return null;
    });
  pending.set(name, p);
  return p;
}

// ---- playback ----------------------------------------------------------------
// One voice. `gain` scales the balance already baked into the file by the
// Sonic Pi `amp:` opts, `rate` shifts pitch and length together.
function play(name, gain, rate) {
  if (prefs.muted || !ctx) return;
  const buf = buffers.get(name);
  if (!buf) { load(name); return; }
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (rate && rate !== 1) src.playbackRate.value = rate;
    if (gain != null && gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(sfxBus);
    } else {
      src.connect(sfxBus);
    }
    src.start();
  } catch (e) { /* audio is never critical */ }
}

// ---- music -------------------------------------------------------------------
// Some decoders keep the AAC encoder's priming silence at the head of the
// buffer; loop around it rather than through it.
function firstSound(buffer) {
  const data = buffer.getChannelData(0);
  const limit = Math.min(data.length, buffer.sampleRate * 0.2);
  for (let i = 0; i < limit; i++) if (Math.abs(data[i]) > 1e-4) return i / buffer.sampleRate;
  return 0;
}

// One bed, looped whole. The theme fades out on its own at the end, so the
// restart reads as the band organ taking the tune from the top — and at three
// minutes against a three-to-four minute level, most runs never hear the seam.
function startMusic() {
  if (!ctx || musicNode) return;
  const buf = buffers.get(MUSIC);
  if (!buf) { load(MUSIC); return; }
  try {
    const src = ctx.createBufferSource();
    const start = firstSound(buf);
    src.buffer = buf;
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = buf.duration;
    src.connect(musicBus);
    src.start(0, start);
    musicNode = src;
  } catch (e) { musicNode = null; }
}

// ---- public API --------------------------------------------------------------
// Throttles and cluster detection, carried over from the synthesised version:
// at extreme fire rates the shot tick is dropped outright, and a blast landing
// on top of another one loses its tail so chain reactions never pile into mush.
let lastShoot = 0;
let shootAlt = false;   // flips per shot: the two halves of "pew-pew"
let lastCharge = 0;
let lastHit = 0;
let lastDie = 0;
let lastBoom = 0;

export const audio = {
  unlock() {
    if (!ensure()) return;
    // Effects first, bed second. The thirteen effects come to 168 KB against
    // the theme's 3 MB, and a player who taps straight through to a run must
    // not be waiting on the music to hear their own gun.
    Promise.all(EFFECTS.map((name) => load(name)))
      .then(() => load(MUSIC))
      .then(startMusic);
  },

  toggleMute() {
    prefs.muted = !prefs.muted;
    savePrefs();
    rampBus(master, prefs.muted ? 0 : 1, 0.03);
    return prefs.muted;
  },
  isMuted() { return prefs.muted; },

  // ---- the two sliders (sound board) ----
  // The setters return true when the move cleared a mute; ui.js repaints the
  // HUD button on that. See unmute() above for why they do it at all.
  musicVolume() { return prefs.music; },
  sfxVolume() { return prefs.sfx; },

  setMusicVolume(v) {
    prefs.music = clamp01(v);
    savePrefs();
    rampBus(musicBus, musicLevel(), 0.05);
    return unmute();
  },

  setSfxVolume(v) {
    prefs.sfx = clamp01(v);
    savePrefs();
    rampBus(sfxBus, prefs.sfx, 0.05);
    return unmute();
  },

  // Music intensity switch — safe to call every frame (ignores no-op changes).
  setBossMode(on) {
    const v = !!on;
    if (v === bossMode) return;
    bossMode = v;
    rampBus(musicBus, musicLevel(), 0.45);
  },

  shoot() {
    if (prefs.muted || !ctx) return;
    const t = ctx.currentTime;
    const gap = t - lastShoot;
    if (gap < 0.045) return;               // hard throttle at extreme fire rates
    lastShoot = t;
    // Overlapping shots sum, so the level comes down as the rate climbs — as a
    // ramp, not a cliff. The synthesised version cut to 0.45 the moment the gap
    // fell under 130 ms, which is exactly where fireRate LV4 lands: upgrading
    // the gun made it 7 dB quieter, a downgrade you can hear. The ramp is
    // gentle because the pew earns it — 110 ms with nothing below 150 Hz barely
    // overlaps even at fourteen shots a second, and has no bass to pile up.
    const soft = gap >= 0.15 ? 1 : Math.max(0.7, gap / 0.15);
    // pew-PEW: successive shots sit a whole tone apart, so a fast stream reads
    // as a rhythm rather than one sample stuttering. The jitter on top is under
    // a semitone — enough that the alternation never sounds mechanical, small
    // enough that the alternation is still what you hear.
    shootAlt = !shootAlt;
    play('shoot', 0.95 * soft, (shootAlt ? 1.06 : 0.944) * rnd(0.985, 1.015));
  },

  hit() {
    if (prefs.muted || !ctx) return;
    const t = ctx.currentTime;
    const dense = t - lastHit < 0.05;
    lastHit = t;
    play('hit', dense ? 0.6 : 1, rnd(0.88, 1.16));
  },

  enemyDie() {
    if (prefs.muted || !ctx) return;
    const t = ctx.currentTime;
    const dense = t - lastDie < 0.06;
    lastDie = t;
    play('enemy-die', dense ? 0.65 : 1, rnd(0.9, 1.12));
  },

  explode() {
    if (prefs.muted || !ctx) return;
    const t = ctx.currentTime;
    const dense = t - lastBoom < 0.09;
    lastBoom = t;
    play('explode', dense ? 0.55 : 1, rnd(0.9, 1.08));
  },

  hurt() { play('hurt', 1, rnd(0.96, 1.04)); },

  pickup() { play('pickup', 1, rnd(0.97, 1.05)); },

  gateGood() { play('gate-good', 1, 1); },

  gateBad() { play('gate-bad', 1, rnd(0.97, 1.03)); },

  // A chargeable gate got shot. `progress` (0..1) plays the strike back faster,
  // so pumping a gate reads as a rising ladder — a fifth from empty to full.
  gateCharge(progress) {
    if (prefs.muted || !ctx) return;
    const t = ctx.currentTime;
    if (t - lastCharge < 0.035) return;
    lastCharge = t;
    const p = clamp01(typeof progress === 'number' ? progress : 0);
    play('gate-charge', 1, (1 + p * 0.5) * rnd(0.98, 1.02));
  },

  bossRoar() { play('boss-roar', 1, rnd(0.98, 1.02)); },

  win() { play('win', 1, 1); },

  lose() { play('lose', 1, 1); },

  click() { play('click', 1, rnd(0.96, 1.06)); },
};
