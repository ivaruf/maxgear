// Player + allied squad + flywheels: movement, auto-fire, damage intake.
// PLAYER-AGENT OWNS THIS FILE.
//
// v1.2: stats are DERIVED (upgrades.js recomputeStats(player) rewrites the whole
// stats object from player.tracks). Nothing here may write stats — a recompute
// would erase it. That is why ally deaths bump player.squadLost instead of
// shrinking stats.squad (the old bug: recompute resurrected the dead escort).
//
// ============================================================================
// CONTRACTS EXPOSED TO OTHER MODULES
// ============================================================================
//   player.saws = [{ x, z, radius, cd }]      collisions.js: saws x enemies
//        cd is a per-blade cooldown in seconds; collisions sets cd = 0.35 on a
//        hit, this module counts it down. radius is the hitbox (SACRED).
//        Damage/count/orbit come from stats.sawDmg / sawCount / sawR / sawSpin.
//   player.aegis / aegisT                     charges held / s to the next one
//   player.siphonBucket / siphonBucketT       HP siphoned this 1s window
//   player.squadLost                          escorts buried this run (permanent)
//   player.bulletStyle                        projectiles.js stamps it on spawn
//
//   damagePlayer(game, amount, ignoreInvuln = false, opts = {})
//        opts.bypassAegis  true = ignore aegis charges entirely (HULL BREACH)
//        Aegis is consumed BEFORE hp loss; armour scales what is left.
//   siphonHeal(game, e)                       enemies.killEnemy calls this
//
// ============================================================================
// CIRCULAR IMPORT (deliberate)
// ============================================================================
// player.js imports killEnemy from enemies.js (AEGIS COIL's shock wave must
// route deaths through the one death hook) while enemies.js imports
// damagePlayer/healPlayer/siphonHeal from here. ES modules tolerate a cycle as
// long as it is RUNTIME-ONLY: neither side touches the other's bindings while
// the modules are evaluating, and both are hoisted function declarations. Do not
// add a top-level call (or `const x = killEnemy`) to either side of this edge.
// Verified in node with BOTH entry orders (player-first and enemies-first).

import { ROAD_HALF, PLAYER_DEFAULTS, BASE_STATS, CAPS, CAM_BACK, FOCAL, ALLY_SHOT } from './config.js';
import { clamp } from './utils.js';
import { fireVolley, fireAux, AUX_ANGLES } from './projectiles.js';
import {
  createStyleSet, sameWeaponStats, snapshotWeaponStats, computeBulletStyle,
} from './bulletStyle.js';
import { trackLevel } from './upgrades.js';
import { killEnemy } from './enemies.js';        // see CIRCULAR IMPORT above
import { fx } from './effects.js';
import { audio } from './audio.js';
import { project } from './render.js';

const TAU = Math.PI * 2;
const AETHER = '#35e0ff';
const AEGIS_COL = '#8fe9ff';
const BRASS = '#c9973b';
const BRASS_HI = '#f0b429';
const COAL = '#0f0c09';
const BASE_SPEED = BASE_STATS.moveSpeed;   // 360 — plume reference

// AEGIS COIL (design §C S8)
const AEGIS_SHOCK_R = 110;      // damage radius of the LV3+ discharge
const AEGIS_CLEAR_R = 130;      // enemy shots deleted by the discharge
const AEGIS_IFRAMES = 0.4;      // grace after a shatter, so one wave != 2 charges

// FLYWHEELS (design §C S5)
export const SAW = {
  radius: 15,                   // hitbox radius (collisions.js reads saw.radius)
  teeth: 8,
};

