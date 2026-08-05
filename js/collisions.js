// ALL collision resolution. LEAD-OWNED.
// Circle vs circle in the x/z plane; gates are crossing bands.

import { circleHit, dist2 } from './utils.js';
import { killEnemy, enemyContact, interceptShot } from './enemies.js';
import { damageObstacle, obstacleContact } from './obstacles.js';
import { gateOnShot, applyGateSlot } from './gates.js';
import { collectPickup } from './pickups.js';
import { damagePlayer, damageAlly } from './player.js';
import { fx } from './effects.js';
import { audio } from './audio.js';

function hitEnemy(game, e, p) {
  // enemies.js may absorb/deflect the shot (e.g. shielded enemies)
  if (interceptShot(game, e, p)) return;
  e.hp -= p.damage;
  e.flash = 0.07;
  fx.hitSpark(p.x, p.z, p.crit ? '#ffd166' : '#9df3ff');
  fx.textPop(e.x, e.z, `${Math.round(p.damage)}`, p.crit ? '#ffd166' : '#ffffff');
  audio.hit();
  if (e.hp <= 0) killEnemy(game, e, 'shot');
}

function explode(game, p) {
  const radius = 70 + p.explosive * 20;
  fx.explosion(p.x, p.z, radius, '#ff8a5a');
  audio.explode();
  const r2 = (radius + 20) * (radius + 20);
  // index loop over a snapshot length: killEnemy() can push split minis into
  // the array mid-loop, and iterating them here would loop forever if a split
  // child ever splits again
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (e.dead) continue;
    if (dist2(e.x, e.z, p.x, p.z) < r2) {
      // splash hits shields first so shielded enemies keep their identity vs explosive builds
      if (e.shieldHp > 0) {
        e.shieldHp -= p.damage * 0.5;
        e.shieldFlash = 0.1;
        continue;
      }
      e.hp -= p.damage * 0.5;
      e.flash = 0.07;
      if (e.hp <= 0) killEnemy(game, e, 'explosion');
    }
  }
  for (const o of game.obstacles) {
    if (!o.dead && dist2(o.x, o.z, p.x, p.z) < r2) damageObstacle(game, o, p.damage * 0.5);
  }
}

// Redirect projectile toward the nearest other living enemy (ricochet upgrade)
function tryRicochet(game, p, exclude) {
  let best = null, bestD = 340 * 340;
  for (const e of game.enemies) {
    if (e.dead || e === exclude) continue;
    const d = dist2(e.x, e.z, p.x, p.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return false;
  const dx = best.x - p.x, dz = best.z - p.z;
  const len = Math.hypot(dx, dz) || 1;
  const speed = Math.hypot(p.vx, p.vz);
  p.vx = (dx / len) * speed;
  p.vz = (dz / len) * speed;
  p.ricochet--;
  return true;
}

export function resolveCollisions(game, dt) {
  const player = game.player;

  // ---- player projectiles vs enemies / obstacles / chargeable gates --------
  for (const p of game.projectiles) {
    if (p.dead) continue;

    const nE = game.enemies.length; // snapshot: kills may push split minis
    for (let i = 0; i < nE; i++) {
      const e = game.enemies[i];
      if (e.dead) continue;
      if (!circleHit(p, e)) continue;
      if (p.hits && p.hits.has(e)) continue;
      hitEnemy(game, e, p);
      // explosive detonates but no longer consumes the projectile outright:
      // pierce and ricochet still apply, so the upgrades stack as advertised
      if (p.explosive > 0) explode(game, p);
      if (e.dead && p.ricochet > 0 && tryRicochet(game, p, e)) break;
      if (p.pierce > 0) {
        p.pierce--;
        (p.hits ??= new Set()).add(e);
      } else {
        p.dead = true;
      }
      break;
    }
    if (p.dead) continue;

    for (const o of game.obstacles) {
      if (o.dead || !o.destructible) continue;
      if (circleHit(p, o)) {
        damageObstacle(game, o, p.damage);
        if (p.explosive > 0) explode(game, p);
        p.dead = true;
        break;
      }
    }
    if (p.dead) continue;

    // Chargeable gate slots: projectile crosses the gate line inside a slot
    for (const g of game.gates) {
      if (g.used) continue;
      const prevZ = p.z - p.vz * dt;
      if (prevZ < g.z && p.z >= g.z) {
        for (const s of g.slots) {
          if (s.chargeable && Math.abs(p.x - s.x) < s.halfW) {
            gateOnShot(game, g, s);
            fx.hitSpark(p.x, g.z, '#ffd166');
            p.dead = true;
            break;
          }
        }
      }
      if (p.dead) break;
    }
  }

  // ---- enemy shots vs player and allies --------------------------------------
  // Orbiting allies soak shots that pass through their circle: squad is armor.
  for (const s of game.enemyShots) {
    if (s.dead) continue;
    if (circleHit(s, player)) {
      s.dead = true;
      damagePlayer(game, s.damage);
      continue;
    }
    for (const a of player.allies) {
      if (a.dead) continue;
      if (circleHit(s, a)) {
        s.dead = true;
        damageAlly(game, a, s.damage);
        break;
      }
    }
  }

  // ---- enemies vs player and allies ------------------------------------------
  for (const e of game.enemies) {
    if (e.dead) continue;
    if (circleHit(e, player)) { enemyContact(game, e); continue; }
    for (const a of player.allies) {
      if (a.dead) continue;
      if (circleHit(e, a)) {
        damageAlly(game, a, e.damage);
        if (!e.isBoss) {
          e.dead = true;
          fx.explosion(e.x, e.z, e.radius, e.color);
        }
        break;
      }
    }
  }

  // ---- obstacles vs player --------------------------------------------------
  for (const o of game.obstacles) {
    if (o.dead) continue;
    if (circleHit(o, player)) obstacleContact(game, o);
  }

  // ---- pickups vs player ----------------------------------------------------
  for (const pk of game.pickups) {
    if (!pk.dead && circleHit(pk, player)) collectPickup(game, pk);
  }

  // ---- gates vs player (crossing band) --------------------------------------
  for (const g of game.gates) {
    if (g.used || g.dead) continue;
    if (player.prevZ < g.z && player.z >= g.z) {
      for (const s of g.slots) {
        if (Math.abs(player.x - s.x) < s.halfW + player.radius * 0.5) {
          applyGateSlot(game, g, s);
          break;
        }
      }
    }
  }
}
