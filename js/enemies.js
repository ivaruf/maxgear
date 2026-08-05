// Data-driven enemy system. ENEMY-AGENT OWNS THIS FILE.
// Roster: grunt runner tank shooter shield splitter mini charger boss (+ `elite` modifier).
// Death must always route through killEnemy() (score, fx, drops, splitting).
// Behaviors are named functions in `behaviors`; visuals are per-type in `SHAPES`.

import { ROAD_HALF, DESPAWN_BEHIND } from './config.js';
import { clamp, lerp, rand, randInt, chance } from './utils.js';
import { project } from './render.js';
import { fireEnemyShot, spawnShards } from './projectiles.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
// player.js imports killEnemy from HERE (aegis shock) — a deliberate runtime-only
// ES-module cycle, documented at the top of player.js. Nothing below runs at
// module-evaluation time, so both import orders are safe.
import { damagePlayer, siphonHeal } from './player.js';
import { trackLevel } from './upgrades.js';
import { spawnPickup } from './pickups.js';

const TAU = Math.PI * 2;
const DARK = '#0b0e1a';
const WINDUP = 0.38;          // s of visible charge before a ranged shot lands
const MAX_BOSS_ADDS = 10;     // live non-boss enemies the arena will tolerate
const SLAM_TELEGRAPH = 0.65;  // s of boss slam wind-up
const SLAM_SPEED = 760;       // u/s sideways slam speed

// `elite` modifier — same behavior, bigger/tougher/gold-plated.
const ELITE = { hpMul: 2.5, radiusMul: 1.3, scoreMul: 1.5, color: '#ffd166' };

export const ENEMY_TYPES = {
  grunt: {
    hp: 22, speed: 130, damage: 10, radius: 17, score: 10,
    color: '#e5484d', behavior: 'rush', dropChance: 0.04,
    homeRate: 0.8, homeMax: 62,
  },
  runner: {
    hp: 12, speed: 260, damage: 8, radius: 13, score: 15,
    color: '#ff9f43', behavior: 'zigzag', dropChance: 0.04,
    zigFreq: 5.2, zigAmp: 250, homeRate: 0.5, homeMax: 30,
  },
  tank: {
    hp: 130, speed: 66, damage: 24, radius: 26, score: 45,
    color: '#a2603f', behavior: 'heavy', dropChance: 0.12,
    homeRate: 0.22, homeMax: 20,
  },
  shooter: {
    hp: 40, speed: 165, damage: 12, radius: 16, score: 40,
    color: '#ff5d8f', behavior: 'shooter', dropChance: 0.1,
    holdRange: [500, 700], fireEvery: [1.6, 2.2], strafeSpeed: 120,
    shotSpeed: 430, shotDamage: 10, shotColor: '#ff8fb0',
  },
  shield: {
    hp: 46, speed: 112, damage: 14, radius: 19, score: 50,
    color: '#ffc247', behavior: 'guard', dropChance: 0.12,
    shieldHp: 60, shieldColor: '#8fd6ff', breakSpeedMul: 1.35, staggerTime: 0.55,
    homeRate: 0.6, homeMax: 42,
  },
  splitter: {
    hp: 58, speed: 108, damage: 12, radius: 21, score: 35,
    color: '#b84ecf', behavior: 'blob', dropChance: 0.06,
    splitInto: 'mini', splitCount: [2, 3], homeRate: 0.5, homeMax: 34,
  },
  mini: {
    hp: 8, speed: 235, damage: 5, radius: 10, score: 5,
    color: '#e58ae5', behavior: 'swarm', dropChance: 0.01,
    homeRate: 1.2, homeMax: 95,
  },
  charger: {
    hp: 46, speed: 160, damage: 26, radius: 18, score: 55,
    color: '#ff4d2e', behavior: 'charger', dropChance: 0.12,
    holdDist: 600, telegraph: 0.7, dashSpeed: 780, dashTime: 1.4, cooldown: 0.7,
    homeRate: 0.4, homeMax: 40,
  },
  boss: {
    // hp here is only the divisor baseline: main.js spawns the boss with an
    // hpScale computed from the player's ACTUAL dps (clamped 4k..45k) so the
    // fight lasts ~30s for any build; behaviors.boss adds a decay failsafe.
    hp: 3200, speed: 120, damage: 40, radius: 55, score: 1500,
    color: '#b23bc9', behavior: 'boss', dropChance: 0, isBoss: true, name: 'IRONCLAD',
    shotSpeed: 440, shotDamage: 12, shotColor: '#ff7ad9',
    // hp thirds -> phase index; every phase is a clean tuning block
    phases: [
      { holdZ: 620, strafe: 95, tint: '#b23bc9', fireEvery: 2.2, summonEvery: 6.0, slamEvery: 0 },
      { holdZ: 580, strafe: 132, tint: '#d4399b', fireEvery: 2.5, summonEvery: 5.5, slamEvery: 0 },
      { holdZ: 545, strafe: 185, tint: '#ff2b4e', fireEvery: 1.9, summonEvery: 5.0, slamEvery: 6.0 },
    ],
  },
};

export function spawnEnemy(game, typeKey, x, z, opts = {}) {
  const t = ENEMY_TYPES[typeKey];
  if (!t) { console.error(`Unknown enemy type: ${typeKey}`); return null; }
  const hpScale = opts.hpScale ?? game.level?.hpScale ?? 1;
  const elite = !!opts.elite;
  const radius = t.radius * (elite ? ELITE.radiusMul : 1);
  const maxHp = t.hp * hpScale * (elite ? ELITE.hpMul : 1);
  const shieldHp = (t.shieldHp ?? 0) * hpScale * (elite ? ELITE.hpMul : 1);
  const e = {
    type: typeKey, def: t,
    x: clamp(x, -ROAD_HALF + radius, ROAD_HALF - radius), z,
    hp: maxHp, maxHp,
    speed: t.speed * (opts.speedScale ?? 1),
    damage: t.damage,
    radius,
    score: Math.round(t.score * (elite ? ELITE.scoreMul : 1)),
    color: t.color,
    behavior: t.behavior,
    elite,
    flash: 0, age: 0, phase: rand(0, TAU),
    // ranged / telegraph
    fireTimer: t.fireEvery ? rand(t.fireEvery[0], t.fireEvery[1]) : rand(0.5, 1.5),
    charge: 0,
    // shared state machine (charger dash, boss slam, shield stagger)
    state: 0, stateT: 0, stagger: 0,
    strafeDir: chance(0.5) ? 1 : -1,
    holdDist: t.holdRange ? rand(t.holdRange[0], t.holdRange[1]) : (t.holdDist ?? 0),
    lockX: 0, dashVx: 0, dashVz: 0,
    shieldHp, shieldMaxHp: shieldHp, shieldFlash: 0,
    // status effects (design §C S2) — collisions.js APPLIES them, updateEnemies
    // ticks them. burnTick/frostFxT are internal throttles.
    burnT: 0, burnDps: 0, burnTick: 0, burnPips: 0,
    chillT: 0, chillSlow: 0, chillMul: 1, frostFxT: 0,
    // boss
    bossPhase: 1, phaseFlash: 0, summonTimer: 0, slamTimer: 0, patternI: 0,
    burstKind: null, burstLeft: 0, burstN: 0, burstGap: 0.1, burstT: 0, burstI: 0,
    burstFrom: 0, burstTo: 0,
    isBoss: !!t.isBoss,
    dead: false,
    ...opts.extra,
  };
  game.enemies.push(e);
  if (e.isBoss) {
    const ph = t.phases[0];
    e.color = ph.tint;
    e.fireTimer = 1.6;
    e.summonTimer = ph.summonEvery * 0.7;
    e.slamTimer = 5;
    game.boss = e;
    audio.bossRoar();
    fx.bossIntro ? fx.bossIntro() : fx.shake(8, 0.6);
  }
  return e;
}

// ---- shared movement helpers -------------------------------------------------
function homeX(e, dt, game, rate = 0.8, maxV = 60) {
  e.x += clamp((game.player.x - e.x) * rate, -maxV, maxV) * dt;
}

function clampToRoad(e) {
  e.x = clamp(e.x, -ROAD_HALF + e.radius, ROAD_HALF - e.radius);
}

// Strafe within the road, flipping direction at the edges.
function strafe(e, dt, speed, margin) {
  e.x += e.strafeDir * speed * dt;
  const lim = ROAD_HALF - e.radius - margin;
  if (e.x > lim) { e.x = lim; e.strafeDir = -1; }
  else if (e.x < -lim) { e.x = -lim; e.strafeDir = 1; }
}