export function createPlayer() {
  return {
    x: 0,
    z: 0,
    prevZ: 0,
    radius: PLAYER_DEFAULTS.radius,
    hp: PLAYER_DEFAULTS.maxHp,
    maxHp: PLAYER_DEFAULTS.maxHp,
    tracks: {},                       // upgrades.js level map (build state)
    stats: { ...BASE_STATS, maxHp: PLAYER_DEFAULTS.maxHp },
    allies: [],          // persistent squad ships (see ALLY below)
    squadLost: 0,        // escorts buried this run — recompute must NOT undo it
    saws: [],            // orbiting flywheels (collisions.js hits with them)
    aegis: 0,            // charges currently held
    aegisT: 0,           // s until the next charge
    siphonBucket: 0,     // HP siphoned inside the current 1s window
    siphonBucketT: 0,
    styles: createStyleSet(),   // double buffer: in-flight bullets keep theirs
    bulletStyle: null,          // set on the first updatePlayer
    styleFrom: {},              // last weapon-stat snapshot the style was built from
    fireTimer: 0,
    invuln: 0,
    overdriveT: 0,   // OVERDRIVE pickup: s of 1.67x fire rate left
    hurtFlash: 0,
    dead: false,
  };
}

// Squad ships: orbit the main ship, fire the same volleys, and are MORTAL —
// they have their own HP, absorb enemy contact/shots, and die when spent.
// maxHp here is only the LV0 fallback: live HP comes from stats.allyHp (ESCORT).
export const ALLY = {
  radius: 12,
  maxHp: 60,
  orbitR: 46,          // world units around the player
  orbitSpeed: 1.15,    // rad/s
  invulnTime: 0.35,    // per-ally i-frames so one wave can't delete it instantly
  hurtBarTime: 1.6,    // s the mini HP bar lingers after damage
};

// Crash guards only — upgrades.finalize() already clamped everything to the
// design table. Runs after every gate (gates.js) so a hand-edited/legacy stats
// object can never put the sim into a NaN state.
export function clampStats(stats) {
  stats.squad = clamp(Math.round(stats.squad), 0, CAPS.squad);
  stats.projectiles = clamp(Math.round(stats.projectiles), 1, CAPS.projectiles);
  stats.fireInterval = Math.max(stats.fireInterval, CAPS.fireIntervalMin);
  stats.critChance = clamp(stats.critChance, 0, CAPS.critChance);
  stats.moveSpeed = clamp(stats.moveSpeed, 160, CAPS.moveSpeed);
  stats.damage = clamp(stats.damage, 1, CAPS.damage);
  // v1.2 fields (pierce/ricochet are RETIRED: lance/arc replaced them)
  stats.lance = clamp(Math.round(stats.lance || 0), 0, CAPS.lance);
  stats.chainJumps = clamp(Math.round(stats.chainJumps || 0), 0, CAPS.chainJumps);
  stats.sawCount = clamp(Math.round(stats.sawCount || 0), 0, CAPS.sawCount);
  stats.auxLv = clamp(Math.round(stats.auxLv || 0), 0, CAPS.auxLv);
  stats.blastR = clamp(stats.blastR || 0, 0, CAPS.blastR);
  stats.burnDps = clamp(stats.burnDps || 0, 0, CAPS.burnDps);
  stats.frostSlow = clamp(stats.frostSlow || 0, 0, CAPS.frostSlow);
  stats.siphon = clamp(stats.siphon || 0, 0, CAPS.siphon);
  stats.aegisMax = clamp(Math.round(stats.aegisMax || 0), 0, CAPS.aegisMax);
  stats.armor = clamp(stats.armor || 0, 0, CAPS.armor);
}

// Keep the ally roster in sync with the ESCORT track: upgrades grow the target
// (fresh ships arrive at full stats.allyHp), deaths are remembered in
// player.squadLost so a recompute can never resurrect a buried escort.
function syncAllies(game) {
  const p = game.player;
  const want = Math.max(0, Math.round(p.stats.squad || 0) - p.squadLost);
  const hp = p.stats.allyHp || ALLY.maxHp;
  while (p.allies.length < want) {
    p.allies.push({
      x: p.x, z: p.z,
      radius: ALLY.radius,
      hp, maxHp: hp,
      invuln: 0.6,     // spawn grace
      flash: 0, hurtT: 0,
      dead: false,
    });
  }
  if (p.allies.length > want) p.allies.length = want;
}

