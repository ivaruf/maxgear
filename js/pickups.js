// Pickups (heal orbs, score gems, shield tokens + the v1.3 crate loot kinds:
// overdrive, steamburst, gearbox). UPGRADE-AGENT OWNS THIS FILE.
// Collection is resolved in collisions.js via collectPickup() — single entry point.
//
// CIRCULAR IMPORT (deliberate, documented — same precedent as player.js <->
// enemies.js): enemies.js imports spawnPickup from here, and STEAMBURST needs
// the central death hook, so we import killEnemy from enemies.js. Neither
// binding is touched during module EVALUATION (only inside functions), so the
// cycle is fully resolved before anything can run. Verified in both import
// orders (pickups-first and enemies-first).

import { DESPAWN_BEHIND } from './config.js';
import { rand, choice } from './utils.js';
import { project } from './render.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { healPlayer } from './player.js';
import { killEnemy } from './enemies.js';        // see CIRCULAR IMPORT above
import { ENTRIES, TRACK_ORDER, addLevels, recomputeStats, trackLevel } from './upgrades.js';

export const SHIELD_TIME = 3;   // seconds of invulnerability from a shieldToken

// ---- v1.3 pickup tuning -----------------------------------------------------
export const OVERDRIVE_TIME = 6;        // s of 1.67x fire rate (player.overdriveT)
export const STEAMBURST_DAMAGE = 60;    // flat damage to every enemy on screen
export const STEAMBURST_RANGE = 1500;   // "on screen" = z < player.z + this
export const STEAMBURST_BOSS_FLOOR = 0.1;  // never chips the boss below 10% maxHp
export const GEARBOX_LEVELS = 1;        // levels granted to a random owned track

export const PICKUP_TYPES = {
  heal: { radius: 14, color: '#56b06c', value: 15 },
  gem: { radius: 12, color: '#ffd166', value: 50 },
  shieldToken: { radius: 14, color: '#35e0ff', value: SHIELD_TIME },
  // Crate jackpots. `value` is informational for the HUD/end screen; the
  // effects below read the tuning constants, never pk.value.
  overdrive: { radius: 14, color: '#ffa63d', value: OVERDRIVE_TIME },
  steamburst: { radius: 15, color: '#e6e1d7', value: STEAMBURST_DAMAGE },
  gearbox: { radius: 13, color: '#f0b429', value: GEARBOX_LEVELS },
};

const MAGNET_PULL = 420;        // world units/sec once inside the magnet radius

export function spawnPickup(game, kind, x, z) {
  const t = PICKUP_TYPES[kind];
  if (!t) return;
  game.pickups.push({
    kind, x, z,
    radius: t.radius,
    color: t.color,
    value: t.value,
    age: Math.random() * Math.PI * 2,   // desync the bob/pulse of neighbours
    dead: false,
  });
}

export function updatePickups(game, dt) {
  const p = game.player;
  const magnetR = 60 + p.stats.magnet;
  for (const pk of game.pickups) {
    pk.age += dt;
    // Magnet pull when close
    const dx = p.x - pk.x, dz = p.z - pk.z;
    const d = Math.hypot(dx, dz);
    if (d < magnetR && d > 1) {
      pk.x += (dx / d) * MAGNET_PULL * dt;
      pk.z += (dz / d) * MAGNET_PULL * dt;
    }
    if (pk.z < p.z - DESPAWN_BEHIND) pk.dead = true;
  }
}

