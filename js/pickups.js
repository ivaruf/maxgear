// Pickups (heal orbs, score gems). UPGRADE-AGENT OWNS THIS FILE.
// Collection is resolved in collisions.js via collectPickup().

import { DESPAWN_BEHIND } from './config.js';
import { project } from './render.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { healPlayer } from './player.js';

export const PICKUP_TYPES = {
  heal: { radius: 14, color: '#3ddc84', value: 15 },
  gem: { radius: 12, color: '#ffd166', value: 50 },
};

export function spawnPickup(game, kind, x, z) {
  const t = PICKUP_TYPES[kind];
  if (!t) return;
  game.pickups.push({ kind, x, z, radius: t.radius, color: t.color, value: t.value, age: 0, dead: false });
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
      pk.x += (dx / d) * 420 * dt;
      pk.z += (dz / d) * 420 * dt;
    }
    if (pk.z < p.z - DESPAWN_BEHIND) pk.dead = true;
  }
}

export function collectPickup(game, pk) {
  pk.dead = true;
  audio.pickup();
  fx.hitSpark(pk.x, pk.z, pk.color);
  if (pk.kind === 'heal') healPlayer(game, pk.value);
  else if (pk.kind === 'gem') {
    game.score += pk.value;
    fx.textPop(pk.x, pk.z, `+${pk.value}`, pk.color);
  }
}

export function drawPickups(ctx, view, game) {
  for (const pk of game.pickups) {
    const { sx, sy, f } = project(view, pk.x, pk.z);
    const r = pk.radius * f * view.unitScale * 0.16 * (2 + Math.sin(pk.age * 6) * 0.3);
    ctx.save();
    ctx.shadowColor = pk.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = pk.color;
    ctx.beginPath();
    if (pk.kind === 'heal') {
      // plus sign
      const w = r * 0.36;
      ctx.rect(sx - w / 2, sy - r, w, r * 2);
      ctx.rect(sx - r, sy - w / 2, r * 2, w);
    } else {
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }
}
