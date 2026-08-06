// Player projectile + enemy shot lifecycle. Collision resolution lives in
// collisions.js; this module only spawns, moves, steers, and draws.
//
// v1.2 (PROJECTILES + COLLISIONS rework). Everything an upgrade can do to a
// bullet is STAMPED AT SPAWN — nothing here reads player.stats after the fact,
// so a gate crossed mid-flight never retro-buffs shots already in the air.
//
// ============================================================================
// PROJECTILE CONTRACT (collisions.js is the only other reader)
// ============================================================================
//   x, z, vx, vz, radius          world position / velocity / hitbox (SACRED)
//   damage                        already includes the crit multiplier
//   crit                          bool: picks style.crit + gold spark/pop
//   lance                         remaining pierces (was `pierce`)
//   pierceShield                  1 = ignores enemy frontal plates (lance LV5)
//   blastR, blastFrac             explosion radius / splash fraction of damage
//   chainJumps, chainFrac, chainRange     tesla arc (main shots only)
//   burnDps, burnTime             incendiary status to apply on hit
//   frostSlow, frostTime, frostHard       cryo status (hard = cancels dashes)
//   homing, homeRange             steering rate (rad/s) + acquire radius
//   chained                       true once this shot has spent its ONE arc
//   aux                           true for broadside shots (never home/chain)
//   shard                         true for death-burst debris (no riders at all)
//   style                         bulletStyle.js style object (shared, immutable)
//   sx, sy, dr, rot, tier, skip   per-frame draw cache (drawProjectiles owns)
//   target, targetT               homing target cache + revalidate countdown
//   hits                          Set of enemies already pierced (lazy)
//   life, dead
// All three spawn paths emit that EXACT shape (one hidden class).
//
// EXPORTS
//   fireVolley(game, x, z, stats)      forward volley (player + each ally)
//   fireAux(game, x, z, stats)         broadside ring, AUX_ANGLES[auxLv]
//   spawnShards(game, e, stats)        death burst — called by enemies.killEnemy
//   fireEnemyShot(...)                 unchanged
//   updateProjectiles(game, dt)        integrate + homing steering (resets budgets)
//   drawProjectiles / drawEnemyShots
//   AUX_ANGLES                         frozen, indexed by auxLv 1..5

import { ROAD_HALF, PROJECTILE, LIMITS } from './config.js';
import { clamp } from './utils.js';
import { project } from './render.js';
import { fx } from './effects.js';
import { BASE_STYLE, ensureBulletSprites } from './bulletStyle.js';

const D2R = Math.PI / 180;

// ---- tuning ----------------------------------------------------------------

const HOME_RETARGET = 0.15;        // s between target revalidations
const HOME_DEV_MAX = 80 * D2R;     // max deviation from +z a homing shot may hold
const REAR_CULL = 220;             // rear shots die this far behind the player
const AUX_MUZZLE_OFF = 14;         // world units from hull centre to a side barrel
const SHARD_SPEED = 520;
const SHARD_LIFE = 0.45;
const SHARD_ARC = 200 * D2R;       // fan width, centred AWAY from the player
const SHARD_BUDGET = 24;           // hard cap on shards spawned per update step

// Aux fire angles, measured from +z (0 = straight ahead), radians.
// EVERY entry sits outside the ±55° forward cone so broadside can never be
// mistaken for the main gun (design §C S6). LV5 is a uniform 8-ray ring folded
// out of that cone: 8 rays over the remaining 250° arc => 31.25° apart.
const AUX_DEG = [
  null,
  [90, -90],                                        // LV1: two side guns
  [90, -90, 180],                                   // LV2: + rear
  [60, -60, 120, -120],                             // LV3: four quarters
  [60, -60, 120, -120, 160, -160],                  // LV4: + rear pair
  [70, -70, 101, -101, 133, -133, 164, -164],       // LV5: 8-way ring
];

export const AUX_ANGLES = Object.freeze(AUX_DEG.map(
  (a) => (a ? Object.freeze(a.map((d) => d * D2R)) : null),
));

// Per-step spawn budgets (reset at the top of updateProjectiles, which runs
// before enemies/collisions in main.js's fixed order).
let shardBudget = SHARD_BUDGET;
let auxPhase = 0;                  // alternates which barrels flash at 8-way

// ---- spawning --------------------------------------------------------------

const MODE_MAIN = 0, MODE_AUX = 1, MODE_SHARD = 2;

