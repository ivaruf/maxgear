// Gate rows: the physical apparatus that delivers upgrades. GATE-AGENT OWNS THIS FILE.
//
// v1.2 LEVEL-TRACK REWORK. The upgrade ROSTER and every stat semantic now live
// in upgrades.js; this file owns geometry, charging, the apply hand-off and the
// drawing. It contains NO upgrade tables and NO stat maths.
//
// A gate row = 1-2 slots at the same z. Crossing a slot applies its upgrade and
// consumes the row. Shooting a slot CHARGES it: 14 hits = +1 level.
//
// ---------------------------------------------------------------------------
// SLOT CONTRACT (level.js emits {key, levels, levelCap} -> spawnGateRow)
// ---------------------------------------------------------------------------
//   key         upgrades.js ENTRIES key
//   up          ENTRIES[key] (re-pointed if a preview re-resolve swaps the key)
//   x, halfW    crossing band (collisions.js widens by player.radius * 0.5)
//   levels      SIGNED levels granted on cross. good/mixed 1..3, bad -1/-2,
//               instants 1. Charging always does `levels += 1`, so a bad slot
//               charges UP toward 0 == DEFUSED.
//   levels0     levels at spawn — the gauge/pip maths measures from here
//   levelCap    levels stop here (bad slots: 0)
//   charge      0..1 progress to the NEXT level step (sight-glass fill)
//   chargeable  === levels < levelCap. collisions.js guards on this field, so
//               it is refreshed in gateOnShot() AND updateGates() every frame.
//   hitFlash    s of charge-pop left
//   previewKey / previewName / previewFrom / previewTo
//               cached previewSlot() result: what this slot WOULD do right now
//               ('rust' resolves your best offensive track live). drawSlot() and
//               ui.js read the cache, never previewSlot() directly.
//
// One rule for everything: chargeable <=> levels < levelCap.
// A bad slot at levels === 0 is DEFUSED: crossing it is a no-op.

import { ROAD_HALF } from './config.js';
import { clamp } from './utils.js';
import { project } from './render.js';
import { clampStats } from './player.js';
import { healPlayer, damagePlayer } from './player.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import {
  ENTRIES, applyUpgrade, previewSlot, slotLabel, isOffered, bestTrack,
} from './upgrades.js';
import { drawIcon, drawArrow } from './icons.js';

// Back-compat alias: the roster is upgrades.js ENTRIES now. Nothing outside
// this file imports UPGRADES any more (checked: level.js/ui.js use upgrades.js
// directly) — kept only so a stale import cannot silently become undefined.
export const UPGRADES = ENTRIES;

// Aged-enamel hues (v1.1.1): hue identity stays load-bearing (green = good,
// red = bad, purple = trade-off) but desaturated/warmed to sit in the brass world.
export const GATE_COLORS = { good: '#56b06c', bad: '#d2513c', mixed: '#a97bd1' };
const GATE_ACCENT = { good: '#b9e3c4', bad: '#eec3b4', mixed: '#dcc6ee' };
// Label tints for the two halves of a mixed (trade-off) gate.
const MIXED_UP = '#b9e3c4';
const MIXED_DOWN = '#e59a84';
// A DEFUSED bad gate is inert scrap: neutral iron, no hue, no hazard read.
const DEFUSED_COLOR = '#6d675e';
const DEFUSED_ACCENT = '#a9a29a';

// ---- charging ---------------------------------------------------------------
const CHARGE_HITS = 14;               // shots per +1 level (design §B)
const CHARGE_STEP = 1 / CHARGE_HITS;
// 14 * (1/14) sums to 0.9999999999999998 in binary floating point, so the step
// test needs slack or the 14th hit silently does nothing.
const CHARGE_EPS = 1e-6;
const CHARGE_FLASH = 0.12;            // s of pulse after a charging hit
const LEVEL_FLASH = 0.26;             // …bigger pop when a level actually lands

// ---- preview ----------------------------------------------------------------
const PREVIEW_AHEAD = 1400;           // refresh the cache inside this range
const RESOLVE_LOCK = 700;             // closer than this, the key is committed

// upgrades.js is game-import free by design: it takes its side effects from us.
const HOST = Object.freeze({ healPlayer, damagePlayer });

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