export function collectPickup(game, pk) {
  if (pk.dead) return;
  pk.dead = true;
  fx.hitSpark(pk.x, pk.z, pk.color);
  // The two loud kinds own their own audio (explode / gateGood).
  if (pk.kind === 'steamburst') { steamburst(game, pk); return; }
  if (pk.kind === 'gearbox') { gearbox(game, pk); return; }
  audio.pickup();
  if (pk.kind === 'heal') {
    healPlayer(game, pk.value);
  } else if (pk.kind === 'gem') {
    game.score += pk.value;
    fx.textPop(pk.x, pk.z, `+${pk.value}`, pk.color);
  } else if (pk.kind === 'shieldToken') {
    const secs = pk.value || SHIELD_TIME;
    game.player.invuln = Math.max(game.player.invuln, secs);
    fx.flash(pk.color, 0.16, 0.3);
    fx.textPop(pk.x, pk.z, 'SHIELD!', pk.color);
  } else if (pk.kind === 'overdrive') {
    // player.js: overdriveT > 0 -> fireInterval * 0.6. Refresh, never stack.
    const p = game.player;
    p.overdriveT = Math.max(p.overdriveT || 0, OVERDRIVE_TIME);
    fx.flash('#ffb347', 0.15, 0.3);
    fx.textPop(pk.x, pk.z, 'OVERDRIVE!', pk.color);
  }
}

// ---- STEAMBURST -------------------------------------------------------------
// A ruptured boiler: flat damage to every living enemy on screen. Like a mine
// blast it hits `hp` directly (a shield plate does not soak it) and routes
// deaths through killEnemy so score/splits/shrapnel/siphon all still fire.
//
// BOSS CLAMP: the boss takes the damage but is never taken below 10% of maxHp —
// stockpiling steambursts must not be able to skip the last phase. Below the
// floor the boss is simply skipped (no damage, no "immune" noise).
const STEAM = '#e6e1d7';
const DMG_FLOATERS = 8;         // fx budget: only the first few show a number

function steamburst(game, pk) {
  const p = game.player;
  const zMax = p.z + STEAMBURST_RANGE;
  const n = game.enemies.length;      // snapshot: killEnemy can push split minis
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (!e || e.dead || e.z > zMax) continue;
    if (e.isBoss) {
      const floor = e.maxHp * STEAMBURST_BOSS_FLOOR;
      if (e.hp - STEAMBURST_DAMAGE < floor) continue;
      e.hp -= STEAMBURST_DAMAGE;
      e.flash = 0.08;
      fx.textPop(e.x, e.z, `${STEAMBURST_DAMAGE}`, STEAM);
      continue;                       // a steamburst can never be the killing blow
    }
    e.hp -= STEAMBURST_DAMAGE;
    e.flash = 0.08;
    if (shown++ < DMG_FLOATERS) fx.textPop(e.x, e.z, `${STEAMBURST_DAMAGE}`, STEAM);
    if (e.hp <= 0) killEnemy(game, e, 'explosion');
  }
  // Big, loud, unmistakable: white flash + hard shake + a wall of steam.
  fx.flash('#ffffff', 0.3, 0.32);
  fx.shake(8, 0.4);
  fx.explosion(pk.x, pk.z, 120, STEAM);
  for (let i = 0; i < 3; i++) {
    fx.explosion(pk.x + rand(-140, 140), pk.z + rand(120, 520), rand(70, 110), STEAM);
  }
  fx.textPop(p.x, p.z + 60, 'STEAMBURST!', STEAM);
  audio.explode();
}

// ---- GEARBOX ---------------------------------------------------------------
// A free level, no gate required: +1 to a RANDOM track you already own and can
// still grow. Fallback is a LV0 track (so it is never a dud), and the payout is
// published on game.lastUpgrade so the ui.js toast + build strip react exactly
// like a gate award.
function levelPool(player, test) {
  const out = [];
  for (const key of TRACK_ORDER) {
    const def = ENTRIES[key];
    if (!def || !def.track) continue;
    if (test(trackLevel(player, key), def)) out.push(key);
  }
  return out;
}

