// Upgrade definitions + gate rows. UPGRADE-AGENT OWNS THIS FILE.
// A gate row = 1-2 slots at the same z. Crossing a slot applies its upgrade
// and consumes the row. Chargeable slots gain value when shot (gateOnShot).

import { ROAD_HALF } from './config.js';
import { clamp } from './utils.js';
import { project } from './render.js';
import { clampStats } from './player.js';
import { healPlayer, damagePlayer } from './player.js';
import { fx } from './effects.js';
import { audio } from './audio.js';

export const GATE_COLORS = { good: '#3ddc84', bad: '#ff4d5a', mixed: '#c77dff' };
const GATE_ACCENT = { good: '#a9ffd6', bad: '#ffc2c7', mixed: '#ecc9ff' };
// Label tints for the two halves of a mixed (trade-off) gate.
const MIXED_UP = '#a9ffd6';
const MIXED_DOWN = '#ff9ba3';

// ---- local sanity limits ----------------------------------------------------
// CAPS (config.js) covers damage/projectiles/fireInterval/pierce/ricochet/crit/
// squad/moveSpeed. These four stats have no cap there, so stacking is bounded
// here instead of raising anything in CAPS. See notes in the handoff.
const SPREAD_MAX = 26;        // deg — beyond this the volley stops hitting anything
const EXPLOSIVE_MAX = 3;      // blast radius = 70 + level * 20 (collisions.js)
const MAGNET_MAX = 600;       // magnet radius = 60 + magnet (pickups.js)
const FIRE_INTERVAL_MAX = 0.9; // s — floor on how badly loseFireRate can gut dps
const MAXHP_FLOOR = 30;       // maxHp can never be traded below this

const CHARGE_FLASH = 0.12;    // s of pulse after a charging hit

// Shrink max HP (or grow it) and keep current hp inside the new ceiling.
function addMaxHp(game, delta) {
  const p = game.player;
  p.maxHp = Math.max(MAXHP_FLOOR, Math.round(p.maxHp + delta));
  p.hp = Math.min(p.hp, p.maxHp);
}

function addExplosive(game, n) {
  const s = game.player.stats;
  s.explosive = clamp(s.explosive + n, 0, EXPLOSIVE_MAX);
}

