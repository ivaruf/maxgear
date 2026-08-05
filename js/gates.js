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
// STEAMPUNK: the gate is brass-framed apparatus holding a smoked-glass panel.
// The KIND COLOURS (green/red/purple/gold) are gameplay information and keep
// their exact hexes and alphas — only the materials around them changed.
const GATE_H = 62;      // panel height, world units
const GATE_POST = 6;    // frame thickness, world units
const MIN_LABEL_PX = 11;

const TAU = Math.PI * 2;
// Material palette (draw-only, from DESIGN.md "Visual direction").
const IRON = '#1a1512';
const BRASS = '#c9973b';
const BRASS_HI = '#f0b429';
const BRASS_LO = '#6f5220';
const RIVET_DARK = 'rgba(44,30,11,0.78)';
const ENAMEL = '#efe3c8';       // gauge dial face

// Pressure-gauge sweep: lower-left -> over the top -> lower-right (252 deg).
const GAUGE_A0 = Math.PI * 0.8;
const GAUGE_SPAN = Math.PI * 1.4;

// Cog silhouette baked ONCE at unit radius and scaled at draw time (perf: no
// per-frame path building). Path2D is guarded so this module still imports in a
// non-DOM context (module parse checks); the fallback is a plain disc.
function cogPath(teeth, rTip, rRoot, rHole) {
  const p = new Path2D();
  const step = TAU / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const a0 = a - step * 0.32, a1 = a - step * 0.15;
    const a2 = a + step * 0.15, a3 = a + step * 0.32;
    p[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a0) * rRoot, Math.sin(a0) * rRoot);
    p.lineTo(Math.cos(a1) * rTip, Math.sin(a1) * rTip);
    p.lineTo(Math.cos(a2) * rTip, Math.sin(a2) * rTip);
    p.lineTo(Math.cos(a3) * rRoot, Math.sin(a3) * rRoot);
  }
  p.closePath();
  if (rHole > 0) {              // reverse-wound subpath = hub hole
    p.moveTo(rHole, 0);
    p.arc(0, 0, rHole, 0, TAU, true);
    p.closePath();
  }
  return p;
}
const COG = typeof Path2D !== 'undefined' ? cogPath(9, 1, 0.72, 0.3) : null;

// Gear ornament: fill + axle. rot comes from game.time (never Date.now()).
function drawCog(ctx, x, y, r, rot) {
  if (r < 1.2) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(r, r);
  ctx.fillStyle = BRASS;
  if (COG) ctx.fill(COG);
  else { ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill(); }
  ctx.lineWidth = 0.13;
  ctx.strokeStyle = 'rgba(30,20,8,0.55)';
  if (COG) ctx.stroke(COG);
  ctx.restore();
  ctx.fillStyle = BRASS_HI;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.2, 0, TAU);
  ctx.fill();
}

// Domed brass rivet.
function rivet(ctx, x, y, r) {
  ctx.fillStyle = RIVET_DARK;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = BRASS_HI;
  ctx.beginPath();
  ctx.arc(x - r * 0.2, y - r * 0.24, r * 0.52, 0, TAU);
  ctx.fill();
}

// Evenly spaced rivet column down a post (count bounded for perf).
function rivetsV(ctx, x, yTop, yBot, r, maxN) {
  if (r < 0.7) return;
  const span = yBot - yTop;
  const n = Math.min(maxN, Math.max(2, Math.floor(span / (r * 8))));
  for (let i = 0; i < n; i++) rivet(ctx, x, yTop + (span * (i + 0.5)) / n, r);
}

// Brass tube/plate look from flat fills (no gradient allocation per frame).
function brassBar(ctx, x, y, w, h, vertical) {
  ctx.fillStyle = BRASS_LO;
  ctx.fillRect(x, y, w, h);
  if (vertical) {
    ctx.fillStyle = BRASS;
    ctx.fillRect(x + w * 0.16, y, w * 0.66, h);
    ctx.fillStyle = BRASS_HI;
    ctx.fillRect(x + w * 0.26, y, Math.max(0.8, w * 0.18), h);
  } else {
    ctx.fillStyle = BRASS;
    ctx.fillRect(x, y + h * 0.16, w, h * 0.66);
    ctx.fillStyle = BRASS_HI;
    ctx.fillRect(x, y + h * 0.24, w, Math.max(0.8, h * 0.18));
  }
}