// Hold a fixed distance ahead of the player. Non-boss types can never quite
// match the run speed, so the player always closes the gap eventually.
function holdAhead(e, dt, game, dist, fleeCap) {
  const dz = game.player.z + dist - e.z;
  e.z += clamp(dz * 2.2, -e.speed, fleeCap) * dt;
  return dz;
}

function liveAdds(game) {
  let n = 0;
  for (const o of game.enemies) if (!o.dead && !o.isBoss) n++;
  return n;
}

function shotFrom(game, e, tx, tz, speedMul = 1, dmgMul = 1, opts) {
  const d = e.def;
  fireEnemyShot(
    game, e.x, e.z - e.radius * 0.6, tx, tz,
    d.shotSpeed * speedMul, d.shotDamage * dmgMul,
    opts || { color: d.shotColor || '#ff7096' },
  );
}

// ---- behaviors: (e, dt, game) => void --------------------------------------
const behaviors = {
  // grunt: straight rush with mild lane-homing
  rush(e, dt, game) {
    if (e.stagger > 0) { e.stagger -= dt; return; }
    e.z -= e.speed * dt;
    homeX(e, dt, game, e.def.homeRate, e.def.homeMax);
    clampToRoad(e);
  },

  // runner: fast, pronounced zigzag with a slight pull toward the player's lane
  zigzag(e, dt, game) {
    e.z -= e.speed * dt;
    e.x += Math.sin(e.age * (e.def.zigFreq ?? 5.2) + e.phase) * (e.def.zigAmp ?? 250) * dt;
    homeX(e, dt, game, e.def.homeRate, e.def.homeMax);
    clampToRoad(e);
  },

  // tank: slow, barely homes, rumbles forward
  heavy(e, dt, game) {
    if (e.stagger > 0) { e.stagger -= dt; return; }
    e.z -= e.speed * dt;
    homeX(e, dt, game, e.def.homeRate, e.def.homeMax);
    clampToRoad(e);
  },

  // shooter: keeps its distance, strafes, fires telegraphed aimed shots
  shooter(e, dt, game) {
    const p = game.player;
    // leftover shooters must not camp the boss arena firing off-pattern
    if (game.boss) { behaviors.rush(e, dt, game); return; }
    holdAhead(e, dt, game, e.holdDist, Math.max(game.runSpeed * 0.9, 60));
    strafe(e, dt, e.def.strafeSpeed, 10);

    e.fireTimer -= dt;
    e.charge = e.fireTimer < WINDUP ? 1 - Math.max(e.fireTimer, 0) / WINDUP : 0;
    if (e.fireTimer <= 0) {
      e.fireTimer = rand(e.def.fireEvery[0], e.def.fireEvery[1]);
      e.charge = 0;
      if (e.z > p.z + 120) {
        // lead the shot: the player advances at runSpeed while it flies
        const flight = (e.z - p.z) / (e.def.shotSpeed + game.runSpeed);
        shotFrom(game, e, p.x, p.z + game.runSpeed * flight * 0.85);
        fx.hitSpark(e.x, e.z - e.radius, e.def.shotColor);
      }
    }
  },

  // shield: rusher behind a frontal plate; faster & angrier once the plate breaks
  guard(e, dt, game) {
    if (e.stagger > 0) {
      e.stagger -= dt;
      e.z -= e.speed * 0.15 * dt;   // planted, only creeping
      return;
    }
    e.z -= e.speed * (e.shieldHp > 0 ? 1 : e.def.breakSpeedMul) * dt;
    homeX(e, dt, game, e.def.homeRate, e.def.homeMax);
    clampToRoad(e);
  },

  // splitter: heavy wobbling blob
  blob(e, dt, game) {
    e.z -= e.speed * dt;
    e.x += Math.sin(e.age * 2.2 + e.phase) * 60 * dt;
    homeX(e, dt, game, e.def.homeRate, e.def.homeMax);
    clampToRoad(e);
  },

  // mini: small, jittery, aggressive homing
  swarm(e, dt, game) {
    e.z -= e.speed * dt;
    e.x += Math.sin(e.age * 8.5 + e.phase) * 70 * dt;
    homeX(e, dt, game, e.def.homeRate, e.def.homeMax);
    clampToRoad(e);
  },

  // charger: approach -> telegraph -> locked dash -> decelerate -> repeat
  charger(e, dt, game) {
    const p = game.player;
    const d = e.def;
    e.stateT += dt;
    switch (e.state) {
      case 0: {  // approach and settle at dash range
        const dz = holdAhead(e, dt, game, d.holdDist, Math.max(game.runSpeed * 0.95, 40));
        homeX(e, dt, game, d.homeRate, d.homeMax);
        clampToRoad(e);
        if (Math.abs(dz) < 90) { e.state = 1; e.stateT = 0; }
        break;
      }
      case 1: {  // plant feet and wind up (world-static: the player closes in)
        if (e.stateT >= d.telegraph) {
          e.lockX = p.x;
          const dx = e.lockX - e.x, dz = p.z - e.z;
          const len = Math.hypot(dx, dz) || 1;
          e.dashVx = (dx / len) * d.dashSpeed;
          e.dashVz = (dz / len) * d.dashSpeed;
          e.state = 2; e.stateT = 0;
          fx.hitSpark(e.x, e.z, '#fff2a8');
          fx.shake(3, 0.14);
        }
        break;
      }
      case 2: {  // committed dash — dodgeable, the target x is locked
        e.x += e.dashVx * dt;
        e.z += e.dashVz * dt;
        clampToRoad(e);
        if (e.stateT > d.dashTime || e.z <= p.z - 20) { e.state = 3; e.stateT = 0; }
        break;
      }
      case 3: {  // decelerate + cooldown, then re-engage if still ahead
        const k = Math.exp(-4 * dt);
        e.dashVx *= k; e.dashVz *= k;
        e.x += e.dashVx * dt;
        e.z += e.dashVz * dt;
        clampToRoad(e);
        if (e.stateT >= d.cooldown) {
          e.state = e.z > p.z + 200 ? 0 : 4;
          e.stateT = 0;
        }
        break;
      }
      default: {  // spent: coast past the player and despawn
        e.z -= e.speed * 0.4 * dt;
        break;
      }
    }
  },

  boss(e, dt, game) {
    const p = game.player;
    const ph = updateBossPhase(e, game);
    e.phaseFlash = Math.max(0, e.phaseFlash - dt);
    e.phaseInvuln = Math.max(0, (e.phaseInvuln || 0) - dt);

    // Failsafe: HP is DPS-scaled at spawn, but a pathological build (all bad
    // gates taken) could still stall out. After 75s the boss "overheats" and
    // decays, so the arena can never become an unwinnable trap.
    if (e.age > 75) {
      e.hp -= e.maxHp * 0.0025 * (e.age - 75) * dt;
      if (e.hp <= 0) { killEnemy(game, e, 'shot'); return; }
    }

    // Always sit 500-700 ahead: the arena has runSpeed 0, so this is pure control.
    e.z += clamp((p.z + ph.holdZ - e.z) * 1.8, -240, 240) * dt;

    // ---- movement / slam state machine
    if (e.state === 0) {
      strafe(e, dt, ph.strafe, 14);
      if (ph.slamEvery > 0) {
        e.slamTimer -= dt;
        if (e.slamTimer <= 0 && e.burstLeft <= 0) {
          e.state = 1; e.stateT = 0;
          e.lockX = clamp(p.x, -ROAD_HALF + e.radius, ROAD_HALF - e.radius);
          fx.shake(4, 0.2);
        }
      }
    } else if (e.state === 1) {          // slam wind-up (lane is telegraphed)
      e.stateT += dt;
      if (e.stateT >= SLAM_TELEGRAPH) { e.state = 2; e.stateT = 0; }
    } else if (e.state === 2) {          // sideways slam, z held (never reaches the player)
      e.stateT += dt;
      const dir = Math.sign(e.lockX - e.x) || e.strafeDir;
      e.x += dir * SLAM_SPEED * dt;
      const arrived = dir > 0 ? e.x >= e.lockX : e.x <= e.lockX;
      if (arrived || e.stateT > 1.2) {
        e.x = clamp(e.lockX, -ROAD_HALF + e.radius, ROAD_HALF - e.radius);
        e.state = 3; e.stateT = 0;
        fx.shake(11, 0.35);
        fx.flash(ph.tint, 0.2, 0.25);
        fx.explosion(e.x, e.z - e.radius, e.radius * 1.2, ph.tint);
        audio.explode();
        startBurst(e, 'slamwave', 1, 0.06);
      }
    } else {                             // recover
      e.stateT += dt;
      if (e.stateT >= 0.6) { e.state = 0; e.stateT = 0; e.slamTimer = ph.slamEvery; }
    }

    // ---- ranged patterns: wind-up flash, then a timed burst
    if (e.burstLeft > 0) {
      stepBurst(e, dt, game);
    } else if (e.state === 0) {
      e.fireTimer -= dt;
      e.charge = e.fireTimer < WINDUP ? 1 - Math.max(e.fireTimer, 0) / WINDUP : 0;
      if (e.fireTimer <= 0) {
        e.fireTimer = ph.fireEvery;
        e.charge = 0;
        if (e.bossPhase === 1) startBurst(e, 'volley', 3, 0.14);
        else if (e.bossPhase === 2) startSweep(e, chance(0.5) ? 1 : -1);
        else {
          e.patternI = (e.patternI + 1) % 2;
          startBurst(e, e.patternI === 0 ? 'fan' : 'arc', 1, 0.08);
        }
      }
    }

    // ---- adds
    e.summonTimer -= dt;
    if (e.summonTimer <= 0) {
      e.summonTimer = ph.summonEvery;
      summonAdds(game, e);
    }
  },
};