function gearbox(game, pk) {
  const p = game.player;
  // owned + headroom first; otherwise open a new track (plating below LV0 —
  // rusted — counts as "not owned yet" and is happily repaired here).
  const owned = levelPool(p, (lv, def) => lv > 0 && lv < def.maxLv);
  const pool = owned.length ? owned : levelPool(p, (lv, def) => lv <= 0 && lv < def.maxLv);
  if (!pool.length) {                 // everything maxed: pay out as score
    game.score += 250;
    fx.textPop(pk.x, pk.z, '+250', pk.color);
    audio.pickup();
    return;
  }
  const key = choice(pool);
  const { from, to } = addLevels(p, key, GEARBOX_LEVELS);
  recomputeStats(p);                  // stats are DERIVED — never mutate directly
  const label = `${ENTRIES[key].name} LV${from} → LV${to}`;
  game.lastUpgrade = { label, kind: 'good', key, from, to };
  fx.flash(pk.color, 0.16, 0.3);
  fx.textPop(pk.x, pk.z, label, pk.color);
  fx.gateBurst?.(pk.x, pk.z, pk.color);
  fx.hitSpark(pk.x, pk.z, '#fff4cf');
  audio.gateGood();
}

// ---- drawing ---------------------------------------------------------------
// STEAMPUNK: heal = green elixir vial, gem = solid brass cog, shieldToken =
// aether capacitor in a brass cage. The TYPE COLOURS are gameplay information
// (glow, hit sparks and floaters all read off pk.color) and keep their hexes.
// v1.3 kinds keep the same ground glow + bob and get their OWN silhouette so
// they are told apart at a glance from a low, fast camera:
//   overdrive  = bolt inside a hollow gear RING + pistons  (amber)
//   steamburst = wide riveted canister, valve wheel, steam (steam white)
//   gearbox    = bolted SQUARE case with a turning gear    (bright brass)
const TAU = Math.PI * 2;
const BRASS = '#c9973b';
const BRASS_HI = '#f0b429';
const BRASS_LO = '#6f5220';
const GLASS_EDGE = 'rgba(22,16,9,0.55)';

// Cog silhouette baked ONCE at unit radius, scaled at draw time (no per-frame
// path building). Path2D is guarded so the module still imports without a DOM.
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
  return p;
}
const COG = typeof Path2D !== 'undefined' ? cogPath(10, 1, 0.7, 0) : null;

function cogSilhouette(ctx) {
  if (COG) ctx.fill(COG);
  else { ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill(); }
}

// Flask outline, rebuilt for both the fill/clip and the later stroke (the
// bubble below starts its own path, so the outline path cannot be reused).
function vialPath(ctx, sx, sy, r) {
  const hw = r * 0.53, nw = r * 0.22;
  const top = sy - r, bottom = sy + r;
  const ny = sy - r * 0.6;              // neck -> shoulder
  const sh = sy - r * 0.32;             // shoulder -> body wall
  const rb = r * 0.36;                  // rounded bottom
  ctx.beginPath();
  ctx.moveTo(sx - nw, top);
  ctx.lineTo(sx - nw, ny);
  ctx.quadraticCurveTo(sx - hw, ny, sx - hw, sh);
  ctx.lineTo(sx - hw, bottom - rb);
  ctx.quadraticCurveTo(sx - hw, bottom, sx - hw + rb, bottom);
  ctx.lineTo(sx + hw - rb, bottom);
  ctx.quadraticCurveTo(sx + hw, bottom, sx + hw, bottom - rb);
  ctx.lineTo(sx + hw, sh);
  ctx.quadraticCurveTo(sx + hw, ny, sx + nw, ny);
  ctx.lineTo(sx + nw, top);
  ctx.closePath();
}