// FLYWHEELS: blades are pooled like allies, then placed on the orbit every
// frame. collisions.js owns the hits; this only moves them and ticks cd.
function updateSaws(game, dt) {
  const p = game.player;
  const s = p.stats;
  const want = Math.max(0, Math.round(s.sawCount || 0));
  while (p.saws.length < want) p.saws.push({ x: p.x, z: p.z, radius: SAW.radius, cd: 0 });
  if (p.saws.length > want) p.saws.length = want;

  const n = p.saws.length;
  if (!n) return;
  const orbit = s.sawR || 0;
  const spin = s.sawSpin || 0;
  for (let i = 0; i < n; i++) {
    const saw = p.saws[i];
    const ang = game.time * spin + (i / n) * TAU;
    saw.x = clamp(p.x + Math.cos(ang) * orbit, -ROAD_HALF + saw.radius, ROAD_HALF - saw.radius);
    saw.z = p.z + Math.sin(ang) * orbit;
    saw.cd = Math.max(0, saw.cd - dt);
  }
}

// AEGIS COIL: charges tick back up on their own; a full coil parks the timer at
// aegisCd so the next shatter starts a whole cooldown.
function updateAegis(game, dt) {
  const p = game.player;
  const s = p.stats;
  const max = Math.round(s.aegisMax || 0);
  if (max <= 0) { p.aegis = 0; p.aegisT = 0; return; }
  if (p.aegis > max) p.aegis = max;           // rust removed a level
  if (p.aegis >= max) { p.aegisT = s.aegisCd; return; }
  p.aegisT -= dt;
  if (p.aegisT <= 0) {
    p.aegis++;
    p.aegisT = s.aegisCd;
    audio.click();
    fx.hitSpark(p.x, p.z + 8, AEGIS_COL);     // small "coil charged" ping
  }
}

export function updatePlayer(game, dt, input) {
  const p = game.player;

  // ---- bullet style: recompute ONLY when a weapon stat actually changed ----
  // Double buffer (styles.slots[0|1]): bullets already in the air keep the slot
  // they spawned with, so a gate crossed mid-flight never restyles old shots.
  if (!sameWeaponStats(p.stats, p.styleFrom)) {
    snapshotWeaponStats(p.stats, p.styleFrom);
    const next = p.styles.slots[p.styles.cur ^= 1];
    computeBulletStyle(p.stats, next);
    p.bulletStyle = next;
  }

  p.prevZ = p.z;
  p.z += game.runSpeed * dt;

  // Keyboard steering
  let vx = input.axis() * p.stats.moveSpeed;
  p.x += vx * dt;
  // Pointer drag: CSS px -> world units at player depth
  const dragPx = input.takeDrag();
  if (dragPx !== 0) {
    const fPlayer = FOCAL / (FOCAL + CAM_BACK);
    p.x += dragPx / (game.view.unitScale * fPlayer);
  }
  p.x = clamp(p.x, -ROAD_HALF + p.radius, ROAD_HALF - p.radius);

  // ---- allies: bury the dead, sync with stats, orbit the mothership --------
  for (let i = p.allies.length - 1; i >= 0; i--) {
    if (p.allies[i].dead) { p.allies.splice(i, 1); p.squadLost++; }
  }
  syncAllies(game);
  const n = p.allies.length;
  for (let i = 0; i < n; i++) {
    const a = p.allies[i];
    const ang = game.time * ALLY.orbitSpeed + (i / n) * Math.PI * 2;
    a.x = clamp(p.x + Math.cos(ang) * ALLY.orbitR, -ROAD_HALF + a.radius, ROAD_HALF - a.radius);
    a.z = p.z + Math.sin(ang) * ALLY.orbitR;
    a.invuln = Math.max(0, a.invuln - dt);
    a.flash = Math.max(0, a.flash - dt);
    a.hurtT = Math.max(0, a.hurtT - dt);
  }

  updateSaws(game, dt);

  // Auto-fire: player + every living ally fires the full volley, then the
  // broadside ring (same timer, so ROF upgrades feed it too)
  // OVERDRIVE pickup: temporary fire-rate surge. A timer, NOT a stat write —
  // recomputeStats() would erase a stat mutation (see DESIGN.md derived stats).
  p.overdriveT = Math.max(0, (p.overdriveT || 0) - dt);
  p.fireTimer -= dt;
  if (p.fireTimer <= 0) {
    p.fireTimer = p.stats.fireInterval * (p.overdriveT > 0 ? 0.6 : 1);
    fireVolley(game, p.x, p.z + 20, p.stats);
    // v1.5.3: escorts volley in sync but derated — half damage, smaller shells
    for (const a of p.allies) fireVolley(game, a.x, a.z + 14, p.stats, ALLY_SHOT);
    if (p.stats.auxLv > 0) fireAux(game, p.x, p.z, p.stats);
    audio.shoot();
  }

  updateAegis(game, dt);

  // CONDENSER: the siphon cap is per SECOND, so the bucket empties on a 1s tick
  p.siphonBucketT += dt;
  if (p.siphonBucketT >= 1) { p.siphonBucketT = 0; p.siphonBucket = 0; }

  p.invuln = Math.max(0, p.invuln - dt);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt);
}