// ---- boss internals ---------------------------------------------------------
function updateBossPhase(e, game) {
  const phases = e.def.phases;
  const frac = e.hp / e.maxHp;
  const want = frac <= 0.33 ? 3 : frac <= 0.66 ? 2 : 1;
  if (want > e.bossPhase) {
    e.bossPhase = want;
    const ph = phases[want - 1];
    e.color = ph.tint;
    e.phaseFlash = 1.4;
    e.phaseInvuln = 1.2;   // brief shield during the transition beat
    e.burstLeft = 0;
    e.state = 0; e.stateT = 0;
    e.fireTimer = 1.0;
    e.summonTimer = 1.6;
    e.slamTimer = ph.slamEvery > 0 ? 3.2 : 0;
    fx.shake(12, 0.7);
    fx.flash(ph.tint, 0.32, 0.5);
    fx.explosion(e.x, e.z, e.radius * 1.6, ph.tint);
    fx.textPop(e.x, e.z + 30, want === 3 ? 'ENRAGED!' : 'PHASE 2', ph.tint);
    audio.bossRoar();
  }
  return phases[e.bossPhase - 1];
}

function startBurst(e, kind, count, gap) {
  e.burstKind = kind;
  e.burstLeft = count;
  e.burstN = count;
  e.burstGap = gap;
  e.burstT = 0;
  e.burstI = 0;
}

// P2 wiper: a wall of shots that walks across the road slightly slower than the
// player can run, so there is always a side that opens up.
function startSweep(e, dir) {
  const half = ROAD_HALF * 0.94;
  e.burstFrom = dir > 0 ? -half : half;
  e.burstTo = dir > 0 ? half : -half;
  startBurst(e, 'sweep', 11, 0.11);
}

function stepBurst(e, dt, game) {
  e.burstT -= dt;
  while (e.burstLeft > 0 && e.burstT <= 0) {
    emitBurst(e, game);
    e.burstI++;
    e.burstLeft--;
    e.burstT += e.burstGap;
  }
}

// Column index nearest the player, pushed 1-3 slots aside: the safe gap is
// always reachable in the shots' travel time but never where you already stand.
function gapIndex(e, game, n) {
  const half = ROAD_HALF * 0.94;
  const nearest = Math.round(((game.player.x + half) / (2 * half)) * (n - 1));
  return clamp(nearest + (chance(0.5) ? 1 : -1) * randInt(1, 3), 0, n - 1);
}

function emitBurst(e, game) {
  const p = game.player;
  const half = ROAD_HALF * 0.94;
  switch (e.burstKind) {
    case 'volley': {  // P1: three aimed shots, walking sideways
      shotFrom(game, e, p.x + (e.burstI - 1) * 70, p.z);
      break;
    }
    case 'sweep': {   // P2: sweeping fan
      const frac = e.burstN > 1 ? e.burstI / (e.burstN - 1) : 0.5;
      shotFrom(game, e, lerp(e.burstFrom, e.burstTo, frac), p.z);
      break;
    }
    case 'fan': {     // P3: wall of columns with one open corridor
      const n = 11;
      const gap = gapIndex(e, game, n);
      for (let i = 0; i < n; i++) {
        if (Math.abs(i - gap) <= 1) continue;
        shotFrom(game, e, -half + (2 * half * i) / (n - 1), p.z, 1.07);
      }
      break;
    }
    case 'arc': {     // P3: radial arc around the aim line, one wedge left open
      const n = 11;
      const gap = clamp(5 + (chance(0.5) ? 1 : -1) * randInt(1, 3), 0, n - 1);
      const a0 = Math.atan2(p.x - e.x, p.z - e.z);
      for (let i = 0; i < n; i++) {
        if (Math.abs(i - gap) <= 1) continue;
        const a = a0 + (i / (n - 1) - 0.5) * 1.0;
        shotFrom(game, e, e.x + Math.sin(a) * 700, e.z + Math.cos(a) * 700, 1.07);
      }
      break;
    }
    case 'slamwave': {  // P3: shockwave straight down the lane the boss slammed into
      const col = e.def.phases[2].tint;
      for (let i = -2; i <= 2; i++) {
        fireEnemyShot(
          game, e.x + i * 10, e.z - e.radius, e.x + i * 46, p.z,
          e.def.shotSpeed * 1.15, e.def.shotDamage, { color: col, radius: 12 },
        );
      }
      break;
    }
  }
}

function summonAdds(game, e) {
  const live = liveAdds(game);
  if (live >= MAX_BOSS_ADDS) return;
  const ph = e.bossPhase;
  const n = Math.min(ph === 1 ? randInt(2, 3) : 3, MAX_BOSS_ADDS - live);
  for (let i = 0; i < n; i++) {
    const type = ph === 1 ? 'grunt' : chance(ph === 2 ? 0.5 : 0.4) ? 'runner' : 'mini';
    // arena adds drop heals generously: killing them is the recovery mechanic
    spawnEnemy(game, type, e.x + rand(-140, 140), e.z - rand(40, 120), { extra: { dropChance: 0.3 } });
  }
  fx.hitSpark(e.x, e.z - e.radius, '#c060ff');
}

// ---- status effects (design §C S2) ------------------------------------------
// CRYO-VENT slows an enemy's WHOLE clock (movement, wind-ups, burst gaps, phase
// timers) by scaling the dt its behavior sees plus its own age. Bosses are
// floored at 0.7x so a frost build can never trivialise the arena.
const BURN_STEP = 0.25;          // s per incendiary tick
const FROST_FX_EVERY = 0.5;      // s between cryo puffs on one enemy
const BURN_PIP_EVERY = 3;        // ember/number on every 3rd tick only

function chillFactor(e) {
  if (!(e.chillT > 0)) return 1;
  const slow = clamp(e.chillSlow || 0, 0, 0.95);
  return e.isBoss ? Math.max(0.7, 1 - slow * 0.5) : 1 - slow;
}

// INCENDIARY: fixed 0.25s ticks so the dps is frame-rate independent. Deaths go
// through killEnemy with cause 'burn' (no shrapnel loop: shards use 'shrapnel').
function tickBurn(game, e, dt) {
  // Only the time the status actually has left may become ticks, so a burn can
  // never over-deliver its last partial step (total damage <= burnDps*burnTime).
  const step = Math.min(dt, e.burnT);
  e.burnT -= dt;
  e.burnTick += step;
  const mul = e.isBoss && trackLevel(game.player, 'burn') >= 5 ? 1.5 : 1;
  while (e.burnTick >= BURN_STEP && !e.dead) {
    e.burnTick -= BURN_STEP;
    const dmg = e.burnDps * BURN_STEP * mul;
    if (!(dmg > 0)) break;
    e.hp -= dmg;
    e.burnPips = (e.burnPips + 1) % BURN_PIP_EVERY;
    if (e.burnPips === 0) {                     // throttled: 1 ember + merged number
      fx.hitSpark(e.x, e.z, MOLTEN);
      const shown = Math.round(dmg);
      if (shown > 0) fx.textPop(e.x, e.z + 12, `${shown}`, MOLTEN, e);
    }
    if (e.hp <= 0) { killEnemy(game, e, 'burn'); return; }
  }
  if (e.burnT <= 0) { e.burnT = 0; e.burnDps = 0; e.burnTick = 0; }
}