// value flows: base -> (chargeable: +chargeStep per hit, capped at max) -> apply(game, value)
// apply() receives the rounded slot value and mutates player.stats (or the
// heal/damage helpers) only; applyGateSlot() runs clampStats() right after.
export const UPGRADES = {
  // ---- good ---------------------------------------------------------------
  damage: {
    kind: 'good', base: 10, chargeable: true, chargeStep: 1, max: 40,
    label: (v) => `+${v} DMG`,
    apply: (game, v) => { game.player.stats.damage += v; },
  },
  fireRate: {
    kind: 'good', base: 25, chargeable: true, chargeStep: 1, max: 60,
    label: (v) => `+${v}% FIRE RATE`,
    apply: (game, v) => { game.player.stats.fireInterval /= 1 + v / 100; },
  },
  multishot: {
    kind: 'good', base: 1,
    label: (v) => `+${v} SHOT${v > 1 ? 'S' : ''}`,
    apply: (game, v) => { game.player.stats.projectiles += v; },
  },
  squad: {
    kind: 'good', base: 1, chargeable: true, chargeStep: 0.08, max: 3,
    label: (v) => `+${Math.floor(v)} ALL${Math.floor(v) > 1 ? 'IES' : 'Y'}`,
    apply: (game, v) => { game.player.stats.squad += Math.floor(v); },
  },
  heal: {
    kind: 'good', base: 30,
    label: (v) => `HEAL ${v}`,
    apply: (game, v) => healPlayer(game, v),
  },
  maxHp: {
    kind: 'good', base: 25,
    label: (v) => `+${v} MAX HP`,
    apply: (game, v) => { addMaxHp(game, v); healPlayer(game, v); },
  },
  pierce: {
    kind: 'good', base: 1,
    label: (v) => `+${v} PIERCE`,
    apply: (game, v) => { game.player.stats.pierce += v; },
  },
  explosive: {
    kind: 'good', base: 1,
    label: () => 'EXPLOSIVE SHOTS',
    apply: (game) => addExplosive(game, 1),
  },
  crit: {
    kind: 'good', base: 15,
    label: (v) => `+${v}% CRIT`,
    apply: (game, v) => { game.player.stats.critChance += v / 100; },
  },
  ricochet: {
    kind: 'good', base: 1,
    label: (v) => `+${v} RICOCHET`,
    apply: (game, v) => { game.player.stats.ricochet += v; },
  },
  spread: {
    // QA-measured: WIDER spread is always a DPS loss, so the "good" version
    // tightens the volley (label matches the ui.js end-screen chip logic too)
    kind: 'good', base: 4,
    label: () => 'TIGHTER SPREAD',
    apply: (game, v) => {
      const s = game.player.stats;
      s.spreadDeg = clamp(s.spreadDeg - v, 2, SPREAD_MAX);
    },
  },
  moveSpeed: {
    kind: 'good', base: 20,
    label: (v) => `+${v}% MOVE SPEED`,
    apply: (game, v) => { game.player.stats.moveSpeed *= 1 + v / 100; },
  },
  magnet: {
    kind: 'good', base: 120,
    label: (v) => `+${v} MAGNET`,
    apply: (game, v) => {
      const s = game.player.stats;
      s.magnet = clamp(s.magnet + v, 0, MAGNET_MAX);
    },
  },

  // ---- bad ----------------------------------------------------------------
  hurt: {
    kind: 'bad', base: 20,
    label: (v) => `-${v} HP`,
    apply: (game, v) => damagePlayer(game, v, true),
  },
  loseDamage: {
    kind: 'bad', base: 25,
    label: (v) => `-${v}% DMG`,
    apply: (game, v) => { game.player.stats.damage *= 1 - v / 100; },
  },
  loseFireRate: {
    kind: 'bad', base: 25,
    label: (v) => `-${v}% FIRE RATE`,
    apply: (game, v) => {
      const s = game.player.stats;
      s.fireInterval = Math.min(s.fireInterval * (1 + v / 100), FIRE_INTERVAL_MAX);
    },
  },

  // ---- trade-offs (label shows BOTH sides, split on ' / ' when drawn) ------
  tradeSprayPray: {
    kind: 'mixed', base: 2,
    label: (v) => `+${v} SHOTS / -25% DMG`,
    apply: (game, v) => {
      const s = game.player.stats;
      s.projectiles += v;
      s.damage *= 0.75;
    },
  },
  tradeGlassCannon: {
    kind: 'mixed', base: 60,
    label: (v) => `+${v}% DMG / -25 MAX HP`,
    apply: (game, v) => {
      game.player.stats.damage *= 1 + v / 100;
      addMaxHp(game, -25);
    },
  },
  tradeBlastRisk: {
    kind: 'mixed', base: 20,
    label: (v) => `EXPLOSIVE / -${v} HP`,
    apply: (game, v) => {
      addExplosive(game, 1);
      damagePlayer(game, v, true);
    },
  },
};

// ---- slot geometry ----------------------------------------------------------
// Two slots cover the road halves with a dead gap around x = 0 so the player can
// deliberately thread the middle and take neither. collisions.js widens the test
// band by player.radius * 0.5 (= 8), so the *effective* bands are
// [-202, -10] and [+10, +202]: full road coverage outward, 20u of dead centre.
const SLOT_TWO_HALF_W = ROAD_HALF * 0.44;   // 88
const SLOT_TWO_CENTER = ROAD_HALF * 0.53;   // +/-106
const SLOT_ONE_HALF_W = ROAD_HALF * 0.85;   // 170: single gates (tutorial charge
// gates) are near-unmissable — QA showed accidentally dodging them makes the
// first-third difficulty spike unfair

// Spawn a row of gate slots. defs: [{key, value?}] length 1-2.
export function spawnGateRow(game, z, defs) {
  const n = defs.length;
  const slots = defs.map((d, i) => {
    const up = UPGRADES[d.key];
    if (!up) { console.error(`Unknown upgrade: ${d.key}`); return null; }
    const halfW = n === 1 ? SLOT_ONE_HALF_W : SLOT_TWO_HALF_W;
    const x = n === 1 ? 0 : (i === 0 ? -SLOT_TWO_CENTER : SLOT_TWO_CENTER);
    const value = d.value ?? up.base;
    return {
      key: d.key, up,
      x, halfW,
      value,
      base: value,          // charge progress is measured from here
      chargeable: !!up.chargeable,
      chargeProgress: 0,
      hitFlash: 0,
    };
  }).filter(Boolean);
  game.gates.push({ z, slots, used: false, dead: false });
}

export function updateGates(game, dt) {
  for (const g of game.gates) {
    for (const s of g.slots) s.hitFlash = Math.max(0, s.hitFlash - dt);
    if (g.z < game.player.z - 40) g.dead = true;
  }
}