// An ally got hit (collisions.js). Own HP, own i-frames, no revive.
export function damageAlly(game, ally, amount) {
  if (ally.dead || ally.invuln > 0 || game.state !== 'playing') return;
  ally.hp -= amount;
  ally.invuln = ALLY.invulnTime;
  ally.flash = 0.2;
  ally.hurtT = ALLY.hurtBarTime;
  fx.hitSpark(ally.x, ally.z, '#2fb8d6');
  audio.hit();
  if (ally.hp <= 0) {
    ally.hp = 0;
    ally.dead = true;
    fx.explosion(ally.x, ally.z, 46, '#2fb8d6');
    fx.textPop(ally.x, ally.z + 20, 'ALLY DOWN', '#8fd8ff');
    audio.explode();
  }
}

// AEGIS COIL LV3+: the shatter discharges into the crowd and wipes incoming
// fire. Deaths route through killEnemy so score/splits/drops all still happen.
function aegisShock(game, p, dmg) {
  fx.explosion(p.x, p.z, AEGIS_SHOCK_R * 0.8, AEGIS_COL);
  const r2 = AEGIS_SHOCK_R * AEGIS_SHOCK_R;
  // snapshot length: killEnemy can push split minis into the array mid-loop
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (e.dead) continue;
    const dx = e.x - p.x, dz = e.z - p.z;
    if (dx * dx + dz * dz > r2) continue;
    if (e.shieldHp > 0) {          // plates eat it first, like blast splash
      e.shieldHp -= dmg;
      e.shieldFlash = 0.1;
      continue;
    }
    e.hp -= dmg;
    e.flash = 0.07;
    if (e.hp <= 0) killEnemy(game, e, 'explosion');
  }
  const c2 = AEGIS_CLEAR_R * AEGIS_CLEAR_R;
  for (const s of game.enemyShots) {
    if (s.dead) continue;
    const dx = s.x - p.x, dz = s.z - p.z;
    if (dx * dx + dz * dz > c2) continue;
    s.dead = true;
    fx.hitSpark(s.x, s.z, AEGIS_COL);
  }
}