// ---- update -----------------------------------------------------------------
export function updateEnemies(game, dt) {
  const list = game.enemies;
  const n = list.length;   // enemies summoned/split this frame start next frame
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (e.dead) continue;

    // chill first: k scales everything the enemy experiences this step
    if (e.chillT > 0) {
      e.chillT -= dt;
      e.chillMul = chillFactor(e);
      e.frostFxT -= dt;
      if (e.frostFxT <= 0) { e.frostFxT = FROST_FX_EVERY; fx.frostPuff(e.x, e.z); }
      if (e.chillT <= 0) { e.chillT = 0; e.chillSlow = 0; }
    } else {
      e.chillMul = 1;
    }
    const k = e.chillMul;

    e.age += dt * k;
    // flashes are player feedback, not enemy time: they decay in real seconds
    e.flash = Math.max(0, e.flash - dt);
    e.shieldFlash = Math.max(0, e.shieldFlash - dt);
    (behaviors[e.behavior] || behaviors.rush)(e, dt * k, game);
    if (e.burnT > 0) tickBurn(game, e, dt);
    if (e.dead) continue;
    // Passed behind the player: despawn silently (no damage, no reward)
    if (!e.isBoss && e.z < game.player.z - DESPAWN_BEHIND) e.dead = true;
  }
}

// Called by collisions.js BEFORE normal damage. Return true if this module
// fully handled the hit. The frontal shield eats shots until it breaks.
export function interceptShot(game, e, p) {
  if (e.dead) return false;
  // boss phase-transition shield: absorbs everything for a beat
  if (e.isBoss && e.phaseInvuln > 0) {
    fx.hitSpark(p.x, p.z, '#ffffff');
    return true;
  }
  // LANCE LV5 (pierceShield): the spike punches through frontal plates entirely,
  // so the shot falls through to normal hull damage. Checked AFTER the boss
  // phase shield — that one is a scripted beat and nothing bypasses it.
  if (p.pierceShield) return false;
  if (e.shieldHp <= 0) return false;
  if (p.vz <= 0) return false;                // hits from ahead bypass the plate
  const col = e.def.shieldColor || '#8fd6ff';
  e.shieldHp -= p.damage;
  e.shieldFlash = 0.09;
  fx.hitSpark(p.x, p.z, col);
  fx.textPop(e.x, e.z + 14, `${Math.round(p.damage)}`, col);
  audio.hit();
  if (e.shieldHp <= 0) {
    e.shieldHp = 0;
    e.stagger = e.def.staggerTime ?? 0.5;
    e.flash = 0.12;
    fx.explosion(e.x, e.z, e.radius * 1.1, col);
    fx.textPop(e.x, e.z + 30, 'SHIELD DOWN', col);
    fx.shake(5, 0.22);
    audio.explode();
  }
  return true;
}

// INCENDIARY LV4 rider: a burning corpse lights its neighbours. Refresh, never
// stack (the hottest dps and the longest timer win), and only enemies that are
// ALREADY on the field — minis split by this same death stay clean, so a
// splitter chain can never self-sustain a firestorm.
function spreadBurn(game, e, stats) {
  const r = stats.burnSpread;
  const r2 = r * r;
  const dps = e.burnDps;
  const time = stats.burnTime || e.burnT;
  if (!(dps > 0) || !(time > 0)) return;
  let arcs = 3;                                  // fx budget: 3 visible jumps
  const n = game.enemies.length;                 // snapshot length
  for (let i = 0; i < n; i++) {
    const o = game.enemies[i];
    if (o === e || o.dead) continue;
    const dx = o.x - e.x, dz = o.z - e.z;
    if (dx * dx + dz * dz > r2) continue;
    if (o.burnDps < dps) o.burnDps = dps;
    if (o.burnT < time) o.burnT = time;
    if (arcs-- > 0) fx.arc(e.x, e.z, o.x, o.z, MOLTEN, 1.6, 0.12);
  }
}

// Central death hook — collisions.js calls this.
// cause: 'shot' | 'explosion' | 'contact' | 'chain' | 'saw' | 'shrapnel' | 'burn'
//   'shrapnel' is the ONE cause that suppresses a new death burst (one
//   generation only); everything else spawns shards, siphons HP and spreads fire.
export function killEnemy(game, e, cause = 'shot') {
  if (e.dead) return;
  e.dead = true;
  game.score += e.score;
  game.kills++;
  fx.explosion(e.x, e.z, e.radius * 1.4, e.color);
  fx.textPop(e.x, e.z, `+${e.score}`, e.elite ? ELITE.color : '#ffd166');
  audio.enemyDie();

  // ---- on-death upgrade riders (design §C S7/S8 + INCENDIARY LV4) ----------
  const stats = game.player.stats;
  if (cause !== 'shrapnel' && stats.shrapnelN > 0) spawnShards(game, e, stats);
  siphonHeal(game, e);
  if (e.burnT > 0 && stats.burnSpread > 0) spreadBurn(game, e, stats);

  // splitter -> minis, spawned at the death site with slight x offsets.
  // Never closer than 70 ahead of the player: a point-blank split would put
  // minis inside the player's hitbox before any dodge is possible.
  if (e.def.splitInto) {
    const n = randInt(e.def.splitCount[0], e.def.splitCount[1]);
    const zMin = game.player.z + 70;
    for (let i = 0; i < n; i++) {
      const ox = (i - (n - 1) / 2) * 26 + rand(-6, 6);
      spawnEnemy(game, e.def.splitInto, e.x + ox, Math.max(e.z + rand(-12, 12), zMin));
    }
    fx.hitSpark(e.x, e.z, e.color);
  }

  const dropChance = e.dropChance ?? e.def.dropChance;
  if (e.elite || (dropChance && chance(dropChance))) {
    spawnPickup(game, 'heal', e.x, e.z);
  }
  if (e.isBoss) {
    game.boss = null;
    game.bossDefeated = true;
    fx.shake(14, 0.8);
    fx.flash('#ffffff', 0.5, 0.6);
    fx.explosion(e.x, e.z, e.radius * 2.6, e.color);
    audio.explode();
  }
}

// Enemy touched the player. Three regimes:
//  - shield token active (invuln > 0.55): the player is a wrecking ball — full
//    kill with score/split, no damage taken
//  - post-hit i-frames (0 < invuln <= 0.55): pass through, enemy SURVIVES, so
//    ramming a whole wave can't be paid for with a single hit's damage
//  - vulnerable: take damage, enemy dies without reward
export function enemyContact(game, e) {
  const p = game.player;
  if (e.isBoss) {
    if (p.invuln <= 0) { damagePlayer(game, e.damage); fx.shake(6, 0.2); }
    return;
  }
  if (p.invuln > 0.55) { killEnemy(game, e, 'contact'); return; }
  if (p.invuln > 0) return;
  damagePlayer(game, e.damage);
  e.dead = true;
  fx.explosion(e.x, e.z, e.radius, e.color);
}

// ---- drawing ----------------------------------------------------------------
// STEAMPUNK pass (v1.1). Draw-only: no stat/radius/behavior value is read here
// that was not read before. Rules obeyed by everything below:
//   * every type keeps its own e.color family — brass/iron/copper are accents
//   * ALL rotation comes from e.age (never Date.now), so it is pause- and
//     replay-safe and scales with the entity's own lifetime
//   * gear outlines are unit-radius Path2D objects, built once per tooth count
//     and reused via scale()/rotate() — nothing allocates in the draw loop
//   * hit flash, HP/shield bars, elite aura and every telegraph read are intact
//   * shadowBlur stays where it already was (boss core only)
//
// Palette: accents only. Environment iron (#1a1512) is too dark to read as a
// silhouette against the road, so enemy ironwork uses the dusk-lit tint of it.
const IRON = '#4b3a2c';
const COAL = '#0f0c09';             // cavities, sockets, gun ports
const BRASS = '#c9973b';
const BRASS_HI = '#f0b429';
const COPPER = '#b0652f';
const COPPER_A = 'rgba(176,101,47,0.9)';
const STEAM = 'rgb(230,225,215)';   // alpha applied through globalAlpha
const MOLTEN = '#ff8a2a';           // heat bleeding out of cracks / furnaces
const RIME = '#9fe8ff';             // cryo rim (matches effects.js frostPuff)
const EMBER = '#ffd166';            // small warm lamps (matches the tank slit)
const GEAR_ROOT = 0.74;             // unit-gear body radius under the teeth
const GEAR_PATHS = new Map();

