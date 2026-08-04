// Data-driven enemy system. ENEMY-AGENT OWNS THIS FILE.
// Slice version ships grunt + runner + a minimal boss so the loop is testable.
// Death must always route through killEnemy() (score, fx, drops, splitting).

import { ROAD_HALF, DESPAWN_BEHIND } from './config.js';
import { clamp, rand, chance } from './utils.js';
import { project } from './render.js';
import { fireEnemyShot } from './projectiles.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { damagePlayer } from './player.js';
import { spawnPickup } from './pickups.js';

export const ENEMY_TYPES = {
  grunt: {
    hp: 22, speed: 130, damage: 10, radius: 17, score: 10,
    color: '#e5484d', behavior: 'rush', dropChance: 0.04,
  },
  runner: {
    hp: 12, speed: 260, damage: 8, radius: 13, score: 15,
    color: '#ff9f43', behavior: 'zigzag', dropChance: 0.04,
  },
  boss: {
    hp: 2600, speed: 90, damage: 30, radius: 55, score: 1000,
    color: '#b23bc9', behavior: 'boss', dropChance: 0, isBoss: true, name: 'WARLORD',
  },
};

export function spawnEnemy(game, typeKey, x, z, opts = {}) {
  const t = ENEMY_TYPES[typeKey];
  if (!t) { console.error(`Unknown enemy type: ${typeKey}`); return null; }
  const hpScale = opts.hpScale ?? game.level.hpScale ?? 1;
  const e = {
    type: typeKey, def: t,
    x, z,
    hp: t.hp * hpScale, maxHp: t.hp * hpScale,
    speed: t.speed * (opts.speedScale ?? 1),
    damage: t.damage,
    radius: t.radius,
    score: t.score,
    color: t.color,
    behavior: t.behavior,
    flash: 0, age: 0, phase: rand(0, Math.PI * 2),
    fireTimer: rand(0.5, 1.5),
    state: 0, stateT: 0,
    isBoss: !!t.isBoss,
    dead: false,
    ...opts.extra,
  };
  game.enemies.push(e);
  if (e.isBoss) {
    game.boss = e;
    audio.bossRoar();
    fx.shake(8, 0.6);
  }
  return e;
}

// ---- behaviors: (e, dt, game) => void --------------------------------------
const behaviors = {
  rush(e, dt, game) {
    e.z -= e.speed * dt;
    // mild homing toward the player's lane
    const dx = game.player.x - e.x;
    e.x += clamp(dx, -60, 60) * dt * 0.8;
  },

  zigzag(e, dt, game) {
    e.z -= e.speed * dt;
    e.x += Math.sin(e.age * 5 + e.phase) * 190 * dt;
    e.x = clamp(e.x, -ROAD_HALF + e.radius, ROAD_HALF - e.radius);
  },

  boss(e, dt, game) {
    const targetZ = game.player.z + 620;
    e.z += clamp(targetZ - e.z, -140, 140) * dt;
    e.x = Math.sin(e.age * 0.7) * (ROAD_HALF - e.radius - 20);
    e.fireTimer -= dt;
    if (e.fireTimer <= 0) {
      e.fireTimer = 1.4;
      for (let i = -1; i <= 1; i++) {
        fireEnemyShot(game, e.x + i * 30, e.z, game.player.x + i * 90, game.player.z, 420, 12);
      }
    }
  },
};

export function updateEnemies(game, dt) {
  for (const e of game.enemies) {
    if (e.dead) continue;
    e.age += dt;
    e.flash = Math.max(0, e.flash - dt);
    (behaviors[e.behavior] || behaviors.rush)(e, dt, game);
    // Passed behind the player: despawn silently (no damage, no reward)
    if (!e.isBoss && e.z < game.player.z - DESPAWN_BEHIND) e.dead = true;
  }
}

// Central death hook — collisions.js calls this. cause: 'shot'|'explosion'|'contact'
export function killEnemy(game, e, cause = 'shot') {
  if (e.dead) return;
  e.dead = true;
  game.score += e.score;
  game.kills++;
  fx.explosion(e.x, e.z, e.radius * 1.4, e.color);
  fx.textPop(e.x, e.z, `+${e.score}`, '#ffd166');
  audio.enemyDie();
  if (e.def.dropChance && chance(e.def.dropChance)) {
    spawnPickup(game, 'heal', e.x, e.z);
  }
  if (e.isBoss) {
    game.boss = null;
    game.bossDefeated = true;
    fx.shake(14, 0.8);
    fx.flash('#ffffff', 0.5, 0.6);
    audio.explode();
  }
}

// Enemy touched the player: hurt the player, enemy dies (no reward)
export function enemyContact(game, e) {
  damagePlayer(game, e.damage);
  if (!e.isBoss) {
    e.dead = true;
    fx.explosion(e.x, e.z, e.radius, e.color);
  }
}

// ---- drawing ----------------------------------------------------------------
export function drawEnemies(ctx, view, game) {
  const sorted = [...game.enemies].sort((a, b) => b.z - a.z);
  for (const e of sorted) {
    if (e.dead) continue;
    const { sx, sy, f } = project(view, e.x, e.z);
    const s = f * view.unitScale * 0.16;
    const r = e.radius * s * 2.4;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // Eyes to signal "hostile facing you"
    ctx.fillStyle = '#0b0e1a';
    ctx.beginPath();
    ctx.arc(-r * 0.3, r * 0.15, r * 0.16, 0, Math.PI * 2);
    ctx.arc(r * 0.3, r * 0.15, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
    // HP bar for damaged non-trivial enemies
    if (e.hp < e.maxHp && (e.maxHp > 30 || e.isBoss)) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(-r, -r - 8, r * 2, 4);
      ctx.fillStyle = '#ff5964';
      ctx.fillRect(-r, -r - 8, r * 2 * (e.hp / e.maxHp), 4);
    }
    ctx.restore();
  }
}