// A bad slot charged all the way to its cap (0) is harmless.
export const isDefused = (slot) => slot.up.kind === 'bad' && slot.levels === 0;

// Spawn a row of gate slots. defs: [{ key, levels, levelCap }] length 1-2,
// straight out of level.js resolveGateDefs().
export function spawnGateRow(game, z, defs) {
  const n = defs.length;
  const slots = defs.map((d, i) => {
    const up = ENTRIES[d.key];
    if (!up) { console.error(`Unknown upgrade: ${d.key}`); return null; }
    const halfW = n === 1 ? SLOT_ONE_HALF_W : SLOT_TWO_HALF_W;
    const x = n === 1 ? 0 : (i === 0 ? -SLOT_TWO_CENTER : SLOT_TWO_CENTER);
    const levels = Math.round(d.levels ?? 1);
    const levelCap = Math.round(d.levelCap ?? levels);
    const slot = {
      key: d.key, up,
      x, halfW,
      levels,
      levels0: levels,          // gauge/pip baseline — never mutated
      levelCap,
      charge: 0,
      chargeable: levels < levelCap,
      hitFlash: 0,
      previewKey: null, previewName: null, previewFrom: null, previewTo: null,
    };
    // distance 0 = "cache the preview, do NOT re-resolve": level.js already
    // filtered maxed keys when it picked this one, so the key is authoritative
    // at spawn. Re-resolution is only ever about the world changing later.
    refreshPreview(game, slot, 0);
    return slot;
  }).filter(Boolean);
  game.gates.push({ z, slots, used: false, dead: false });
}

// ---- preview cache ----------------------------------------------------------
// An '@own'/pool key can be maxed out by an EARLIER gate after this row already
// spawned. While the row is still far away we silently swap in a sane substitute
// (design §B "re-resolve silently"); once it is close the panel is committed to
// the player's eye and we leave it alone — addLevels() clamps a maxed track to a
// no-op at apply time.
function substituteKey(player, slot) {
  if (isOffered(player, slot.key)) return null;
  return bestTrack(player, (key, lv, def) => lv >= 1 && lv < def.maxLv)
    ?? bestTrack(player, (key, lv, def) => lv < def.maxLv)
    ?? 'surplus';
}

function reresolve(game, slot) {
  const key = substituteKey(game.player, slot);
  if (!key || key === slot.key) return;
  const up = ENTRIES[key];
  if (!up) return;
  slot.key = key;
  slot.up = up;
  if (!up.track) {                    // the 'surplus' floor: a fixed one-shot
    slot.levels = Math.max(1, up.slotLevels ?? 1);
    slot.levelCap = Math.max(slot.levels, up.slotLevelCap ?? slot.levels);
    slot.levels0 = slot.levels;
    slot.charge = 0;
  }
  slot.chargeable = slot.levels < slot.levelCap;
}

// Every frame for every gate inside PREVIEW_AHEAD. Pure + allocation-light:
// previewSlot() does no RNG, so calling it per frame is safe.
export function refreshPreview(game, slot, distance = Infinity) {
  const player = game && game.player;
  if (!player) return null;
  if (distance > RESOLVE_LOCK) reresolve(game, slot);
  const pv = previewSlot(player, slot.key, slot.levels);
  slot.previewKey = pv.key;
  slot.previewName = pv.name;
  slot.previewFrom = pv.from;
  slot.previewTo = pv.to;
  return pv;
}

// NOTE ON LEGEND COPY: the words for a slot live in ui.js, which reads this
// slot contract (key/levels/levelCap/chargeable/preview*) plus slotLabel() from
// upgrades.js. gates.js deliberately exports no text formatter — one owner only.

export function updateGates(game, dt) {
  const pz = game.player ? game.player.z : 0;
  for (const g of game.gates) {
    for (const s of g.slots) {
      s.hitFlash = Math.max(0, s.hitFlash - dt);
      // collisions.js guards its charge block on this field: keep it honest.
      s.chargeable = !g.used && !g.dead && s.levels < s.levelCap;
      if (!g.used && !g.dead && g.z - pz < PREVIEW_AHEAD) {
        refreshPreview(game, s, g.z - pz);
      }
    }
    if (g.z < pz - 40) g.dead = true;
  }
}

