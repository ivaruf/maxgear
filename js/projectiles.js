// Player projectile + enemy shot lifecycle. Collision resolution lives in
// collisions.js; this module only spawns, moves, and draws.

import { ROAD_HALF, PROJECTILE, LIMITS } from './config.js';
import { project } from './render.js';
import { fx } from './effects.js';

// Fire one volley from (x, z) using the shooter's stats.
export function fireVolley(game, x, z, stats) {
  const n = Math.round(stats.projectiles);
  const spread = (stats.spreadDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const angle = (i - (n - 1) / 2) * spread;
    const crit = Math.random() < stats.critChance;
    const proj = {
      x, z,
      vx: Math.sin(angle) * PROJECTILE.speed,
      vz: Math.cos(angle) * PROJECTILE.speed,
      radius: PROJECTILE.radius,
      damage: crit ? stats.damage * 2 : stats.damage,
      crit,
      pierce: stats.pierce,
      ricochet: stats.ricochet,
      explosive: stats.explosive,
      life: PROJECTILE.life,
      hits: null,           // Set of enemies already pierced (lazy)
      dead: false,
    };
    // At the cap, recycle the oldest slot instead of refusing to fire —
    // otherwise late squad members silently contribute nothing (QA MED-4)
    if (game.projectiles.length >= LIMITS.projectiles) {
      game.projCursor = (game.projCursor ?? 0) % LIMITS.projectiles;
      game.projectiles[game.projCursor++] = proj;
    } else {
      game.projectiles.push(proj);
    }
  }
  fx.muzzle(x, z + 24);
}

export function fireEnemyShot(game, x, z, tx, tz, speed, damage, opts = {}) {
  if (game.enemyShots.length >= LIMITS.enemyShots) return;
  const dx = tx - x, dz = tz - z;
  const len = Math.hypot(dx, dz) || 1;
  game.enemyShots.push({
    x, z,
    vx: (dx / len) * speed,
    vz: (dz / len) * speed,
    radius: opts.radius || 10,
    damage,
    color: opts.color || '#ff7096',
    life: 4,
    dead: false,
  });
}

export function updateProjectiles(game, dt) {
  for (const p of game.projectiles) {
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.life -= dt;
    if (p.life <= 0 || Math.abs(p.x) > ROAD_HALF + 60) p.dead = true;
  }
  for (const s of game.enemyShots) {
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    s.life -= dt;
    if (s.life <= 0 || s.z < game.player.z - 80 || Math.abs(s.x) > ROAD_HALF + 80) s.dead = true;
  }
}

export function drawProjectiles(ctx, view, game) {
  for (const p of game.projectiles) {
    const { sx, sy, f } = project(view, p.x, p.z);
    const r = Math.max(p.radius * f * view.unitScale * 0.85, 2.4);
    ctx.fillStyle = p.crit ? '#ffd166' : '#8df3ff';
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, r * 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawEnemyShots(ctx, view, game) {
  for (const s of game.enemyShots) {
    const { sx, sy, f } = project(view, s.x, s.z);
    const r = Math.max(s.radius * f * view.unitScale, 3);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
}