// Projectile hit a chargeable slot (called from collisions.js)
export function gateOnShot(game, gate, slot) {
  if (!slot.chargeable || gate.used) return;
  const up = slot.up;
  slot.chargeProgress += up.chargeStep;
  slot.value = clamp(slot.value + up.chargeStep, 0, up.max ?? Infinity);
  slot.hitFlash = CHARGE_FLASH;
  audio.gateCharge?.(up.max ? (slot.value - up.base) / (up.max - up.base) : 0);
}

// Player crossed a slot (called from collisions.js). Exactly one slot per row:
// the row is consumed here and the bands never overlap (see slot geometry).
export function applyGateSlot(game, gate, slot) {
  if (gate.used) return;
  gate.used = true;
  gate.dead = true;
  const v = Math.round(slot.value);
  const label = slot.up.label(v);
  slot.up.apply(game, v);
  clampStats(game.player.stats);
  const color = GATE_COLORS[slot.up.kind];
  fx.gateBurst?.(game.player.x, gate.z, color);
  fx.textPop(game.player.x, game.player.z + 60, label, color);
  fx.flash(color, 0.12, 0.3);
  if (slot.up.kind === 'bad') { audio.gateBad(); fx.shake(5, 0.22); }
  else audio.gateGood();
  game.lastUpgrade = { label, kind: slot.up.kind };
}

// ---- drawing ---------------------------------------------------------------
const GATE_H = 62;      // panel height, world units
const GATE_POST = 6;    // frame thickness, world units
const MIN_LABEL_PX = 11;

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function chargeFraction(slot) {
  if (!slot.chargeable) return 0;
  const max = slot.up.max;
  if (max == null) return 0;
  const span = max - slot.base;
  if (span <= 0) return 1;
  return clamp((slot.value - slot.base) / span, 0, 1);
}

