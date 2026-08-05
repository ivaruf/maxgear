// Pickups (heal orbs, score gems, shield tokens). UPGRADE-AGENT OWNS THIS FILE.
// Collection is resolved in collisions.js via collectPickup() — single entry point.

import { DESPAWN_BEHIND } from './config.js';
import { project } from './render.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { healPlayer } from './player.js';

export const SHIELD_TIME = 3;   // seconds of invulnerability from a shieldToken

export const PICKUP_TYPES = {
  heal: { radius: 14, color: '#56b06c', value: 15 },
  gem: { radius: 12, color: '#ffd166', value: 50 },
  shieldToken: { radius: 14, color: '#35e0ff', value: SHIELD_TIME },
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
  audio.pickup();
  fx.hitSpark(pk.x, pk.z, pk.color);
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
  }
}

// ---- drawing ---------------------------------------------------------------
// STEAMPUNK: heal = green elixir vial, gem = solid brass cog, shieldToken =
// aether capacitor in a brass cage. The TYPE COLOURS are gameplay information
// (glow, hit sparks and floaters all read off pk.color) and keep their hexes.
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
    else gemCog(ctx, sx, cy, r * 1.15, pk.age * 2.4, pk.color);
    ctx.restore();
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