export function damagePlayer(game, amount, ignoreInvuln = false, opts = {}) {
  const p = game.player;
  if (p.dead || game.state !== 'playing') return;
  const s = p.stats;

  // ---- AEGIS COIL: a charge eats the WHOLE hit, before any hp is lost ------
  // HULL BREACH passes { bypassAegis: true } — the one thing the coil can't
  // stop. Post-hit i-frames still swallow the hit first (the check below
  // mirrors the vulnerability rule), so one wave never burns two charges.
  if (p.aegis > 0 && !opts.bypassAegis && (p.invuln <= 0 || ignoreInvuln)) {
    p.aegis--;
    p.aegisT = s.aegisCd;
    fx.explosion(p.x, p.z, 54, AEGIS_COL);      // cyan shatter ring
    fx.textPop(p.x, p.z + 30, 'AEGIS', AEGIS_COL);
    fx.shake(4, 0.2);
    audio.hit();
    if (s.aegisShock > 0) aegisShock(game, p, s.aegisShock);
    p.invuln = Math.max(p.invuln, AEGIS_IFRAMES);
    return;
  }

  if (p.invuln > 0 && !ignoreInvuln) return;
  amount *= 1 - (s.armor || 0);                 // ARMOUR PLATE LV3+
  p.hp -= amount;
  // never shorten an active shield-token window (ignoreInvuln hits would otherwise reset it)
  p.invuln = Math.max(p.invuln, PLAYER_DEFAULTS.invulnTime);
  p.hurtFlash = 0.25;
  fx.shake(6, 0.25);
  fx.flash('#ff2233', 0.22, 0.25);
  audio.hurt();
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    fx.explosion(p.x, p.z, 90, '#35e0ff');
    audio.explode();
  }
}

export function healPlayer(game, amount, quiet = false) {
  const p = game.player;
  if (p.dead) return; // a heal collected during the death beat must not revive the HUD
  const used = Math.min(p.maxHp - p.hp, amount);
  p.hp += used;
  if (used > 0 && !quiet) fx.textPop(p.x, p.z + 30, `+${Math.round(used)}`, '#56b06c');
  // Overflow repairs the most damaged ally instead of evaporating.
  let over = amount - used;
  if (over > 0 && p.allies.length) {
    let worst = null;
    for (const a of p.allies) {
      if (a.hp < a.maxHp && (!worst || a.hp / a.maxHp < worst.hp / worst.maxHp)) worst = a;
    }
    if (worst) {
      worst.hp = Math.min(worst.maxHp, worst.hp + over);
      if (!quiet) {
        fx.textPop(worst.x, worst.z + 20, `+${Math.round(over)}`, '#8fd8ff');
        fx.hitSpark(worst.x, worst.z, '#8fd8ff');
      }
    }
  }
}

/**
 * CONDENSER (design §C S8). enemies.killEnemy calls this for every death.
 * stats.siphon HP per kill, hard-capped at stats.siphonCap per second by
 * player.siphonBucket (reset on the 1s tick in updatePlayer), so a wave wipe
 * can never full-heal the hull. Heals quietly: the green thread IS the read.
 */
export function siphonHeal(game, e) {
  const p = game.player;
  if (!p || p.dead) return;
  const s = p.stats;
  if (!(s.siphon > 0)) return;
  if (p.siphonBucket >= s.siphonCap) return;
  const heal = Math.min(s.siphon, s.siphonCap - p.siphonBucket);
  if (!(heal > 0)) return;
  p.siphonBucket += heal;
  healPlayer(game, heal, true);
  fx.siphonThread(e.x, e.z, p.x, p.z);
}

// ---- drawing ----------------------------------------------------------------