// Diagonal hazard stripes clipped to a rect — the "do not enter" read.
function hazardStripes(ctx, x, y, w, h, k, color, alpha) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, 6 * k);
  const step = Math.max(9, 22 * k);
  for (let sx = x - h; sx < x + w + h; sx += step) {
    ctx.beginPath();
    ctx.moveTo(sx, y + h);
    ctx.lineTo(sx + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

// Bold text with a dark outline, auto-shrunk to fit maxW but never below min.
function drawFittedLabel(ctx, text, cx, baseY, size, maxW, fill) {
  let fs = size;
  ctx.font = `900 ${fs}px sans-serif`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    fs = Math.max(MIN_LABEL_PX, (fs * maxW) / w);
    ctx.font = `900 ${fs}px sans-serif`;
  }
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(2, fs * 0.18);
  ctx.strokeStyle = 'rgba(5,7,16,0.92)';
  ctx.strokeText(text, cx, baseY);
  ctx.fillStyle = fill;
  ctx.fillText(text, cx, baseY);
  return fs;
}

function drawSlot(ctx, view, game, gate, slot) {
  const up = slot.up;
  const kind = up.kind;
  const color = up.color || GATE_COLORS[kind] || GATE_COLORS.good;
  const accent = GATE_ACCENT[kind] || color;

  const L = project(view, slot.x - slot.halfW, gate.z);
  const R = project(view, slot.x + slot.halfW, gate.z);
  const k = L.f * view.unitScale;          // px per world unit at this depth
  const w = R.sx - L.sx;
  if (!(w > 2) || !(k > 0)) return;

  const h = GATE_H * k;
  const x0 = L.sx, y1 = L.sy, y0 = y1 - h;
  const cx = (L.sx + R.sx) / 2;
  const flash = clamp(slot.hitFlash / CHARGE_FLASH, 0, 1);
  const prog = chargeFraction(slot);
  const maxed = slot.chargeable && up.max != null && slot.value >= up.max - 1e-6;

  ctx.save();
  // Brief pop about the bottom-centre when a shot charges this slot.
  if (flash > 0) {
    const pulse = 1 + flash * 0.12;
    ctx.translate(cx, y1);
    ctx.scale(pulse, pulse);
    ctx.translate(-cx, -y1);
  }
  ctx.textAlign = 'center';

  // --- glass panel ---------------------------------------------------------
  const panel = ctx.createLinearGradient(0, y0, 0, y1);
  panel.addColorStop(0, withAlpha(color, 0.08 + flash * 0.18));
  panel.addColorStop(1, withAlpha(color, 0.32 + flash * 0.26));
  ctx.fillStyle = panel;
  ctx.fillRect(x0, y0, w, h);

  // Mixed: faint good wash on the upper half, bad wash on the lower half so the
  // two sides of the trade read even before the label is legible.
  if (kind === 'mixed') {
    ctx.fillStyle = withAlpha(GATE_COLORS.good, 0.1);
    ctx.fillRect(x0, y0, w, h * 0.5);
    ctx.fillStyle = withAlpha(GATE_COLORS.bad, 0.12);
    ctx.fillRect(x0, y0 + h * 0.5, w, h * 0.5);
  }

  // Chargeable: the panel fills from the bottom as value climbs to max.
  if (slot.chargeable && prog > 0) {
    const fh = h * prog;
    ctx.fillStyle = withAlpha(accent, 0.2 + flash * 0.2);
    ctx.fillRect(x0, y1 - fh, w, fh);
    ctx.fillStyle = withAlpha(accent, 0.85);
    ctx.fillRect(x0, y1 - fh, w, Math.max(1.5, 2 * k));
  }

  // Bad gates get hazard stripes across the whole panel — reads as a barrier.
  if (kind === 'bad') hazardStripes(ctx, x0, y0, w, h, k, '#1b0308', 0.5);

  // --- frame ---------------------------------------------------------------
  const pw = Math.max(2, GATE_POST * k);
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(5, 16 * k);
  ctx.fillStyle = color;
  ctx.fillRect(x0 - pw / 2, y0, pw, h);              // left post
  ctx.fillRect(R.sx - pw / 2, y0, pw, h);            // right post
  ctx.fillRect(x0 - pw / 2, y0 - pw, w + pw, pw);    // top beam
  ctx.restore();

  // Hazard chevrons on the beam for bad gates, bright lip for the rest.
  if (kind === 'bad') {
    hazardStripes(ctx, x0 - pw / 2, y0 - pw, w + pw, pw, k, '#12020a', 0.85);
  } else {
    ctx.fillStyle = withAlpha(accent, 0.9);
    ctx.fillRect(x0, y0 - pw, w, Math.max(1, pw * 0.35));
  }

  // Crossing line on the asphalt so the commit point is unambiguous.
  ctx.fillStyle = withAlpha(accent, 0.75);
  ctx.fillRect(x0, y1 - Math.max(1, 1.5 * k), w, Math.max(2, 3 * k));

  // --- label ---------------------------------------------------------------
  const raw = up.label(Math.round(slot.value));
  let lines, tints;
  if (kind === 'mixed' && raw.includes('/')) {
    lines = raw.split('/').map((t) => t.trim());
    tints = [MIXED_UP, MIXED_DOWN];
  } else if (kind === 'bad') {
    lines = [`⚠ ${raw} ⚠`];
    tints = ['#ffffff'];
  } else {
    lines = [raw];
    tints = ['#ffffff'];
  }

  const size = Math.max(MIN_LABEL_PX + 2, 26 * k) * (1 + flash * 0.1);
  const maxW = w * 0.9;
  // Pre-fit every line to a shared size so multi-line labels stay aligned.
  let fitted = size;
  for (const line of lines) {
    ctx.font = `900 ${size}px sans-serif`;
    const tw = ctx.measureText(line).width;
    if (tw > maxW) fitted = Math.min(fitted, Math.max(MIN_LABEL_PX, (size * maxW) / tw));
  }
  const lh = fitted * 1.06;
  const centerY = y1 - h * 0.56;
  const top = centerY - (lines.length * lh) / 2;
  for (let i = 0; i < lines.length; i++) {
    drawFittedLabel(ctx, lines[i], cx, top + fitted + i * lh, fitted, maxW, tints[i] || '#ffffff');
  }
  // Divider between the two halves of a trade-off label.
  if (lines.length === 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(cx - maxW * 0.28, top + lh - fitted * 0.18, maxW * 0.56, Math.max(1, 1.2 * k));
  }

  // --- shoot-me marker (chargeable slots only) -----------------------------
  if (slot.chargeable) {
    const fs2 = Math.max(9, fitted * 0.46);
    ctx.font = `700 ${fs2}px sans-serif`;
    ctx.lineWidth = Math.max(1.5, fs2 * 0.22);
    ctx.strokeStyle = 'rgba(5,7,16,0.9)';
    const tag = maxed ? 'MAX' : '⌖ SHOOT ME';
    const ty = y1 - h * 0.12;
    ctx.strokeText(tag, cx, ty);
    ctx.fillStyle = maxed ? accent : '#ffd166';
    ctx.fillText(tag, cx, ty);
  }

  ctx.restore();
}

export function drawGates(ctx, view, game) {
  const sorted = [...game.gates].sort((a, b) => b.z - a.z);
  for (const g of sorted) {
    if (g.dead) continue;
    if (g.z < view.camZ + 8) continue;   // behind/under the camera: skip
    for (const s of g.slots) drawSlot(ctx, view, game, g, s);
  }
}