// Unit-radius gear outline, cached per tooth count. Built lazily so this module
// still imports outside a browser (Path2D is a canvas API) and so there is no
// top-level side effect.
function gearPath(teeth) {
  let p = GEAR_PATHS.get(teeth);
  if (p !== undefined) return p;
  p = null;
  if (typeof Path2D !== 'undefined') {
    p = new Path2D();
    const step = TAU / teeth;
    for (let i = 0; i < teeth; i++) {
      const a = i * step;
      const a0 = a - step * 0.30, a1 = a - step * 0.16;
      const a2 = a + step * 0.16, a3 = a + step * 0.30;
      const x0 = Math.cos(a0) * GEAR_ROOT, y0 = Math.sin(a0) * GEAR_ROOT;
      if (i === 0) p.moveTo(x0, y0); else p.lineTo(x0, y0);
      p.lineTo(Math.cos(a1), Math.sin(a1));
      p.lineTo(Math.cos(a2), Math.sin(a2));
      p.lineTo(Math.cos(a3) * GEAR_ROOT, Math.sin(a3) * GEAR_ROOT);
    }
    p.closePath();
  }
  GEAR_PATHS.set(teeth, p);
  return p;
}

// Toothed disc of radius r spun by `rot` radians about the current origin.
function drawGear(ctx, r, rot, teeth, fill) {
  const p = gearPath(teeth);
  ctx.save();
  ctx.rotate(rot);
  ctx.scale(r, r);
  ctx.fillStyle = fill;
  if (p) ctx.fill(p);
  ctx.beginPath();                  // solid body beneath the teeth
  ctx.arc(0, 0, GEAR_ROOT, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function disc(ctx, x, y, rad, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, TAU);
  ctx.fill();
}

// Bolt heads along an arc (pass from/to spanning TAU*(n-1)/n for a full ring).
function rivetArc(ctx, cx, cy, rad, from, to, n, dotR, color) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const a = n > 1 ? from + (to - from) * (i / (n - 1)) : from;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, dotR, 0, TAU);
    ctx.fill();
  }
}

function rivetRow(ctx, x0, y0, x1, y1, n, dotR, color) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0.5;
    ctx.beginPath();
    ctx.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, dotR, 0, TAU);
    ctx.fill();
  }
}