// The ONE projectile factory. `mode` decides which upgrade riders come along:
//   MAIN  everything
//   AUX   lance / blast / burn / frost (no homing, no chain)
//   SHARD nothing (debris cannot cascade: one generation only)
function makeProjectile(x, z, vx, vz, damage, crit, style, life, mode, stats) {
  const main = mode === MODE_MAIN;
  const carry = mode !== MODE_SHARD;
  return {
    x, z, vx, vz,
    radius: PROJECTILE.radius,
    damage,
    crit,
    lance: carry ? (stats.lance || 0) : 0,
    pierceShield: carry ? (stats.pierceShield || 0) : 0,
    blastR: carry ? (stats.blastR || 0) : 0,
    blastFrac: carry ? (stats.blastFrac || 0) : 0,
    chainJumps: main ? (stats.chainJumps || 0) : 0,
    chainFrac: main ? (stats.chainFrac || 0) : 0,
    chainRange: main ? (stats.chainRange || 0) : 0,
    burnDps: carry ? (stats.burnDps || 0) : 0,
    burnTime: carry ? (stats.burnTime || 0) : 0,
    frostSlow: carry ? (stats.frostSlow || 0) : 0,
    frostTime: carry ? (stats.frostTime || 0) : 0,
    frostHard: carry ? (stats.frostHard || 0) : 0,
    homing: main ? (stats.homing || 0) : 0,
    homeRange: main ? (stats.homeRange || 0) : 0,
    chained: false,
    aux: mode === MODE_AUX,
    shard: mode === MODE_SHARD,
    sizeMul: 1,          // draw-only scale (escort shells are 0.7); hitbox is `radius`
    style,
    sx: 0, sy: 0, dr: 0, rot: 0, tier: 0, skip: false,
    targetT: 0, target: null,
    hits: null,
    life,
    dead: false,
  };
}

// At the cap, recycle the oldest slot instead of refusing to fire — otherwise
// late squad members silently contribute nothing (QA MED-4).
function push(game, proj) {
  if (game.projectiles.length >= LIMITS.projectiles) {
    game.projCursor = (game.projCursor ?? 0) % LIMITS.projectiles;
    game.projectiles[game.projCursor++] = proj;
  } else {
    game.projectiles.push(proj);
  }
}

function critRoll(stats) {
  return Math.random() < stats.critChance;
}

function critDamage(stats, base, crit) {
  return crit ? base * (stats.critMul || 2) : base;
}

// Fire one forward volley from (x, z) using the shooter's stats.
// `tune` (optional, e.g. config.ALLY_SHOT) derates the volley: damage and the
// burn DoT scale by dmgMul, the shells DRAW at sizeMul (hitboxes untouched).
export function fireVolley(game, x, z, stats, tune) {
  const n = Math.round(stats.projectiles);
  const spread = (stats.spreadDeg * Math.PI) / 180;
  const style = (game.player && game.player.bulletStyle) || BASE_STYLE;
  const dmgMul = tune ? tune.dmgMul : 1;
  for (let i = 0; i < n; i++) {
    const angle = (i - (n - 1) / 2) * spread;
    const crit = critRoll(stats);
    const proj = makeProjectile(
      x, z,
      Math.sin(angle) * PROJECTILE.speed,
      Math.cos(angle) * PROJECTILE.speed,
      critDamage(stats, stats.damage, crit) * dmgMul, crit,
      style, PROJECTILE.life, MODE_MAIN, stats,
    );
    if (tune) {
      proj.sizeMul = tune.sizeMul;
      proj.burnDps *= dmgMul;
    }
    push(game, proj);
  }
  fx.muzzle(x, z + 24, 0, 1, style.spark, tune ? tune.sizeMul : 1);
}

/**
 * BROADSIDE (design §C S6). Fires the auxLv ring from (x, z); every ray sits
 * outside the ±55° forward cone. Called from player.js right next to
 * fireVolley, on the same fire timer. No-op at auxLv 0.
 */
export function fireAux(game, x, z, stats) {
  const lv = Math.round(stats.auxLv || 0);
  if (lv <= 0) return;
  const angles = AUX_ANGLES[clamp(lv, 1, AUX_ANGLES.length - 1)];
  if (!angles) return;
  const base = stats.damage * (stats.auxFrac || 0);
  if (!(base > 0)) return;
  const style = (game.player && game.player.bulletStyle) || BASE_STYLE;

  // Muzzle flashes are 3 particles each: at 8 barrels that would crowd
  // LIMITS.particles, so wide rings flash alternating halves per volley.
  const stride = angles.length > 4 ? 2 : 1;
  const phase = stride > 1 ? (auxPhase++ & 1) : 0;

  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    const ux = Math.sin(a), uz = Math.cos(a);
    const crit = critRoll(stats);
    push(game, makeProjectile(
      x, z,
      ux * PROJECTILE.speed, uz * PROJECTILE.speed,
      critDamage(stats, base, crit), crit,
      style, PROJECTILE.life, MODE_AUX, stats,
    ));
    if ((i + phase) % stride === 0) {
      fx.muzzle(x + ux * AUX_MUZZLE_OFF, z + uz * AUX_MUZZLE_OFF, ux, uz, style.spark);
    }
  }
}