// Pressure gauge mounted on the top beam of a chargeable gate: the needle
// sweeps 0 -> max exactly like the sight-glass fill below it.
function gaugeDial(ctx, cx, cy, r, prog, needle) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = ENAMEL;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.26);
  ctx.strokeStyle = BRASS;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(28,20,9,0.75)';
  ctx.lineWidth = Math.max(0.8, r * 0.11);
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const a = GAUGE_A0 + (i / 4) * GAUGE_SPAN;
    const c = Math.cos(a), s = Math.sin(a);
    ctx.moveTo(cx + c * r * 0.54, cy + s * r * 0.54);
    ctx.lineTo(cx + c * r * 0.82, cy + s * r * 0.82);
  }
  ctx.stroke();
  const a = GAUGE_A0 + prog * GAUGE_SPAN;
  ctx.strokeStyle = needle;
  ctx.lineWidth = Math.max(1, r * 0.17);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * r * 0.76, cy + Math.sin(a) * r * 0.76);
  ctx.stroke();
  ctx.fillStyle = IRON;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0.8, r * 0.15), 0, TAU);
  ctx.fill();
}

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

  // --- smoked glass panel ---------------------------------------------------
  // Faint soot wash under the tint = "smoked glass". The kind-colour gradient
  // keeps its original stops/alphas so the distance read is unchanged.
  ctx.fillStyle = 'rgba(15,12,9,0.20)';
  ctx.fillRect(x0, y0, w, h * 0.55);
  ctx.fillStyle = 'rgba(15,12,9,0.09)';
  ctx.fillRect(x0, y0 + h * 0.55, w, h * 0.45);

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
    // Brass mullion splitting the two chambers of the trade-off.
    brassBar(ctx, x0, y0 + h * 0.5 - Math.max(1, k), w, Math.max(1.5, 2 * k), false);
  }

  // Chargeable: boiler sight-glass. The fill still climbs from the bottom (the
  // long-range "how charged is it" read), now with brass graduation ticks.
  if (slot.chargeable) {
    if (prog > 0) {
      const fh = h * prog;
      ctx.fillStyle = withAlpha(accent, 0.2 + flash * 0.2);
      ctx.fillRect(x0, y1 - fh, w, fh);
      ctx.fillStyle = withAlpha(accent, 0.85);
      ctx.fillRect(x0, y1 - fh, w, Math.max(1.5, 2 * k));   // water line
    }
    // Graduations last so they stay legible through the fill.
    const tickW = Math.max(2, 7 * k);
    ctx.fillStyle = withAlpha(BRASS, 0.8);
    for (let i = 1; i <= 4; i++) {
      const ty = y1 - h * (i / 4);
      const th = Math.max(1, (i === 4 ? 2 : 1.2) * k);
      const tw = i === 4 ? tickW * 1.5 : tickW;
      ctx.fillRect(x0, ty, tw, th);
      ctx.fillRect(R.sx - tw, ty, tw, th);
    }
  }

  // Angled sheen so the panel reads as glass rather than a coloured hole.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.globalAlpha = 0.09 + flash * 0.06;
  ctx.fillStyle = '#fff6e2';
  ctx.beginPath();
  ctx.moveTo(x0 + w * 0.06, y1);
  ctx.lineTo(x0 + w * 0.3, y0);
  ctx.lineTo(x0 + w * 0.42, y0);
  ctx.lineTo(x0 + w * 0.18, y1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Bad gates get hazard stripes across the whole panel — reads as a barrier.
  if (kind === 'bad') hazardStripes(ctx, x0, y0, w, h, k, '#1b0308', 0.5);

  // --- brass frame ----------------------------------------------------------
  // Two LODs: near gates get brass posts/rivets/gears, distant ones keep the
  // original solid coloured frame so the green/red/purple read at the horizon is
  // bit-for-bit what it was (and sub-pixel brass detail is never drawn).
  const pw = Math.max(2, GATE_POST * k);
  const detail = pw >= 3.4;      // rivets/gears/gauge are legible from here in
  if (pw >= 2.6) {
    brassBar(ctx, x0 - pw / 2, y0, pw, h, true);            // left post
    brassBar(ctx, R.sx - pw / 2, y0, pw, h, true);          // right post
    brassBar(ctx, x0 - pw / 2, y0 - pw, w + pw, pw, false); // top beam
    ctx.strokeStyle = 'rgba(24,17,8,0.55)';
    ctx.lineWidth = Math.max(0.8, 0.7 * k);
    ctx.strokeRect(x0 - pw / 2, y0 - pw, w + pw, h + pw);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(x0 - pw / 2, y0, pw, h);
    ctx.fillRect(R.sx - pw / 2, y0, pw, h);
    ctx.fillRect(x0 - pw / 2, y0 - pw, w + pw, pw);
  }

  // Riveted posts + beam corners (near only).
  const rv = pw * 0.22;
  if (detail) {
    rivetsV(ctx, x0, y0 + pw * 0.8, y1 - pw * 0.4, rv, 7);
    rivetsV(ctx, R.sx, y0 + pw * 0.8, y1 - pw * 0.4, rv, 7);
    rivet(ctx, x0, y0 - pw * 0.5, rv);
    rivet(ctx, R.sx, y0 - pw * 0.5, rv);
    rivet(ctx, cx, y0 - pw * 0.5, rv);
  }

  // The kind colour survives as glowing lamp strips down the inner edge of each
  // post plus the beam lip — this is what carries green/red/purple at distance.
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(5, 16 * k);
  ctx.fillStyle = color;
  const lw = Math.max(1.4, pw * 0.46);
  ctx.fillRect(x0 + pw * 0.1, y0, lw, h);
  ctx.fillRect(R.sx - pw * 0.1 - lw, y0, lw, h);
  ctx.fillRect(x0, y0 - Math.max(1.2, pw * 0.22), w, Math.max(1.2, pw * 0.22));
  ctx.restore();

  // Riveted warning plates on the beam for bad gates, bright lip for the rest.
  if (kind === 'bad') {
    hazardStripes(ctx, x0 - pw / 2, y0 - pw, w + pw, pw, k, '#12020a', 0.85);
    if (detail) {
      const plates = 4;
      for (let i = 0; i < plates; i++) {
        rivet(ctx, x0 + (w * (i + 0.5)) / plates, y0 - pw * 0.5, rv * 0.9);
      }
    }
  } else {
    ctx.fillStyle = withAlpha(accent, 0.9);
    ctx.fillRect(x0, y0 - pw, w, Math.max(1, pw * 0.35));
  }

  if (detail) {
    // Gear ornaments on the posts — driven by game.time (+ charge progress so a
    // charging gate visibly ratchets forward). Never Date.now().
    const gt = game.time || 0;
    const gr = pw * 1.45;
    const gy = y0 + gr * 1.15;
    const spin = gt * 0.5 + prog * 0.9;
    drawCog(ctx, x0, gy, gr, spin);
    drawCog(ctx, R.sx, gy, gr, -spin);

    // Pressure gauge on the beam of a chargeable slot: the needle sweeps
    // value -> max exactly like the sight-glass fill below it.
    if (slot.chargeable) {
      const dr = pw * 1.9;
      brassBar(ctx, cx - pw * 0.22, y0 - pw - dr * 0.9, pw * 0.44, dr * 0.9, true);
      gaugeDial(ctx, cx, y0 - pw - dr, dr, prog, maxed ? accent : '#ffd166');
    }
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

  // Engraved nameplate behind the label: dark iron ground (raises text contrast
  // rather than lowering it) with brass edges and corner rivets.
  // (text ink runs from ~top + 0.25em to the last baseline + ~0.2em)
  const plW = Math.min(w * 0.96, maxW + fitted * 0.9);
  const plH = (lines.length - 1) * lh + fitted * 1.36;
  const plX = cx - plW / 2;
  const plY = top + fitted * 0.02;
  ctx.fillStyle = 'rgba(18,14,9,0.34)';
  ctx.fillRect(plX, plY, plW, plH);
  ctx.fillStyle = withAlpha(BRASS, 0.55);
  const edge = Math.max(1, 1.1 * k);
  ctx.fillRect(plX, plY, plW, edge);
  ctx.fillRect(plX, plY + plH - edge, plW, edge);
  const prv = Math.max(1, 1.6 * k);
  if (detail && plW > prv * 8) {
    const inset = prv * 2.2;
    rivet(ctx, plX + inset, plY + inset, prv);
    rivet(ctx, plX + plW - inset, plY + inset, prv);
    rivet(ctx, plX + inset, plY + plH - inset, prv);
    rivet(ctx, plX + plW - inset, plY + plH - inset, prv);
  }

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