// THRUST plume: length tracks moveSpeed (360 baseline -> 560 at LV5).
function drawPlume(ctx, s, stats, t) {
  const k = clamp(1 + ((stats.moveSpeed || BASE_SPEED) - BASE_SPEED) / 300, 0.7, 2.2);
  const len = 13 * s * k;
  const w = 4.6 * s;
  const flick = 0.78 + 0.22 * Math.sin(t * 23);
  ctx.save();
  ctx.globalAlpha = 0.4 * flick;
  ctx.fillStyle = AETHER;
  ctx.beginPath();
  ctx.moveTo(-w, 8 * s);
  ctx.lineTo(0, 8 * s + len);
  ctx.lineTo(w, 8 * s);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.7 * flick;
  ctx.fillStyle = '#d9fbff';
  ctx.beginPath();
  ctx.moveTo(-w * 0.42, 8 * s);
  ctx.lineTo(0, 8 * s + len * 0.55);
  ctx.lineTo(w * 0.42, 8 * s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ARMOUR PLATE: one brass strip per positive level bolted along the hull edges;
// negative levels (glass cannon / rust) tear a sparking hole instead.
function drawPlating(ctx, s, lv, t) {
  if (lv > 0) {
    const n = Math.min(lv, 5);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < n; i++) {
        const f0 = 0.3 + (i / n) * 0.58;
        const f1 = f0 + 0.4 / n;
        const x0 = side * 13 * s * f0, y0 = -18 * s + 28 * s * f0;
        const x1 = side * 13 * s * f1, y1 = -18 * s + 28 * s * f1;
        ctx.strokeStyle = BRASS;
        ctx.lineWidth = Math.max(1.4, 2.4 * s);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.strokeStyle = BRASS_HI;                   // bolt-line highlight
        ctx.lineWidth = Math.max(0.8, 0.9 * s);
        ctx.beginPath();
        ctx.moveTo(x0 - side * 1.2 * s, y0);
        ctx.lineTo(x1 - side * 1.2 * s, y1);
        ctx.stroke();
      }
    }
    return;
  }
  if (lv >= 0) return;
  // stripped hull: dark patch (one per missing level) + intermittent sparks
  const holes = Math.min(-lv, 2);
  for (let i = 0; i < holes; i++) {
    const hx = (i === 0 ? -1 : 1) * 6.2 * s;
    const hy = (i === 0 ? 2.2 : -1.4) * s;
    ctx.fillStyle = 'rgba(10,8,5,0.72)';
    ctx.beginPath();
    ctx.moveTo(hx - 3 * s, hy - 2 * s);
    ctx.lineTo(hx + 2.4 * s, hy - 3 * s);
    ctx.lineTo(hx + 3 * s, hy + 2.6 * s);
    ctx.lineTo(hx - 2 * s, hy + 3 * s);
    ctx.closePath();
    ctx.fill();
    if (Math.sin(t * 31 + i * 2.1) > 0.62) {          // arcing short
      ctx.strokeStyle = '#fff2a8';
      ctx.lineWidth = Math.max(1, 1.1 * s);
      ctx.beginPath();
      ctx.moveTo(hx - 2 * s, hy + 1.5 * s);
      ctx.lineTo(hx + 0.6 * s, hy - 0.7 * s);
      ctx.lineTo(hx + 2.4 * s, hy + 1.2 * s);
      ctx.stroke();
    }
  }
}