// Green-glass elixir vial. Keeps the green hex as the liquid + glass tint, and
// wears a brass cross so the "this is health" read survives the re-theme.
function healVial(ctx, sx, sy, r, color, age) {
  const hw = r * 0.53, nw = r * 0.22;
  const top = sy - r, bottom = sy + r;
  const ny = sy - r * 0.6;
  vialPath(ctx, sx, sy, r);
  ctx.fillStyle = hexA(color, 0.3);
  ctx.fill();

  // Liquid (full-strength green) with a slow slosh + one rising bubble.
  const lvl = sy - r * 0.18 + Math.sin(age * 2.2) * r * 0.06;
  ctx.save();
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(sx - hw, lvl, hw * 2, bottom - lvl);
  ctx.fillStyle = 'rgba(234,255,242,0.8)';
  ctx.fillRect(sx - hw, lvl, hw * 2, Math.max(1, r * 0.1));
  const bub = (age * 0.5) % 1;          // 0 = at the bottom, 1 = at the surface
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#eafff2';
  ctx.beginPath();
  ctx.arc(sx + r * 0.16, bottom - (bottom - lvl) * bub, Math.max(0.6, r * 0.09), 0, TAU);
  ctx.fill();
  ctx.restore();

  // Glass edge + sheen, then the brass hardware (metal takes no coloured glow).
  vialPath(ctx, sx, sy, r);
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.strokeStyle = GLASS_EDGE;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(sx - hw * 0.62, sy - r * 0.2, Math.max(1, r * 0.12), r * 0.9);

  ctx.fillStyle = BRASS;
  ctx.fillRect(sx - nw * 1.5, ny - r * 0.1, nw * 3, r * 0.16);        // collar
  ctx.fillRect(sx - nw * 1.35, top - r * 0.16, nw * 2.7, r * 0.28);   // stopper
  ctx.fillStyle = BRASS_HI;
  ctx.fillRect(sx - nw * 1.35, top - r * 0.16, nw * 2.7, Math.max(0.8, r * 0.09));
  ctx.fillStyle = BRASS_LO;
  ctx.fillRect(sx - nw * 0.5, top - r * 0.3, nw, r * 0.16);           // ring pull

  if (r > 6) {   // engraved brass cross on the flask
    const aw = r * 0.34, th = Math.max(1, r * 0.13);
    const cy2 = sy + r * 0.26;
    ctx.fillStyle = BRASS_HI;
    ctx.fillRect(sx - th / 2, cy2 - aw / 2, th, aw);
    ctx.fillRect(sx - aw / 2, cy2 - th / 2, aw, th);
  }
}

