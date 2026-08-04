// Obstacles: destructible crates/barriers and hazards. LEVEL-AGENT OWNS THIS FILE.
// Damage/destruction is routed through damageObstacle() from collisions.js.

import { DESPAWN_BEHIND } from './config.js';
import { chance } from './utils.js';
import { project } from './render.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { spawnPickup } from './pickups.js';
import { damagePlayer } from './player.js';

export const OBSTACLE_TYPES = {
  crate: {
    hp: 30, radius: 24, contactDamage: 12, score: 5,
    color: '#a07b4f', destructible: true, dropChance: 0.35,
  },
  spikes: {
    hp: Infinity, radius: 26, contactDamage: 18, score: 0,
    color: '#8a93a8', destructible: false, dropChance: 0,
  },
};

export function spawnObstacle(game, typeKey, x, z, opts = {}) {
  const t = OBSTACLE_TYPES[typeKey];
  if (!t) { console.error(`Unknown obstacle type: ${typeKey}`); return null; }
  game.obstacles.push({
    type: typeKey, def: t,
    x, z,
    hp: t.hp, maxHp: t.hp,
    radius: t.radius,
    contactDamage: t.contactDamage,
    destructible: t.destructible,
    flash: 0, age: 0,
    dead: false,
    ...opts.extra,
  });
}

export function updateObstacles(game, dt) {
  for (const o of game.obstacles) {
    o.age += dt;
    o.flash = Math.max(0, o.flash - dt);
    if (o.z < game.player.z - DESPAWN_BEHIND) o.dead = true;
  }
}

// Projectile (or explosion) damaged an obstacle
export function damageObstacle(game, o, amount) {
  if (!o.destructible || o.dead) return;
  o.hp -= amount;
  o.flash = 0.08;
  if (o.hp <= 0) {
    o.dead = true;
    game.score += o.def.score;
    fx.explosion(o.x, o.z, o.radius, o.def.color);
    audio.hit();
    if (chance(o.def.dropChance)) spawnPickup(game, chance(0.5) ? 'heal' : 'gem', o.x, o.z);
  }
}

// Player ran into an obstacle
export function obstacleContact(game, o) {
  damagePlayer(game, o.contactDamage);
  if (o.destructible) {
    o.dead = true;
    fx.explosion(o.x, o.z, o.radius, o.def.color);
  }
}

export function drawObstacles(ctx, view, game) {
  const sorted = [...game.obstacles].sort((a, b) => b.z - a.z);
  for (const o of sorted) {
    if (o.dead) continue;
    const { sx, sy, f } = project(view, o.x, o.z);
    const s = f * view.unitScale * 0.16;
    const r = o.radius * s * 2.2;
    ctx.save();
    ctx.translate(sx, sy);
    if (o.type === 'crate') {
      ctx.fillStyle = o.flash > 0 ? '#ffffff' : o.def.color;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.beginPath();
      ctx.moveTo(-r, -r); ctx.lineTo(r, r);
      ctx.moveTo(r, -r); ctx.lineTo(-r, r);
      ctx.stroke();
    } else {
      // spikes: triangle strip
      ctx.fillStyle = o.def.color;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * r * 0.5 - r * 0.22, r * 0.4);
        ctx.lineTo(i * r * 0.5 + r * 0.22, r * 0.4);
        ctx.lineTo(i * r * 0.5, -r * 0.7);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