// BROADSIDE: one brass nub per real aux ray, so the hull tells you where the
// side guns point (angles come straight from projectiles.AUX_ANGLES).
function drawBarrels(ctx, s, auxLv) {
  const lv = Math.round(auxLv || 0);
  if (lv <= 0) return;
  const angles = AUX_ANGLES[clamp(lv, 1, AUX_ANGLES.length - 1)];
  if (!angles) return;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    const ux = Math.sin(a), uy = -Math.cos(a);        // world +z reads as -y
    const mx = ux * 5.5 * s, my = uy * 4 * s;
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = Math.max(1.3, 2.6 * s);
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx + ux * 5 * s, my + uy * 5 * s);
    ctx.stroke();
    ctx.fillStyle = BRASS_HI;
    ctx.beginPath();
    ctx.arc(mx + ux * 5.6 * s, my + uy * 5.6 * s, Math.max(0.9, 1.1 * s), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// AEGIS COIL: one bright ring per charge held, plus a dashed sweep showing the
// next charge winding up.
function drawAegisRing(ctx, s, player) {
  const stats = player.stats;
  const max = Math.round(stats.aegisMax || 0);
  if (max <= 0) return;
  ctx.save();
  const cy = -4 * s;
  for (let i = 0; i < player.aegis; i++) {
    const r = (30 + i * 4.5) * s;
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = AEGIS_COL;
    ctx.lineWidth = Math.max(1.4, 2 * s);
    ctx.beginPath();
    ctx.arc(0, cy, r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.9;                        // brass gap detail (icon language)
    ctx.strokeStyle = BRASS_HI;
    ctx.lineWidth = Math.max(1, 1.6 * s);
    ctx.beginPath();
    ctx.arc(0, cy, r, -Math.PI * 0.62, -Math.PI * 0.38);
    ctx.stroke();
  }
  if (player.aegis < max && stats.aegisCd > 0) {
    const prog = clamp(1 - player.aegisT / stats.aegisCd, 0, 1);
    const r = (30 + player.aegis * 4.5) * s;
    ctx.globalAlpha = 0.2 + prog * 0.32;
    ctx.strokeStyle = AEGIS_COL;
    ctx.lineWidth = Math.max(1, 1.5 * s);
    if (ctx.setLineDash) ctx.setLineDash([4 * s, 6 * s]);
    ctx.beginPath();
    ctx.arc(0, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
    ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([]);
  }
  ctx.restore();
}

// Steampunk gyro-wedge: aether-glow hull (silhouette unchanged for readability),
// brass trim, porthole cockpit, and a spinning brass tail gear driven by t.
// `player` is passed for the MAIN ship only: squad ships stay the plain hull so
// the two never blur together.
function drawShip(ctx, sx, sy, s, color, glow, t = 0, player = null) {
  const stats = player ? player.stats : null;
  ctx.save();
  ctx.translate(sx, sy);

  if (stats) drawPlume(ctx, s, stats, t);

  // Tail gear (behind the hull), slowly counter-rotating
  ctx.save();
  ctx.translate(0, 8 * s);
  ctx.rotate(t * 2.4);
  ctx.fillStyle = '#c9973b';
  const R = 6.5 * s, r = 4.6 * s;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2, a1 = a0 + Math.PI / 8;
    ctx.arc(0, 0, R, a0, a0 + Math.PI / 16);
    ctx.arc(0, 0, r, a1, a1 + Math.PI / 8);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8a6a2a';
  ctx.beginPath();
  ctx.arc(0, 0, 1.8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (stats) drawBarrels(ctx, s, stats.auxLv);

  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  // Hull: arrow-like wedge (same silhouette as pre-retheme)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -18 * s);
  ctx.lineTo(13 * s, 10 * s);
  ctx.lineTo(0, 4 * s);
  ctx.lineTo(-13 * s, 10 * s);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  // Brass trim along the hull edges
  ctx.strokeStyle = 'rgba(240,180,41,0.85)';
  ctx.lineWidth = Math.max(1, 1.3 * s);
  ctx.stroke();
  if (player) drawPlating(ctx, s, trackLevel(player, 'plating'), t);
  // Porthole cockpit: brass ring around glass
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(0, -4 * s, 3.4 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#c9973b';
  ctx.lineWidth = Math.max(1, 1.1 * s);
  ctx.stroke();
  if (player) drawAegisRing(ctx, s, player);
  ctx.restore();
}

// FLYWHEEL: brass toothed disc + gold bloom + a faint arc of the orbit it just
// swept (psx/psy = the ship's screen position, the orbit centre).
function drawSaw(ctx, view, game, saw, psx, psy) {
  const spin = game.player.stats.sawSpin || 0;
  const pos = project(view, saw.x, saw.z);
  const k = pos.f * view.unitScale;
  const r = Math.max(saw.radius * k, 2.5);

  ctx.save();
  const dx = pos.sx - psx, dy = pos.sy - psy;
  const orbitR = Math.hypot(dx, dy);
  if (orbitR > r) {                              // motion arc along the orbit
    const a0 = Math.atan2(dy, dx);
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = BRASS_HI;
    ctx.lineWidth = Math.max(1.5, r * 0.5);
    ctx.beginPath();
    ctx.arc(psx, psy, orbitR, a0, a0 + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.translate(pos.sx, pos.sy);
  ctx.globalAlpha = 0.22;                        // gold bloom
  ctx.fillStyle = BRASS_HI;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.5, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.rotate(game.time * spin);
  ctx.fillStyle = BRASS_HI;                      // teeth
  ctx.beginPath();
  const step = TAU / SAW.teeth;
  for (let i = 0; i < SAW.teeth; i++) {
    const a = i * step;
    ctx.lineTo(Math.cos(a - step * 0.3) * r * 0.74, Math.sin(a - step * 0.3) * r * 0.74);
    ctx.lineTo(Math.cos(a - step * 0.14) * r, Math.sin(a - step * 0.14) * r);
    ctx.lineTo(Math.cos(a + step * 0.14) * r, Math.sin(a + step * 0.14) * r);
    ctx.lineTo(Math.cos(a + step * 0.3) * r * 0.74, Math.sin(a + step * 0.3) * r * 0.74);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = BRASS;                         // body under the teeth
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.74, 0, TAU);
  ctx.fill();
  ctx.fillStyle = COAL;                          // hub
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.26, 0, TAU);
  ctx.fill();
  ctx.fillStyle = BRASS_HI;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.11, 0, TAU);
  ctx.fill();
  ctx.restore();
}

export function drawPlayer(ctx, view, game) {
  const p = game.player;
  if (p.dead) return;

  // Allies first (they orbit through both in-front and behind positions)
  for (let i = 0; i < p.allies.length; i++) {
    const a = p.allies[i];
    const pos = project(view, a.x, a.z);
    const as = pos.f * view.unitScale * 0.72;
    if (a.invuln > 0.4) ctx.globalAlpha = 0.55; // spawn/i-frame shimmer
    drawShip(ctx, pos.sx, pos.sy, as, a.flash > 0 ? '#ff8090' : '#2fb8d6', false, game.time + i * 1.7);
    ctx.globalAlpha = 1;
    // mini HP bar only while recently hurt — no permanent clutter
    if (a.hurtT > 0 && !a.dead) {
      const bw = 26 * as;
      ctx.globalAlpha = Math.min(1, a.hurtT / 0.4);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(pos.sx - bw / 2, pos.sy - 26 * as, bw, 3);
      ctx.fillStyle = '#2fb8d6';
      ctx.fillRect(pos.sx - bw / 2, pos.sy - 26 * as, bw * (a.hp / a.maxHp), 3);
      ctx.globalAlpha = 1;
    }
  }

  const { sx, sy, f } = project(view, p.x, p.z);
  const s = f * view.unitScale; // pixels per world unit at player depth

  // Saws ahead of the ship are further from the lens: draw them first
  for (const saw of p.saws) if (saw.z > p.z) drawSaw(ctx, view, game, saw, sx, sy);

  if (p.invuln > 0.55) {
    // long invulnerability (shield token) draws as a bubble, not a blink
    ctx.save();
    ctx.strokeStyle = 'rgba(53,224,255,0.8)';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#35e0ff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(sx, sy - 4 * s, 26 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (p.invuln > 0 && Math.floor(p.invuln * 20) % 2 === 0) {
    ctx.globalAlpha = 0.35;
  }
  drawShip(ctx, sx, sy, s, p.hurtFlash > 0 ? '#ff8090' : '#35e0ff', true, game.time, p);
  ctx.globalAlpha = 1;

  for (const saw of p.saws) if (saw.z <= p.z) drawSaw(ctx, view, game, saw, sx, sy);
}