/**
 * DEATH BURST (design §C S7). Called from enemies.killEnemy for every cause
 * EXCEPT 'shrapnel' (one generation — shards must never cascade). Fans
 * shrapnelN shards ~200° AWAY from the player, so debris sprays outward/onward
 * into the wave instead of back into the ship.
 */
export function spawnShards(game, e, stats) {
  const want = Math.round(stats.shrapnelN || 0);
  if (want <= 0 || shardBudget <= 0) return;
  const damage = stats.damage * (stats.shrapnelFrac || 0);
  if (!(damage > 0)) return;

  const p = game.player;
  const n = Math.min(want, shardBudget);
  // heading from the player through the corpse = "away"; degenerate overlap
  // (shard spawned exactly on the ship) falls back to straight ahead
  const dx = e.x - p.x, dz = e.z - p.z;
  const away = (dx === 0 && dz === 0) ? 0 : Math.atan2(dx, dz);
  const style = (p && p.bulletStyle) || BASE_STYLE;

  for (let i = 0; i < n; i++) {
    const a = away + (n === 1 ? 0 : (i / (n - 1) - 0.5) * SHARD_ARC);
    push(game, makeProjectile(
      e.x, e.z,
      Math.sin(a) * SHARD_SPEED, Math.cos(a) * SHARD_SPEED,
      damage, false,
      style, SHARD_LIFE, MODE_SHARD, stats,
    ));
  }
  shardBudget -= n;
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

// ---- update ----------------------------------------------------------------

// Nearest living enemy inside p.homeRange. Boss included: a gyro build should
// track the IRONCLAD like anything else.
function acquireTarget(game, p) {
  const list = game.enemies;
  const n = list.length;
  let best = null, bestD = p.homeRange * p.homeRange;
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (e.dead) continue;
    const dx = e.x - p.x, dz = e.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// GYRO SHELL steering (design §C S4). Rotates the velocity toward the cached
// target at p.homing rad/s, preserving speed, and never lets total deviation
// from +z exceed ±80° — so a homing shot can curve but never boomerang.
// Target death drops the cache immediately: that is the LV5 "re-acquire after
// pierce" rider, no special case needed.
function steerHoming(game, p, dt) {
  if (p.target && p.target.dead) p.target = null;
  p.targetT -= dt;
  if (!p.target || p.targetT <= 0) {
    p.target = acquireTarget(game, p);
    p.targetT = HOME_RETARGET;
  }
  const t = p.target;
  if (!t) return;

  const speed = Math.hypot(p.vx, p.vz);
  if (!(speed > 0)) return;
  const cur = Math.atan2(p.vx, p.vz);
  const want = Math.atan2(t.x - p.x, t.z - p.z);
  let d = want - cur;
  d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;  // -PI..PI
  const step = p.homing * dt;
  const na = clamp(cur + clamp(d, -step, step), -HOME_DEV_MAX, HOME_DEV_MAX);
  p.vx = Math.sin(na) * speed;
  p.vz = Math.cos(na) * speed;
}

export function updateProjectiles(game, dt) {
  shardBudget = SHARD_BUDGET;          // per-step budget (design anti-degenerate)

  const rearZ = game.player.z - REAR_CULL;
  for (const p of game.projectiles) {
    if (p.dead) continue;
    if (p.homing > 0 && !p.aux && !p.shard) steerHoming(game, p, dt);
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.life -= dt;
    // rear cull: broadside shots fly backwards and enemies despawn 90 behind,
    // so anything this far back can never hit again
    if (p.life <= 0 || Math.abs(p.x) > ROAD_HALF + 60 || p.z < rearZ) {
      p.dead = true;
      p.target = null;                 // drop the enemy reference with the shot
    }
  }
  for (const s of game.enemyShots) {
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    s.life -= dt;
    if (s.life <= 0 || s.z < game.player.z - 80 || Math.abs(s.x) > ROAD_HALF + 80) s.dead = true;
  }
}

// ---- drawing ---------------------------------------------------------------
// Four passes, two composite switches, 1-2 drawImage per bullet (design
// VISUAL §C5). p.dr is the BASE draw radius; style.rx/ry live INSIDE the baked
// sprite proportions, so dr is never multiplied by them here.
//
//   pass0  project -> p.sx/p.sy/p.dr/p.rot/p.tier/p.skip, lazy sprite bake
//   pass1  'lighter'    aura blits   (MID + NEAR, alpha fades above 180 bullets)
//   pass2  source-over  body blits   (all tiers; legacy ellipse when unbaked)
//   pass3  'lighter'    live features (NEAR only, hard budget 60/frame)

const TIER_FAR = 0, TIER_MID = 1, TIER_NEAR = 2;
const TIER_MID_DR = 3.2, TIER_NEAR_DR = 7;
const ROT_EPS = 0.1;                 // below this the blit stays axis-aligned

function styleOf(p) {
  const st = p.style || BASE_STYLE;
  return (p.crit && st.crit) ? st.crit : st;
}

export function drawProjectiles(ctx, view, game) {
  const list = game.projectiles;
  const n = list.length;
  if (!n) return;

  const cullZ = view.camZ + 4;       // rear-gun safety: behind the lens
  let lastStyle = null;

  // ---- pass0: project + cache + lazy bake ----------------------------------
  for (let i = 0; i < n; i++) {
    const p = list[i];
    if (p.dead) { p.skip = true; continue; }
    p.skip = p.z < cullZ;
    if (p.skip) continue;
    const pr = project(view, p.x, p.z);
    p.sx = pr.sx;
    p.sy = pr.sy;
    p.dr = Math.max(p.radius * (p.sizeMul || 1) * pr.f * view.unitScale * 0.85, 2.4);
    p.tier = p.dr < TIER_MID_DR ? TIER_FAR : (p.dr < TIER_NEAR_DR ? TIER_MID : TIER_NEAR);
    p.rot = Math.atan2(p.vx * view.unitScale, p.vz * view.vScale);
    // styles are shared objects and ensureBulletSprites is a no-op once baked;
    // the identity check keeps it to ~2 real calls per frame
    if (p.style && p.style !== lastStyle) {
      lastStyle = p.style;
      ensureBulletSprites(p.style, view);
      if (p.style.crit) ensureBulletSprites(p.style.crit, view);
    }
  }

  // ---- pass1: additive auras (MID + NEAR) ---------------------------------
  const auraA = 1 - clamp((n - 180) / 220, 0, 0.75);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = auraA;
  for (let i = 0; i < n; i++) {
    const p = list[i];
    if (p.skip || p.tier === TIER_FAR) continue;
    const st = styleOf(p);
    if (!st.aura || !(st.ref > 0)) continue;
    const s = p.dr / st.ref;
    if (!(s > 0)) continue;
    const w = st.auraW * s, h = st.auraH * s;
    if (p.rot > ROT_EPS || p.rot < -ROT_EPS) {
      ctx.save();
      ctx.translate(p.sx, p.sy);
      ctx.rotate(p.rot);
      ctx.drawImage(st.aura, -st.auraCx * s, -st.auraCy * s, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(st.aura, p.sx - st.auraCx * s, p.sy - st.auraCy * s, w, h);
    }
  }

  // ---- pass2: bodies (every tier) -----------------------------------------
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  for (let i = 0; i < n; i++) {
    const p = list[i];
    if (p.skip) continue;
    const st = styleOf(p);
    const s = st.body && st.ref > 0 ? p.dr / st.ref : 0;
    if (s > 0) {
      const w = st.bodyW * s, h = st.bodyH * s;
      if (p.rot > ROT_EPS || p.rot < -ROT_EPS) {
        ctx.save();
        ctx.translate(p.sx, p.sy);
        ctx.rotate(p.rot);
        ctx.drawImage(st.body, -st.bodyCx * s, -st.bodyCy * s, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(st.body, p.sx - st.bodyCx * s, p.sy - st.bodyCy * s, w, h);
      }
      continue;
    }
    // FALLBACK: no sprite (headless canvas, frozen BASE_STYLE, failed bake).
    // Keeps the pre-v1.2 look, still honouring the style's aspect + hue.
    ctx.fillStyle = p.crit ? '#ffd166' : (st.core || '#8df3ff');
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, (st.rx || 1) * p.dr, (st.ry || 2.2) * p.dr, p.rot, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- pass3: live features (NEAR only, budgeted) -------------------------
  let extras = n <= 140 ? 60 : 0;
  if (extras > 0) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n && extras > 0; i++) {
      const p = list[i];
      if (p.skip || p.tier !== TIER_NEAR) continue;
      const st = styleOf(p);
      if (!st.body || !st.liveFeatures || !st.liveFeatures.length) continue;
      const lf = st.liveFeatures, mags = st.liveMags;
      for (let k = 0; k < lf.length; k++) lf[k].live(ctx, p, st, mags ? mags[k] : 1, game.time);
      extras--;
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 1;
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
