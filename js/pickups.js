// Pickups (heal orbs, score gems, shield tokens). UPGRADE-AGENT OWNS THIS FILE.
// Collection is resolved in collisions.js via collectPickup() — single entry point.

import { DESPAWN_BEHIND } from './config.js';
import { project } from './render.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { healPlayer } from './player.js';

export const SHIELD_TIME = 3;   // seconds of invulnerability from a shieldToken

export const PICKUP_TYPES = {
  heal: { radius: 14, color: '#3ddc84', value: 15 },
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
function healCross(ctx, sx, sy, r) {
  const w = r * 0.4;
  ctx.beginPath();
  ctx.rect(sx - w / 2, sy - r, w, r * 2);
  ctx.rect(sx - r, sy - w / 2, r * 2, w);
  ctx.fill();
}

function gemDiamond(ctx, sx, sy, r, spin) {
  // Gold coin/diamond: squashed horizontally as it "spins" for a coin flip feel.
  const sq = 0.35 + Math.abs(Math.cos(spin)) * 0.65;
  ctx.beginPath();
  ctx.moveTo(sx, sy - r);
  ctx.lineTo(sx + r * sq, sy);
  ctx.lineTo(sx, sy + r);
  ctx.lineTo(sx - r * sq, sy);
  ctx.closePath();
  ctx.fill();
  // Inner facet highlight
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#fff4cf';
  ctx.beginPath();
  ctx.moveTo(sx, sy - r * 0.55);
  ctx.lineTo(sx + r * sq * 0.45, sy);
  ctx.lineTo(sx, sy + r * 0.3);
  ctx.lineTo(sx - r * sq * 0.45, sy);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function shieldBadge(ctx, sx, sy, r, color) {
  // Hex ring + inner core: reads as a barrier, not as loot.
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
  ctx.arc(sx, sy, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
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
    if (pk.kind === 'heal') healCross(ctx, sx, cy, r);
    else if (pk.kind === 'shieldToken') shieldBadge(ctx, sx, cy, r * 1.12, pk.color);
    else gemDiamond(ctx, sx, cy, r * 1.15, pk.age * 2.4);
    ctx.restore();
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