// Rising steam. Phase comes from the entity's own age (never a wall clock), so
// puffs are deterministic and cost one fillStyle + n arcs.
function steamPuff(ctx, x, y, size, age, n, rise, seed, maxAlpha) {
  ctx.fillStyle = STEAM;
  for (let i = 0; i < n; i++) {
    let t = (age * 0.5 + seed + i / n) % 1;
    if (t < 0) t += 1;
    ctx.globalAlpha = maxAlpha * (1 - t) * (t < 0.15 ? t / 0.15 : 1);
    ctx.beginPath();
    ctx.arc(x + Math.sin((t + seed) * 5.4) * size * 0.7, y - t * rise,
      size * (0.4 + t * 1.1), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Warm lamp glow built from stacked alpha discs — keeps shadowBlur off the
// per-enemy path (only the boss core is allowed to blur).
function furnaceEye(ctx, x, y, rad, color, alpha) {
  ctx.globalAlpha = alpha * 0.28;
  disc(ctx, x, y, rad * 1.9, color);
  ctx.globalAlpha = alpha * 0.55;
  disc(ctx, x, y, rad * 1.35, color);
  ctx.globalAlpha = alpha;
  disc(ctx, x, y, rad, color);
  ctx.globalAlpha = 1;
}

// Screen-space swing for a barrel that tracks the player. Enemy shapes face +y
// (player-ward), so this is a small rotation about the mount point.
function aimAngle(e, p) {
  if (!p) return 0;
  return clamp(Math.atan2(e.x - p.x, Math.max(e.z - p.z, 80)) * 1.4, -0.7, 0.7);
}

// Detail LOD: below this drawn radius a rivet/steam puff is sub-pixel noise, so
// far-away machines draw silhouette only. Keeps the op count near the old art
// for the crowded far half of the road; silhouettes/telegraphs never change.
const FINE = 12;

// Every type gets its own silhouette. Signature (ctx, e, r, k, p): called inside
// a save/restore already translated to the enemy's screen position, r is the
// drawn radius in px, k is px-per-world-unit, p is the player (aim tracking).
// Player-ward is +y for every shape.
const SHAPES = {
  // rolling cog-bot: the body IS a gear, one glowing porthole eye
  grunt(ctx, e, r) {
    const body = e.flash > 0 ? '#ffffff' : e.color;
    const metal = e.flash > 0 ? '#ffffff' : IRON;
    const rot = e.age * 0.9;                                  // slow roll
    ctx.fillStyle = metal;                                    // axle stubs (old shoulders)
    ctx.fillRect(-r * 1.28, -r * 0.15, r * 0.44, r * 0.75);
    ctx.fillRect(r * 0.84, -r * 0.15, r * 0.44, r * 0.75);
    drawGear(ctx, r, rot, 10, body);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';                       // underside shade (kept)
    ctx.beginPath();
    ctx.arc(0, r * 0.24, r * 0.74, 0, Math.PI);
    ctx.fill();
    ctx.strokeStyle = e.flash > 0 ? '#ffffff' : BRASS;        // brass rim
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, 0, TAU);
    ctx.stroke();
    if (r > FINE) {
      rivetArc(ctx, 0, 0, r * 0.6, rot, rot + TAU * (5 / 6), 6, r * 0.07,
        e.flash > 0 ? '#ffffff' : BRASS_HI);
    }
    disc(ctx, 0, r * 0.1, r * 0.3, COAL);                     // porthole socket
    if (r > FINE) furnaceEye(ctx, 0, r * 0.1, r * 0.14, EMBER, 1);   // single glowing eye
    else disc(ctx, 0, r * 0.1, r * 0.16, EMBER);
  },

  // steam dart: riveted needle hull, pumping side pistons, nose propeller
  runner(ctx, e, r) {
    ctx.rotate(Math.cos(e.age * e.def.zigFreq + e.phase) * 0.3);   // motion lean (kept)
    const body = e.flash > 0 ? '#ffffff' : e.color;
    const metal = e.flash > 0 ? '#ffffff' : IRON;
    const travel = Math.sin(e.age * 15 + e.phase) * r * 0.13;      // piston travel
    ctx.fillStyle = metal;
    ctx.fillRect(-r * 0.94, -r * 0.32 + travel, r * 0.26, r * 0.68);
    ctx.fillRect(r * 0.68, -r * 0.32 - travel, r * 0.26, r * 0.68);
    ctx.fillStyle = body;                                          // dart hull (same outline)
    ctx.beginPath();
    ctx.moveTo(0, r * 1.2);
    ctx.lineTo(r * 0.82, -r * 0.35);
    ctx.lineTo(0, -r * 0.05);
    ctx.lineTo(-r * 0.82, -r * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : 'rgba(255,236,190,0.42)';   // brass spine fin
    ctx.beginPath();
    ctx.moveTo(-r * 0.26, -r * 0.2);
    ctx.lineTo(0, -r * 1.15);
    ctx.lineTo(r * 0.26, -r * 0.2);
    ctx.closePath();
    ctx.fill();
    if (r > FINE) {
      rivetRow(ctx, -r * 0.3, r * 0.14, -r * 0.08, r * 0.88, 3, r * 0.065, 'rgba(0,0,0,0.45)');
      rivetRow(ctx, r * 0.3, r * 0.14, r * 0.08, r * 0.88, 3, r * 0.065, 'rgba(0,0,0,0.45)');
    }
    disc(ctx, 0, r * 0.42, r * 0.17, COAL);                        // porthole
    disc(ctx, 0, r * 0.42, r * 0.07, EMBER);
    ctx.save();                                                    // nose propeller
    ctx.translate(0, r * 1.06);
    ctx.rotate(e.age * 17);
    if (r > FINE) {                                                // spin blur
      ctx.globalAlpha = 0.1;
      disc(ctx, 0, 0, r * 0.5, STEAM);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : BRASS_HI;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.5, r * 0.11, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.11, r * 0.5, 0, 0, TAU);
    ctx.fill();
    disc(ctx, 0, 0, r * 0.13, IRON);
    ctx.restore();
  },

  // boiler juggernaut: iron slab, boiler dome, venting stack, furnace slit
  tank(ctx, e, r) {
    const w = r * 1.2, h = r * 0.95;
    const body = e.flash > 0 ? '#ffffff' : e.color;
    const metal = e.flash > 0 ? '#ffffff' : IRON;
    ctx.fillStyle = metal;                                    // smokestack (behind the slab)
    ctx.fillRect(-w * 0.75, -h * 1.85, w * 0.26, h * 0.95);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : BRASS;
    ctx.fillRect(-w * 0.81, -h * 1.94, w * 0.38, h * 0.15);
    if (r > FINE) {                                           // faint steam wisp
      steamPuff(ctx, -w * 0.62, -h * 1.98, r * 0.26, e.age, 3, r * 1.7, e.phase / TAU, 0.15);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.4)';                        // treads (kept)
    ctx.fillRect(-w - r * 0.24, -h * 0.7, r * 0.3, h * 1.5);
    ctx.fillRect(w - r * 0.06, -h * 0.7, r * 0.3, h * 1.5);
    ctx.fillStyle = body;                                     // boiler dome
    ctx.beginPath();
    ctx.arc(r * 0.12, -h * 0.78, w * 0.48, Math.PI, TAU);
    ctx.fill();
    ctx.strokeStyle = e.flash > 0 ? '#ffffff' : COPPER;       // dome hoop
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.beginPath();
    ctx.arc(r * 0.12, -h * 0.78, w * 0.3, Math.PI, TAU);
    ctx.stroke();
    ctx.fillStyle = body;                                     // angular slab (same outline)
    ctx.beginPath();
    ctx.moveTo(-w, -h * 0.6);
    ctx.lineTo(-w * 0.78, h);
    ctx.lineTo(w * 0.78, h);
    ctx.lineTo(w, -h * 0.6);
    ctx.lineTo(w * 0.62, -h);
    ctx.lineTo(-w * 0.62, -h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.2)';                        // bolted plates
    for (let i = -1; i <= 1; i++) {
      ctx.fillRect(i * w * 0.52 - w * 0.19, h * 0.08, w * 0.38, h * 0.6);
    }
    if (r > FINE) {                                           // visible bolts
      const bolt = e.flash > 0 ? '#ffffff' : BRASS_HI;
      for (let i = -1; i <= 1; i++) {
        const cx = i * w * 0.52;
        rivetRow(ctx, cx - w * 0.13, h * 0.17, cx + w * 0.13, h * 0.17, 2, r * 0.065, bolt);
        rivetRow(ctx, cx - w * 0.13, h * 0.59, cx + w * 0.13, h * 0.59, 2, r * 0.065, bolt);
      }
    }
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : BRASS;          // waist strap
    ctx.fillRect(-w * 0.95, -h * 0.06, w * 1.9, h * 0.09);
    ctx.fillStyle = DARK;                                     // visor cavity (kept)
    ctx.fillRect(-w * 0.56, -h * 0.44, w * 1.12, h * 0.32);
    ctx.globalAlpha = 0.32 + 0.16 * Math.sin(e.age * 3 + e.phase);   // furnace breathing
    ctx.fillStyle = MOLTEN;
    ctx.fillRect(-w * 0.52, -h * 0.42, w * 1.04, h * 0.28);
    ctx.globalAlpha = 1;
    if (r > FINE) {                                           // brass slit frame
      ctx.strokeStyle = e.flash > 0 ? '#ffffff' : BRASS;
      ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.strokeRect(-w * 0.56, -h * 0.44, w * 1.12, h * 0.32);
    }
    ctx.fillStyle = '#ffd166';                                // amber furnace slit (kept)
    ctx.fillRect(-w * 0.46, -h * 0.37, w * 0.92, h * 0.13);
  },

  // telescope cannon: wheeled tripod carriage, long brass tube tracking the player
  shooter(ctx, e, r, k, p) {
    const body = e.flash > 0 ? '#ffffff' : e.color;
    const metal = e.flash > 0 ? '#ffffff' : IRON;
    const ang = aimAngle(e, p);
    ctx.strokeStyle = metal;                                  // tripod legs
    ctx.lineWidth = Math.max(1.5, r * 0.14);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-r * 0.86, r * 0.7);
    ctx.moveTo(0, 0); ctx.lineTo(r * 0.86, r * 0.7);
    ctx.moveTo(0, 0); ctx.lineTo(0, -r * 0.95);
    ctx.stroke();
    disc(ctx, -r * 0.86, r * 0.72, r * 0.28, e.flash > 0 ? '#ffffff' : COPPER);   // wheels
    disc(ctx, r * 0.86, r * 0.72, r * 0.28, e.flash > 0 ? '#ffffff' : COPPER);
    disc(ctx, -r * 0.86, r * 0.72, r * 0.12, COAL);
    disc(ctx, r * 0.86, r * 0.72, r * 0.12, COAL);
    ctx.fillStyle = body;                                     // diamond hull (kept)
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.15);
    ctx.lineTo(r * 0.95, 0);
    ctx.lineTo(0, r * 1.15);
    ctx.lineTo(-r * 0.95, 0);
    ctx.closePath();
    ctx.fill();
    if (r > FINE) {
      rivetArc(ctx, 0, 0, r * 0.62, -Math.PI / 2, -Math.PI / 2 + TAU * 0.75, 4, r * 0.07,
        'rgba(0,0,0,0.45)');
    }
    ctx.save();                                               // telescope, aimed at the player
    ctx.rotate(ang);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : BRASS;
    ctx.fillRect(-r * 0.19, r * 0.1, r * 0.38, r * 1.28);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';                       // tube shading
    ctx.fillRect(r * 0.05, r * 0.1, r * 0.14, r * 1.28);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : COPPER;         // sleeve + muzzle ring
    ctx.fillRect(-r * 0.24, r * 0.6, r * 0.48, r * 0.14);
    ctx.fillRect(-r * 0.27, r * 1.24, r * 0.54, r * 0.16);
    ctx.restore();
    disc(ctx, 0, 0, r * 0.3, COAL);                           // trunnion / turret ring
    disc(ctx, 0, 0, r * 0.15, e.flash > 0 ? '#ffffff' : BRASS);
    if (e.charge > 0) {                                       // wind-up flash (unchanged read)
      ctx.save();
      ctx.rotate(ang);
      ctx.globalAlpha = 0.35 + e.charge * 0.65;
      ctx.fillStyle = '#fff2a8';
      ctx.beginPath();
      ctx.arc(0, r * 1.32, r * (0.2 + e.charge * 0.42), 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  },

  // plate carrier: riveted round chassis behind a bolted iron plate
  shield(ctx, e, r) {
    const body = e.flash > 0 ? '#ffffff' : e.color;
    disc(ctx, 0, 0, r * 0.9, body);                           // chassis (kept size)
    ctx.fillStyle = 'rgba(0,0,0,0.18)';                       // lower hull shade
    ctx.beginPath();
    ctx.arc(0, r * 0.2, r * 0.72, 0, Math.PI);
    ctx.fill();
    if (r > FINE) {
      rivetArc(ctx, 0, 0, r * 0.66, 0, TAU * (7 / 8), 8, r * 0.07,
        e.flash > 0 ? '#ffffff' : 'rgba(0,0,0,0.5)');
    }
    ctx.save();                                               // winding cog on the crown
    ctx.translate(0, -r * 0.98);
    drawGear(ctx, r * 0.26, -e.age * 1.1, 8, e.flash > 0 ? '#ffffff' : BRASS);
    disc(ctx, 0, 0, r * 0.08, COAL);
    ctx.restore();
    disc(ctx, -r * 0.28, -r * 0.02, r * 0.14, COAL);          // twin portholes (kept)
    disc(ctx, r * 0.28, -r * 0.02, r * 0.14, COAL);
    if (r > FINE) {
      disc(ctx, -r * 0.28, -r * 0.02, r * 0.06, EMBER);
      disc(ctx, r * 0.28, -r * 0.02, r * 0.06, EMBER);
    }
    const frac = e.shieldMaxHp > 0 ? clamp(e.shieldHp / e.shieldMaxHp, 0, 1) : 0;
    const col = e.def.shieldColor || '#8fd6ff';
    if (frac > 0) {                                           // frontal plate, dims as it weakens
      const lit = e.shieldFlash > 0;
      ctx.globalAlpha = 0.32 + frac * 0.62;
      ctx.strokeStyle = lit ? '#ffffff' : IRON;           // iron plate body
      ctx.lineWidth = Math.max(2, r * 0.3);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();
      ctx.strokeStyle = lit ? '#ffffff' : col;                // shield-blue edges
      ctx.lineWidth = Math.max(1.2, r * 0.12);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.26, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, r * 0.07);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.04, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
      if (r > FINE) {                                         // plate bolts
        rivetArc(ctx, 0, r * 0.08, r * 1.15, Math.PI * 0.26, Math.PI * 0.74, 5, r * 0.09,
          lit ? '#ffffff' : BRASS_HI);
      }
      ctx.globalAlpha = 1;
    } else {                                                  // shattered stubs
      ctx.strokeStyle = 'rgba(75,58,44,0.6)';
      ctx.lineWidth = Math.max(1.8, r * 0.22);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.18, Math.PI * 0.33);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.67, Math.PI * 0.82);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(143,214,255,0.28)';
      ctx.lineWidth = Math.max(1.5, r * 0.18);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.18, Math.PI * 0.33);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.67, Math.PI * 0.82);
      ctx.stroke();
      rivetArc(ctx, 0, r * 0.08, r * 1.15, Math.PI * 0.22, Math.PI * 0.78, 2, r * 0.07,
        'rgba(143,214,255,0.3)');                             // two bolts left in the mount
    }
  },

  // pressure boiler: copper drum straining at the seams, rivets popping out
  splitter(ctx, e, r) {
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;        // straining shell (wobble kept)
    ctx.beginPath();
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * TAU;
      const rr = r * (0.86 + 0.18 * Math.sin(a * 3 + e.age * 4 + e.phase));
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : COPPER;         // hoop straps
    ctx.fillRect(-r * 0.86, -r * 0.44, r * 1.72, r * 0.11);
    ctx.fillRect(-r * 0.86, r * 0.33, r * 1.72, r * 0.11);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';                        // the minis inside (kept)
    for (let i = 0; i < 3; i++) {
      const a = e.age * 1.6 + (i / 3) * TAU;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36, r * 0.22, 0, TAU);
      ctx.fill();
    }
    if (r > FINE) {
      for (let i = 0; i < 6; i++) {                           // rivets working loose
        const a = (i / 6) * TAU + e.phase;
        const pop = Math.max(0, Math.sin(e.age * 3.4 + i * 1.7));
        const ca = Math.cos(a), sa = Math.sin(a);
        disc(ctx, ca * r * 0.8, sa * r * 0.8, r * 0.08, 'rgba(0,0,0,0.45)');
        disc(ctx, ca * r * (0.8 + pop * 0.24), sa * r * (0.8 + pop * 0.24), r * 0.07,
          e.flash > 0 ? '#ffffff' : BRASS_HI);
      }
      ctx.save();                                             // pressure gauge, needle in the red
      ctx.translate(r * 0.3, r * 0.34);
      disc(ctx, 0, 0, r * 0.21, e.flash > 0 ? '#ffffff' : BRASS);
      disc(ctx, 0, 0, r * 0.16, COAL);
      const needle = -Math.PI * 0.75
        + (0.55 + 0.45 * Math.sin(e.age * 4 + e.phase)) * Math.PI * 1.5;
      ctx.strokeStyle = MOLTEN;
      ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(needle) * r * 0.13, Math.sin(needle) * r * 0.13);
      ctx.stroke();
      ctx.restore();
    }
  },

  // runaway cog: a tiny gear spinning itself to pieces, one eye
  mini(ctx, e, r) {
    const rr = r * (0.95 + Math.sin(e.age * 9 + e.phase) * 0.1);   // jitter pulse (kept)
    drawGear(ctx, rr, e.age * 6 + e.phase, 8, e.flash > 0 ? '#ffffff' : e.color);
    disc(ctx, 0, rr * 0.14, rr * 0.26, COAL);
    disc(ctx, 0, rr * 0.14, rr * 0.11, EMBER);
  },

  // piston ram: steam ram with a big frontal piston head that loads on wind-up
  charger(ctx, e, r) {
    const tele = e.state === 1 ? clamp(e.stateT / e.def.telegraph, 0, 1) : 0;
    const blink = tele > 0 && Math.sin(e.stateT * 22) > 0;
    ctx.scale(1 + tele * 0.22, 1 + tele * 0.22);
    if (tele > 0) {                                           // wind-up halo
      ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(e.stateT * 22));
      ctx.strokeStyle = '#fff2a8';
      ctx.lineWidth = Math.max(2, r * 0.2);
      ctx.beginPath();
      ctx.arc(0, 0, r * (1.15 + tele * 0.35), 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const hot = e.flash > 0 || blink;
    const body = hot ? '#fff2a8' : e.color;
    const metal = hot ? '#fff2a8' : IRON;
    if (tele > 0) {                                           // steam hiss while it loads
      steamPuff(ctx, -r * 0.82, -r * 0.15, r * 0.28, e.age, 3, r * 1.1, 0.1, 0.26 * tele);
      steamPuff(ctx, r * 0.82, -r * 0.15, r * 0.28, e.age, 3, r * 1.1, 0.6, 0.26 * tele);
    }
    ctx.fillStyle = body;
    ctx.beginPath();                                          // ram chassis (same arrowhead)
    ctx.moveTo(0, r * 0.98);
    ctx.lineTo(r * 0.9, -r * 0.1);
    ctx.lineTo(r * 0.45, -r * 0.95);
    ctx.lineTo(-r * 0.45, -r * 0.95);
    ctx.lineTo(-r * 0.9, -r * 0.1);
    ctx.closePath();
    ctx.fill();
    const head = r * (1.3 - 0.34 * tele);                     // piston compresses on wind-up
    ctx.fillStyle = metal;                                    // rod
    ctx.fillRect(-r * 0.15, r * 0.45, r * 0.3, Math.max(0, head - r * 0.5));
    if (r > FINE) {                                            // compression rings
      rivetRow(ctx, 0, r * 0.55, 0, head - r * 0.55, 3, r * 0.09, hot ? '#fff2a8' : BRASS);
    }
    ctx.fillStyle = hot ? '#fff2a8' : BRASS;                  // frontal piston head
    ctx.beginPath();
    ctx.moveTo(-r * 0.78, head - r * 0.42);
    ctx.lineTo(0, head);
    ctx.lineTo(r * 0.78, head - r * 0.42);
    ctx.lineTo(r * 0.6, head - r * 0.7);
    ctx.lineTo(-r * 0.6, head - r * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = hot ? '#fff2a8' : COPPER;                 // strike face
    ctx.beginPath();
    ctx.moveTo(-r * 0.62, head - r * 0.24);
    ctx.lineTo(0, head - r * 0.02);
    ctx.lineTo(r * 0.62, head - r * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = hot ? '#fff2a8' : BRASS;                  // shoulder strap + bolts
    ctx.fillRect(-r * 0.62, r * 0.22, r * 1.24, r * 0.2);
    if (r > FINE) {
      rivetRow(ctx, -r * 0.5, r * 0.32, r * 0.5, r * 0.32, 4, r * 0.06, 'rgba(0,0,0,0.45)');
    }
    disc(ctx, 0, -r * 0.3, r * 0.2, COAL);                    // porthole
    if (r > FINE) furnaceEye(ctx, 0, -r * 0.3, r * 0.09, hot ? '#ffffff' : MOLTEN, 0.9);
    else disc(ctx, 0, -r * 0.3, r * 0.1, hot ? '#ffffff' : MOLTEN);
  },

  // IRONCLAD: a clockwork war engine — layered gears, riveted armour, twin
  // stacks, and a furnace visor tinted by the phase.
  boss(ctx, e, r) {
    const ph = e.bossPhase;
    const col = e.flash > 0 ? '#ffffff' : e.color;
    const tele = e.state === 1 ? clamp(e.stateT / SLAM_TELEGRAPH, 0, 1) : 0;
    const lit = ph === 3 ? '#ff5a5a' : ph === 2 ? '#ffb02e' : '#ffe08a';   // phase tints (kept)
    ctx.scale(1 + Math.sin(e.age * (2 + ph)) * 0.03 + tele * 0.12,
      1 + Math.sin(e.age * (2 + ph)) * 0.03 + tele * 0.1);
    for (let s = -1; s <= 1; s += 2) {                         // twin smokestacks (were horns)
      ctx.save();
      ctx.translate(s * r * 0.88, -r * 0.66);
      ctx.rotate(s * 0.3);
      ctx.fillStyle = e.flash > 0 ? '#ffffff' : IRON;
      ctx.fillRect(-r * 0.2, -r * 0.95, r * 0.4, r * 1.12);
      ctx.fillStyle = e.flash > 0 ? '#ffffff' : BRASS;
      ctx.fillRect(-r * 0.26, -r * 1.04, r * 0.52, r * 0.16);
      rivetRow(ctx, 0, -r * 0.72, 0, -r * 0.16, 3, r * 0.055, BRASS_HI);
      steamPuff(ctx, 0, -r * 1.06, r * 0.26, e.age, 3, r * 1.5, s > 0 ? 0.55 : 0.05,
        0.14 + 0.06 * (ph - 1));
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';                       // shoulder pods
    ctx.fillRect(-r * 1.35, -r * 0.55, r * 0.55, r * 1.2);
    ctx.fillRect(r * 0.8, -r * 0.55, r * 0.55, r * 1.2);
    drawGear(ctx, r * 1.32, e.age * 0.32, 22,                 // slow drive gear behind the hull
      e.flash > 0 ? '#ffffff' : IRON);
    drawGear(ctx, r * 1.1, -e.age * 0.55, 16,                 // counter-rotating copper layer
      e.flash > 0 ? '#ffffff' : COPPER_A);
    ctx.shadowColor = col;                                    // phase glow
    ctx.shadowBlur = (ph === 3 ? 26 : ph === 2 ? 16 : 10) * (e.phaseFlash > 0 || tele > 0 ? 1.7 : 1);
    ctx.fillStyle = col;
    ctx.beginPath();                                          // hex core
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * TAU;
      const px = Math.cos(a) * r * 1.05, py = Math.sin(a) * r * 0.95;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';                 // riveted chest plate
    ctx.fillRect(-r * 0.75, r * 0.25, r * 1.5, r * 0.4);
    rivetRow(ctx, -r * 0.66, r * 0.33, r * 0.66, r * 0.33, 6, r * 0.05, BRASS_HI);
    rivetRow(ctx, -r * 0.66, r * 0.57, r * 0.66, r * 0.57, 6, r * 0.05, BRASS_HI);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';                       // brow plate
    ctx.fillRect(-r * 0.78, -r * 0.62, r * 1.56, r * 0.2);
    rivetRow(ctx, -r * 0.66, -r * 0.52, r * 0.66, -r * 0.52, 5, r * 0.05, BRASS_HI);
    ctx.save();                                               // fast brass gear on the chest
    ctx.translate(0, r * 0.45);
    drawGear(ctx, r * 0.27, e.age * 0.95, 12, e.flash > 0 ? '#ffffff' : BRASS);
    disc(ctx, 0, 0, r * 0.08, COAL);
    ctx.restore();
    ctx.fillStyle = DARK;                                     // visor cavity
    ctx.fillRect(-r * 0.72, -r * 0.36, r * 1.44, r * 0.44);
    ctx.strokeStyle = e.flash > 0 ? '#ffffff' : BRASS;        // brass visor frame
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.strokeRect(-r * 0.72, -r * 0.36, r * 1.44, r * 0.44);
    ctx.fillStyle = lit;                                      // outer visor slots (kept read)
    ctx.fillRect(-r * 0.56, -r * 0.29, r * 0.28, r * 0.17);
    ctx.fillRect(r * 0.28, -r * 0.29, r * 0.28, r * 0.17);
    furnaceEye(ctx, 0, -r * 0.14, r * 0.19, lit, 1);          // central furnace eye
    if (ph >= 2) {                                            // battle damage, molten inside
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = Math.max(1.5, r * 0.07);
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, r * 0.9);
      ctx.lineTo(-r * 0.2, r * 0.2);
      ctx.lineTo(-r * 0.42, -r * 0.1);
      if (ph === 3) { ctx.moveTo(r * 0.55, r * 0.85); ctx.lineTo(r * 0.3, r * 0.1); }
      ctx.stroke();
      ctx.globalAlpha = 0.45 + 0.35 * Math.abs(Math.sin(e.age * 2.4));
      ctx.strokeStyle = MOLTEN;
      ctx.lineWidth = Math.max(0.8, r * 0.032);
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, r * 0.9);
      ctx.lineTo(-r * 0.2, r * 0.2);
      ctx.lineTo(-r * 0.42, -r * 0.1);
      if (ph === 3) { ctx.moveTo(r * 0.55, r * 0.85); ctx.lineTo(r * 0.3, r * 0.1); }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (e.charge > 0) {                                       // volley wind-up
      ctx.globalAlpha = 0.3 + e.charge * 0.6;
      ctx.fillStyle = '#fff2a8';
      ctx.beginPath();
      ctx.arc(0, r * 0.95, r * (0.18 + e.charge * 0.3), 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  },
};

// Ground-level intent line: charger tracks the player until it locks, boss shows
// the lane it is about to slam into.
function drawTelegraph(ctx, view, ax, az, bx, bz, color, width, alpha) {
  const a = project(view, ax, az);
  const b = project(view, bx, bz);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, width * a.f * view.unitScale);
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.stroke();
  ctx.restore();
}

export function drawEnemies(ctx, view, game) {
  const sorted = [...game.enemies].sort((a, b) => b.z - a.z);
  const p = game.player;
  for (const e of sorted) {
    if (e.dead) continue;
    const { sx, sy, f } = project(view, e.x, e.z);
    const k = f * view.unitScale;              // px per world unit at this depth
    const r = e.radius * k * 1.15;             // drawn slightly larger than the hitbox

    // Telegraphs live in screen space (they span two world points)
    if (e.behavior === 'charger' && e.state === 1) {
      drawTelegraph(ctx, view, e.x, e.z, p.x, p.z, '#ffd166', 3,
        0.25 + 0.4 * Math.abs(Math.sin(e.stateT * 22)));
    } else if (e.isBoss && e.state === 1) {
      drawTelegraph(ctx, view, e.x, e.z, e.lockX, e.z, e.color, 9,
        0.3 + 0.4 * Math.abs(Math.sin(e.stateT * 16)));
      drawTelegraph(ctx, view, e.lockX, e.z, e.lockX, p.z, e.color, 4, 0.22);
    }

    ctx.save();
    ctx.translate(sx, sy);

    if (e.elite) {                             // gold aura
      const pulse = 0.3 + Math.sin(e.age * 4 + e.phase) * 0.12;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = ELITE.color;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.5, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = Math.min(1, pulse + 0.45);
      ctx.strokeStyle = ELITE.color;
      ctx.lineWidth = Math.max(2, r * 0.11);
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.32, 0, TAU);
      ctx.stroke();
      if (r > FINE) {                          // brass cog halo riding the aura ring
        ctx.globalAlpha = 0.85;
        for (let i = 0; i < 3; i++) {
          const a = e.age * 0.7 + (i / 3) * TAU + e.phase;
          ctx.save();
          ctx.translate(Math.cos(a) * r * 1.32, Math.sin(a) * r * 1.32);
          drawGear(ctx, r * 0.19, -e.age * 1.6, 8, ELITE.color);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.save();
    (SHAPES[e.type] || SHAPES.grunt)(ctx, e, r, k, p);
    ctx.restore();

    // Status read (design §C S2): ONE generic block for every type — burning
    // machines glow warm (additive), chilled ones wear a rime rim. No SHAPES
    // edits, so a new enemy type inherits both for free.
    if (e.burnT > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22 + 0.08 * Math.sin(e.age * 17 + e.phase);
      ctx.fillStyle = MOLTEN;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    if (e.chillT > 0) {
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = RIME;
      ctx.lineWidth = Math.max(1.2, r * 0.1);
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.12, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // HP bar on tough types only (boss has the DOM bar), shield bar above it
    const bh = Math.max(3, 3.2 * k);
    if (!e.isBoss && (e.def.hp > 30 || e.elite) && e.hp < e.maxHp) {
      const bw = r * 1.7, by = -r - bh * 2.2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(-bw / 2, by, bw, bh);
      ctx.fillStyle = e.elite ? ELITE.color : '#ff5964';
      ctx.fillRect(-bw / 2, by, bw * clamp(e.hp / e.maxHp, 0, 1), bh);
    }
    if (e.shieldMaxHp > 0 && e.shieldHp > 0) {
      const bw = r * 1.7, by = -r - bh * 3.6;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(-bw / 2, by, bw, bh * 0.8);
      ctx.fillStyle = e.def.shieldColor || '#8fd6ff';
      ctx.fillRect(-bw / 2, by, bw * clamp(e.shieldHp / e.shieldMaxHp, 0, 1), bh * 0.8);
    }

    ctx.restore();
  }
}