// Progress from the slot's spawn state to its cap — the pressure-gauge needle.
function gaugeFraction(slot) {
  const span = Math.max(1, slot.levelCap - slot.levels0);
  return clamp((slot.levels - slot.levels0 + slot.charge) / span, 0, 1);
}

// Projectile hit a chargeable slot (called from collisions.js).
// CHARGE_HITS hits = one level step. Bad slots step UP toward 0 (= DEFUSE).
export function gateOnShot(game, gate, slot) {
  if (gate.used || gate.dead) return;
  if (slot.levels >= slot.levelCap) { slot.chargeable = false; return; }
  slot.charge += CHARGE_STEP;
  slot.hitFlash = CHARGE_FLASH;
  if (slot.charge >= 1 - CHARGE_EPS) {
    slot.charge = Math.max(0, slot.charge - 1);
    slot.levels += 1;                 // signed: -2 -> -1 -> 0 for bad slots
    slot.hitFlash = LEVEL_FLASH;      // level-up clunk reads as a bigger pop
    // Pass the real distance: a slot being shot must never re-resolve its key
    // out from under the player mid-charge.
    refreshPreview(game, slot, gate.z - (game.player ? game.player.z : 0));
  }
  slot.chargeable = slot.levels < slot.levelCap;
  if (!slot.chargeable) slot.charge = 0;
  audio.gateCharge?.(gaugeFraction(slot));
}

// Player crossed a slot (called from collisions.js). Exactly one slot per row:
// the row is consumed here and the bands never overlap (see slot geometry).
export function applyGateSlot(game, gate, slot) {
  if (gate.used) return;
  gate.used = true;
  gate.dead = true;

  // Charged all the way out: the hazard is scrap. No penalty, no bad sting —
  // just the confirmation that the shooting paid off.
  if (isDefused(slot)) {
    fx.textPop(game.player.x, game.player.z + 60, 'DEFUSED', DEFUSED_ACCENT);
    return;
  }

  const res = applyUpgrade(game, slot, HOST);
  clampStats(game.player.stats);

  const kind = res ? res.kind : slot.up.kind;
  const label = res ? res.label : slotLabel(game.player, slot.key, slot.levels);
  const color = GATE_COLORS[kind] || GATE_COLORS.good;
  fx.gateBurst?.(game.player.x, gate.z, color);
  fx.textPop(game.player.x, game.player.z + 60, label, color);
  fx.flash(color, 0.12, 0.3);
  if (kind === 'bad') { audio.gateBad(); fx.shake(5, 0.22); }
  else audio.gateGood();
  // ui.js toast + end screen. res.changes/res.name are available from
  // applyUpgrade() if the HUD ever wants the full ledger.
  game.lastUpgrade = {
    label,
    kind,
    key: res ? res.key : slot.key,
    from: res ? res.from : 0,
    to: res ? res.to : 0,
  };
}

// ---- drawing ---------------------------------------------------------------
// STEAMPUNK: the gate is brass-framed apparatus holding a smoked-glass panel.
// The KIND COLOURS (green/red/purple/gold) are gameplay information and keep
// their exact hexes and alphas — only the materials around them changed.
// Glyphs come from icons.js (colored, level-aware); NO WORDS on panels.
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
// sweeps levels0 -> levelCap exactly like the sight-glass fill below it.
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