// Solid brass cog. Keeps the gold hex + the coin-flip squash of the old gem.
function gemCog(ctx, sx, sy, r, spin, color) {
  const sq = 0.42 + Math.abs(Math.cos(spin * 0.5)) * 0.58;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(sq, 1);          // screen-space squash = coin flip
  ctx.rotate(spin);
  ctx.scale(r, r);
  ctx.fillStyle = color;
  cogSilhouette(ctx);
  ctx.shadowBlur = 0;
  ctx.lineWidth = 0.13;
  ctx.strokeStyle = 'rgba(68,44,10,0.7)';
  if (COG) ctx.stroke(COG);
  // Hub + spokes so it reads as machined brass, not a coin.
  ctx.fillStyle = BRASS_LO;
  ctx.beginPath();
  ctx.arc(0, 0, 0.34, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = BRASS_LO;
  ctx.lineWidth = 0.11;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = i * (TAU / 3) + 0.4;
    ctx.moveTo(Math.cos(a) * 0.34, Math.sin(a) * 0.34);
    ctx.lineTo(Math.cos(a) * 0.64, Math.sin(a) * 0.64);
  }
  ctx.stroke();
  ctx.fillStyle = '#fff4cf';
  ctx.beginPath();
  ctx.arc(0, 0, 0.15, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Aether capacitor: the cyan hex ring + core are kept (barrier read, not loot);
// a small brass cage is bolted around them.
function shieldCapacitor(ctx, sx, sy, r, color, age) {
  ctx.lineWidth = Math.max(1.5, r * 0.22);
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const px = sx + Math.cos(a) * r, py = sy + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(sx, sy, r * 0.42, 0, TAU);
  ctx.fill();
  // Arcing aether inside the core.
  ctx.globalAlpha = 0.5 + Math.abs(Math.sin(age * 7)) * 0.5;
  ctx.fillStyle = '#ecffff';
  ctx.beginPath();
  ctx.arc(sx, sy, r * 0.17, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;

  // Brass cage: side straps + bolted end caps (metal takes no cyan glow).
  ctx.shadowBlur = 0;
  const strap = Math.max(1, r * 0.19);
  const sxs = r * 0.866;
  ctx.fillStyle = BRASS;
  ctx.fillRect(sx - sxs - strap / 2, sy - r * 0.54, strap, r * 1.08);
  ctx.fillRect(sx + sxs - strap / 2, sy - r * 0.54, strap, r * 1.08);
  const cw = r * 0.94, ch = Math.max(1.5, r * 0.3);
  ctx.fillRect(sx - cw / 2, sy - r * 1.1, cw, ch);
  ctx.fillRect(sx - cw / 2, sy + r * 1.1 - ch, cw, ch);
  ctx.fillStyle = BRASS_HI;
  ctx.fillRect(sx - cw / 2, sy - r * 1.1, cw, Math.max(0.8, ch * 0.3));
  ctx.fillRect(sx - cw / 2, sy + r * 1.1 - ch, cw, Math.max(0.8, ch * 0.3));
  if (r > 6) {   // copper coil around the core
    ctx.strokeStyle = '#b0652f';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.6, -0.5, 1.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.6, Math.PI - 0.5, Math.PI + 1.2);
    ctx.stroke();
  }
}

// OVERDRIVE: a lightning bolt caged in a spinning brass gear RING, flanked by
// two little pistons. Silhouette read = hollow ring + bolt (the gem is a SOLID
// cog, so the two never get confused at speed).
function overdriveGear(ctx, sx, sy, r, color, age) {
  const surge = 0.5 + Math.abs(Math.sin(age * 5)) * 0.5;
  // Pistons on both shoulders (brass, no coloured glow).
  ctx.shadowBlur = 0;
  ctx.strokeStyle = BRASS_LO;
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.beginPath();
  for (const s of [-1, 1]) {
    ctx.moveTo(sx + s * r * 0.9, sy);
    ctx.lineTo(sx + s * r * 1.45, sy);
  }
  ctx.stroke();
  ctx.fillStyle = BRASS;
  for (const s of [-1, 1]) {
    ctx.fillRect(sx + s * r * 1.45 - r * 0.16, sy - r * 0.34, r * 0.32, r * 0.68);
  }
  // Toothed ring (spins on age; glow comes back on for the coloured metal).
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(4, r * 0.7);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(age * 1.5);
  ctx.scale(r, r);
  ctx.fillStyle = color;
  cogSilhouette(ctx);
  ctx.restore();
  ctx.shadowBlur = 0;
  // Hollow hub + brass rim.
  ctx.fillStyle = '#2a1f12';
  ctx.beginPath();
  ctx.arc(sx, sy, r * 0.64, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = BRASS_LO;
  ctx.lineWidth = Math.max(1, r * 0.11);
  ctx.stroke();
  // The bolt itself does NOT spin — it is the gameplay read.
  ctx.beginPath();
  ctx.moveTo(sx + r * 0.30, sy - r * 0.70);
  ctx.lineTo(sx - r * 0.32, sy + r * 0.06);
  ctx.lineTo(sx - r * 0.02, sy + r * 0.06);
  ctx.lineTo(sx - r * 0.24, sy + r * 0.72);
  ctx.lineTo(sx + r * 0.36, sy - r * 0.08);
  ctx.lineTo(sx + r * 0.05, sy - r * 0.08);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = surge;
  ctx.fillStyle = '#fff4dd';
  ctx.fill();
  ctx.globalAlpha = 1;
}

// STEAMBURST: a squat riveted pressure canister with a brass valve wheel and a
// pressure dial, venting steam. Silhouette read = wide drum (nothing else in the
// pickup set is horizontal).
function steamCanister(ctx, sx, sy, r, color, age) {
  const w = r * 1.15, h = r * 0.78;
  // Venting steam, behind the drum.
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < 3; i++) {
    const t = ((age * 0.7) + i / 3) % 1;
    ctx.globalAlpha = (1 - t) * 0.45;
    ctx.beginPath();
    ctx.arc(sx + (i - 1) * r * 0.62, sy - h - t * r * 1.6, r * (0.2 + t * 0.45), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  // Drum body + dark banding.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(sx, sy, w, h, 0, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(30,22,14,0.55)';
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.stroke();
  ctx.fillStyle = 'rgba(30,22,14,0.16)';
  ctx.fillRect(sx - w * 0.62, sy - h * 0.18, w * 1.24, h * 0.36);
  // Brass end caps + rim rivets.
  ctx.fillStyle = BRASS;
  for (const s of [-1, 1]) {
    ctx.fillRect(sx + s * w * 0.86 - r * 0.14, sy - h * 0.62, r * 0.28, h * 1.24);
  }
  ctx.fillStyle = BRASS_HI;
  ctx.fillRect(sx - w * 0.86 - r * 0.14, sy - h * 0.62, w * 1.72 + r * 0.28, Math.max(0.8, r * 0.08));
  if (r > 5) {
    ctx.fillStyle = BRASS_LO;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.5;
      ctx.beginPath();
      ctx.arc(sx + Math.cos(a) * w * 0.68, sy + Math.sin(a) * h * 0.62, Math.max(0.7, r * 0.08), 0, TAU);
      ctx.fill();
    }
  }
  // Valve wheel on top (turns with age).
  const vy = sy - h - r * 0.28;
  ctx.strokeStyle = BRASS;
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.beginPath();
  ctx.moveTo(sx, sy - h * 0.6);
  ctx.lineTo(sx, vy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx, vy, r * 0.3, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 2; i++) {
    const a = age * 1.4 + i * (Math.PI / 2);
    ctx.moveTo(sx - Math.cos(a) * r * 0.3, vy - Math.sin(a) * r * 0.3);
    ctx.lineTo(sx + Math.cos(a) * r * 0.3, vy + Math.sin(a) * r * 0.3);
  }
  ctx.stroke();
  // Pressure dial: needle pinned deep in the red.
  if (r > 6) {
    ctx.fillStyle = '#2a241d';
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.34, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = BRASS_HI;
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.stroke();
    const na = -Math.PI * 0.75 + (0.6 + Math.abs(Math.sin(age * 3)) * 0.35) * Math.PI * 1.5;
    ctx.strokeStyle = '#ff5964';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(na) * r * 0.28, sy + Math.sin(na) * r * 0.28);
    ctx.stroke();
  }
}

// GEARBOX: a bolted brass case with a gear turning on its face, plus sparkles.
// Silhouette read = SQUARE (the only boxy pickup) — a free level is worth a
// jackpot glint, so it also gets four rotating star glints.
function gearboxCase(ctx, sx, sy, r, color, age) {
  const s = r * 0.92;
  ctx.fillStyle = color;
  ctx.fillRect(sx - s, sy - s, s * 2, s * 2);
  ctx.shadowBlur = 0;
  // Darker inset face so the gear has something to sit in.
  ctx.fillStyle = '#3a2c15';
  ctx.fillRect(sx - s * 0.72, sy - s * 0.72, s * 1.44, s * 1.44);
  ctx.strokeStyle = 'rgba(40,28,10,0.75)';
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.strokeRect(sx - s, sy - s, s * 2, s * 2);
  // Bolted corners.
  ctx.fillStyle = BRASS_HI;
  const cs = s * 0.34;
  for (let i = 0; i < 4; i++) {
    const lx = i % 2 === 0 ? -1 : 1;
    const ly = i < 2 ? -1 : 1;
    ctx.fillRect(sx + lx * s - (lx < 0 ? 0 : cs), sy + ly * s - (ly < 0 ? 0 : cs * 0.34), cs, cs * 0.34);
    ctx.fillRect(sx + lx * s - (lx < 0 ? 0 : cs * 0.34), sy + ly * s - (ly < 0 ? 0 : cs), cs * 0.34, cs);
  }
  // Main gear on the face (+ a small meshed one) — the "free level" motif.
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(age * 1.1);
  ctx.scale(s * 0.62, s * 0.62);
  ctx.fillStyle = color;
  cogSilhouette(ctx);
  ctx.restore();
  ctx.save();
  ctx.translate(sx + s * 0.66, sy + s * 0.58);
  ctx.rotate(-age * 1.9);
  ctx.scale(s * 0.3, s * 0.3);
  ctx.fillStyle = BRASS;
  cogSilhouette(ctx);
  ctx.restore();
  ctx.fillStyle = BRASS_LO;
  ctx.beginPath();
  ctx.arc(sx, sy, s * 0.2, 0, TAU);
  ctx.fill();
  // Jackpot sparkle: four 4-point glints orbiting the case.
  ctx.fillStyle = '#fff4cf';
  for (let i = 0; i < 4; i++) {
    const a = age * 1.3 + (i / 4) * TAU;
    const d = s * (1.35 + Math.sin(age * 4 + i) * 0.18);
    const gx = sx + Math.cos(a) * d, gy = sy + Math.sin(a) * d;
    const gr = Math.max(0.8, r * (0.1 + 0.06 * Math.abs(Math.sin(age * 5 + i))));
    ctx.beginPath();
    ctx.moveTo(gx, gy - gr * 2.2);
    ctx.lineTo(gx + gr, gy);
    ctx.lineTo(gx, gy + gr * 2.2);
    ctx.lineTo(gx - gr, gy);
    ctx.closePath();
    ctx.fill();
  }
}

export function drawPickups(ctx, view, game) {
  for (const pk of game.pickups) {
    if (pk.dead) continue;
    const { sx, sy, f } = project(view, pk.x, pk.z);
    const k = f * view.unitScale;                     // px per world unit here
    const pulse = 1 + Math.sin(pk.age * 6) * 0.14;
    const r = pk.radius * k * pulse;
    if (r < 0.8) continue;
    const bob = (6 + Math.sin(pk.age * 3) * 5) * k;   // hover above the asphalt

    ctx.save();
    // Soft ground glow so pickups read against the dark road.
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(3, r * 2.2));
    glow.addColorStop(0, hexA(pk.color, 0.32));
    glow.addColorStop(1, hexA(pk.color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(sx - r * 2.4, sy - r * 2.4, r * 4.8, r * 4.8);

    ctx.shadowColor = pk.color;
    ctx.shadowBlur = Math.max(6, 12 * k) * (0.7 + pulse * 0.3);
    ctx.fillStyle = pk.color;
    const cy = sy - bob;
    if (pk.kind === 'heal') healVial(ctx, sx, cy, r, pk.color, pk.age);
    else if (pk.kind === 'shieldToken') shieldCapacitor(ctx, sx, cy, r * 1.12, pk.color, pk.age);
    else if (pk.kind === 'overdrive') overdriveGear(ctx, sx, cy, r * 1.05, pk.color, pk.age);
    else if (pk.kind === 'steamburst') steamCanister(ctx, sx, cy, r, pk.color, pk.age);
    else if (pk.kind === 'gearbox') gearboxCase(ctx, sx, cy, r * 1.1, pk.color, pk.age);
    else gemCog(ctx, sx, cy, r * 1.15, pk.age * 2.4, pk.color);
    ctx.restore();
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