// Bold outlined number centered at (x, y). Shrinks to fit maxW, never below
// the global minimum so it stays readable at distance.
function numberLabel(ctx, text, x, y, size, tint, maxW) {
  ctx.font = `900 ${size}px sans-serif`;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) {
    size = Math.max(MIN_LABEL_PX, (size * maxW) / tw);
    ctx.font = `900 ${size}px sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.lineWidth = Math.max(1.5, size * 0.16);
  ctx.strokeStyle = 'rgba(10,8,5,0.85)';
  ctx.strokeText(text, x, y + size * 0.36);
  ctx.fillStyle = tint;
  ctx.fillText(text, x, y + size * 0.36);
  return size;
}

const PIP_MAX = 5;
const PIP_OFF = 'rgba(0,0,0,0.45)';
const signed = (n) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);   // U+2212 minus

// The 5-pip level strip on the backing plate — the whole "where am I on this
// track / what does this gate move" read, legible from the horizon inward.
//   owned (0..from)      accent-filled
//   moved by this gate   pulsing white (or bad-red when levels are being taken)
//   the rest             hollow with a brass edge
function pipStrip(ctx, cx, cy, w, h, from, to, maxLevel, accent, time) {
  const n = clamp(Math.round(maxLevel) || PIP_MAX, 1, PIP_MAX);
  const gap = Math.max(0.6, w * 0.07);
  const pw = Math.max(1, (w - gap * (n - 1)) / n);
  const ph = Math.max(1, h);
  const f = Number.isFinite(from) ? from : 0;
  const t = Number.isFinite(to) ? to : f;
  const lo = clamp(Math.min(f, t), 0, n);
  const hi = clamp(Math.max(f, t), 0, n);
  const owned = clamp(f, 0, n);
  const losing = t < f;
  const pulse = 0.5 + 0.5 * Math.sin(time * 7);
  const lw = Math.max(0.5, ph * 0.18);
  let x = cx - (pw * n + gap * (n - 1)) / 2;
  for (let i = 0; i < n; i++) {
    const moved = i >= lo && i < hi;
    ctx.beginPath();
    ctx.rect(x, cy - ph / 2, pw, ph);
    if (moved) {
      ctx.fillStyle = losing
        ? withAlpha(GATE_COLORS.bad, 0.4 + 0.5 * pulse)
        : `rgba(255,255,255,${0.34 + 0.56 * pulse})`;
    } else if (i < owned) {
      ctx.fillStyle = accent;
    } else {
      ctx.fillStyle = PIP_OFF;
    }
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = moved || i < owned ? 'rgba(10,8,5,0.85)' : withAlpha(BRASS_LO, 0.9);
    ctx.stroke();
    x += pw + gap;
  }
}

// DEFUSED mark: a ring with a tick in it. Not a glyph, not a word — the shape
// of "safe" (and it survives at any size / any font stack).
function defusedMark(ctx, cx, cy, s, color) {
  const r = s * 0.38;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.strokeStyle = 'rgba(10,8,5,0.85)';
  ctx.lineWidth = Math.max(1.6, s * 0.15);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.46, cy + r * 0.04);
  ctx.lineTo(cx - r * 0.08, cy + r * 0.42);
  ctx.lineTo(cx + r * 0.5, cy - r * 0.42);
  ctx.strokeStyle = 'rgba(10,8,5,0.7)';
  ctx.lineWidth = Math.max(1.6, s * 0.15);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.09);
  ctx.stroke();
}

// The loss side of a trade, as a number: fixed levels, or the instant HP bite.
function tradeLossText(up) {
  const t = up.trade;
  if (!t) return null;
  if (t.loseKey) return signed(t.loseLv);
  if (t.instantDamageFrac) return `−${Math.round(t.instantDamageFrac * 100)}%`;
  return null;
}

function drawSlot(ctx, view, game, gate, slot) {
  const up = slot.up;
  const kind = up.kind;
  const defused = isDefused(slot);
  const color = defused ? DEFUSED_COLOR : (GATE_COLORS[kind] || GATE_COLORS.good);
  const accent = defused ? DEFUSED_ACCENT : (GATE_ACCENT[kind] || color);

  const L = project(view, slot.x - slot.halfW, gate.z);
  const R = project(view, slot.x + slot.halfW, gate.z);
  const k = L.f * view.unitScale;          // px per world unit at this depth
  const w = R.sx - L.sx;
  if (!(w > 2) || !(k > 0)) return;

  const h = GATE_H * k;
  const x0 = L.sx, y1 = L.sy, y0 = y1 - h;
  const cx = (L.sx + R.sx) / 2;
  const time = game.time || 0;
  const flash = clamp(slot.hitFlash / CHARGE_FLASH, 0, 1);
  // A slot that spawned below its cap keeps its sight-glass/gauge/marker for
  // life, so "I charged this" stays visible after it tops out.
  const gauged = slot.levelCap > slot.levels0;
  const maxed = slot.levels >= slot.levelCap;
  const fill = maxed ? 1 : clamp(slot.charge, 0, 1);
  const needleProg = gaugeFraction(slot);

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

  // Chargeable: boiler sight-glass. The fill climbs from the bottom with the
  // progress to the NEXT level step, with brass graduation ticks behind it.
  if (gauged) {
    if (fill > 0) {
      const fh = h * fill;
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

  // Live bad gates get hazard stripes across the whole panel — reads as a
  // barrier. A DEFUSED one drops them entirely: nothing to dodge any more.
  if (kind === 'bad' && !defused) hazardStripes(ctx, x0, y0, w, h, k, '#1b0308', 0.5);

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
  // (A defused gate glows dull iron: no hue left to warn about.)
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(5, (defused ? 7 : 16) * k);
  ctx.fillStyle = color;
  const lw = Math.max(1.4, pw * 0.46);
  ctx.fillRect(x0 + pw * 0.1, y0, lw, h);
  ctx.fillRect(R.sx - pw * 0.1 - lw, y0, lw, h);
  ctx.fillRect(x0, y0 - Math.max(1.2, pw * 0.22), w, Math.max(1.2, pw * 0.22));
  ctx.restore();

  // Riveted warning plates on the beam for live bad gates, bright lip otherwise.
  if (kind === 'bad' && !defused) {
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
    const gr = pw * 1.45;
    const gy = y0 + gr * 1.15;
    const spin = time * 0.5 + needleProg * 0.9;
    drawCog(ctx, x0, gy, gr, spin);
    drawCog(ctx, R.sx, gy, gr, -spin);

    // Pressure gauge on the beam of a chargeable slot: the needle sweeps
    // levels0 -> levelCap, the sight-glass below it shows the current step.
    if (gauged) {
      const dr = pw * 1.9;
      brassBar(ctx, cx - pw * 0.22, y0 - pw - dr * 0.9, pw * 0.44, dr * 0.9, true);
      gaugeDial(ctx, cx, y0 - pw - dr, dr, needleProg, maxed ? accent : '#ffd166');
    }
  }

  // Crossing line on the asphalt so the commit point is unambiguous.
  ctx.fillStyle = withAlpha(accent, 0.75);
  ctx.fillRect(x0, y1 - Math.max(1, 1.5 * k), w, Math.max(2, 3 * k));

  // --- glyph + level info (no words in the field; ui.js carries the text) ----
  const maxW = w * 0.9;
  const centerY = y1 - h * 0.56;

  // Backing plate so glyph/pips/number pop against the smoked glass.
  const plW = w * 0.72;
  const plH = h * 0.52;
  ctx.fillStyle = 'rgba(14,11,7,0.48)';
  ctx.fillRect(cx - plW / 2, centerY - plH / 2, plW, plH);
  ctx.fillStyle = withAlpha(BRASS, 0.55);
  const edge = Math.max(1, 1.1 * k);
  ctx.fillRect(cx - plW / 2, centerY - plH / 2, plW, edge);
  ctx.fillRect(cx - plW / 2, centerY + plH / 2 - edge, plW, edge);

  // The ICON is the primary read; numbers appear only when the panel is big
  // enough that they don't crowd the glyph (small phones fall back to icon +
  // pips — the HUD legend always carries the exact text).
  const roomy = h >= 34;
  const from = slot.previewFrom ?? 0;
  const to = slot.previewTo ?? from;
  const previewEntry = ENTRIES[slot.previewKey];
  const onTrack = !!previewEntry && previewEntry.track === true;
  const pipMax = up.maxLv || PIP_MAX;
  // Pips only mean something when the slot moves a LEVEL TRACK; instants
  // (repair/surplus) and an undefusable breach have no track to show.
  const showPips = onTrack && !defused;
  const pipY = centerY + plH * 0.32;
  const pipH = Math.max(1.2, plH * 0.13);
  const pipW = plW * 0.66;
  // ±N: the honest clamped delta on a track, the severity steps on a bad slot
  // with no track (breach), nothing at all for instants.
  const delta = onTrack ? to - from : (kind === 'bad' ? slot.levels : 0);
  const numText = delta ? signed(delta) : null;

  if (defused) {
    // Inert scrap: one calm ring where the hazard glyph used to be.
    defusedMark(ctx, cx, centerY, Math.max(10, h * 0.4), DEFUSED_ACCENT);
  } else if (kind === 'mixed') {
    // upper half = gain (▲ + glyph [+ number]), lower half = loss
    const gS = Math.max(9, h * (roomy ? 0.24 : 0.3)) * (1 + flash * 0.08);
    const lossText = tradeLossText(up);
    const rows = [
      { icon: up.iconGain, text: numText, tint: MIXED_UP, dir: -1, y: centerY - plH * 0.28, lv: from },
      { icon: up.iconLoss, text: lossText, tint: MIXED_DOWN, dir: 1, y: centerY + plH * 0.04, lv: 0 },
    ];
    for (const r of rows) {
      const showN = roomy && !!r.text;
      const ox = showN ? -gS * 0.3 : 0;
      drawArrow(ctx, cx + ox - gS * 1.2, r.y, gS * 0.7, r.dir, r.tint);
      if (detail) {
        drawIcon(ctx, r.icon, cx + ox + gS * 0.35, r.y, gS, null,
          { level: r.lv, maxLevel: pipMax, negative: r.dir > 0 });
      }
      if (showN) {
        numberLabel(ctx, r.text, cx + gS * 1.5, r.y, Math.min(gS * 0.85, h * 0.22), r.tint, maxW * 0.35);
      }
    }
    if (showPips) pipStrip(ctx, cx, pipY, pipW, pipH, from, to, pipMax, accent, time);
  } else {
    const iS = Math.max(10, h * (roomy ? 0.38 : 0.46)) * (1 + flash * 0.1);
    if (!detail) {
      // horizon LOD: pips + ±N only (the panel colour carries good/bad).
      if (showPips) pipStrip(ctx, cx, pipY, pipW, pipH, from, to, pipMax, accent, time);
      if (numText) {
        numberLabel(ctx, numText, cx, centerY - plH * 0.1,
          Math.max(MIN_LABEL_PX + 1, iS * 0.8), '#ffffff', maxW);
      } else if (!showPips) {
        // instants have neither a track nor a delta: a blank plate would say
        // nothing, so the glyph comes back in flat white (visual spec §D).
        drawIcon(ctx, up.icon, cx, centerY, iS, '#ffffff', null);
      }
    } else {
      const iconY = centerY - plH * (showPips ? 0.14 : 0);
      const opts = { level: from, maxLevel: pipMax, negative: kind === 'bad' || from < 0 };
      if (numText && roomy) {
        // centered [glyph][number] group — number capped so it never dominates
        const numSize = Math.min(Math.max(11, iS * 0.72), h * 0.32);
        ctx.font = `900 ${numSize}px sans-serif`;
        const nw = Math.min(ctx.measureText(numText).width, maxW * 0.55);
        const gap = iS * 0.3;
        const total = iS + gap + nw;
        const ix = cx - total / 2 + iS / 2;
        drawIcon(ctx, up.icon, ix, iconY, iS, null, opts);
        numberLabel(ctx, numText, ix + iS / 2 + gap + nw / 2, iconY, numSize, '#ffffff', maxW * 0.55);
      } else {
        // cramped panel: the glyph alone, drawn big (+ pips below it)
        drawIcon(ctx, up.icon, cx, iconY, iS * 1.1, null, opts);
      }
      if (showPips) pipStrip(ctx, cx, pipY, pipW, pipH, from, to, pipMax, accent, time);
      // live bad slots keep their warning symbols flanking the group
      if (kind === 'bad' && roomy) {
        const ws = Math.max(9, iS * 0.5);
        ctx.font = `900 ${ws}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = accent;
        ctx.fillText('⚠', cx - plW * 0.4, centerY + ws * 0.36);
        ctx.fillText('⚠', cx + plW * 0.4, centerY + ws * 0.36);
      }
    }
  }

  // --- shoot-me marker (chargeable slots only): symbol, not words ------------
  if (gauged) {
    const fs2 = Math.min(Math.max(8, h * 0.17), 20);
    ctx.font = `700 ${fs2}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = Math.max(1.5, fs2 * 0.22);
    ctx.strokeStyle = 'rgba(5,7,16,0.9)';
    const tag = maxed ? '★' : '⌖';
    const ty = y1 - h * 0.1;
    ctx.strokeText(tag, cx, ty);
    // pulse the crosshair so it reads as "interact with me"
    ctx.fillStyle = maxed ? accent : `rgba(255,209,102,${0.7 + 0.3 * Math.sin(time * 6)})`;
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
