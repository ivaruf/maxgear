// Data-driven enemy system. ENEMY-AGENT OWNS THIS FILE.
// Roster: grunt runner tank shooter shield splitter mini charger boss (+ `elite` modifier).
// Death must always route through killEnemy() (score, fx, drops, splitting).
// Behaviors are named functions in `behaviors`; visuals are per-type in `SHAPES`.

import { ROAD_HALF, DESPAWN_BEHIND } from './config.js';
import { clamp, lerp, rand, randInt, chance } from './utils.js';
import { project } from './render.js';
import { fireEnemyShot } from './projectiles.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { damagePlayer } from './player.js';
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
    // hp is multiplied by game.level.hpScale at spawn like every other type;
    // level.js caps that at 6x and it sits near ~5x at BOSS_AT, so the effective
    // pool is ~16k. Balance either number — or pass { hpScale: 1 } from main.js.
    hp: 3200, speed: 120, damage: 40, radius: 55, score: 1500,
    color: '#b23bc9', behavior: 'boss', dropChance: 0, isBoss: true, name: 'WARLORD',
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
    holdAhead(e, dt, game, e.holdDist, Math.max(game.runSpeed * 0.9, 60));
    strafe(e, dt, e.def.strafeSpeed, 10);

    e.fireTimer -= dt;
    e.charge = e.fireTimer < WINDUP ? 1 - Math.max(e.fireTimer, 0) / WINDUP : 0;
    if (e.fireTimer <= 0) {
      e.fireTimer = rand(e.def.fireEvery[0], e.def.fireEvery[1]);
      e.charge = 0;
      if (e.z > p.z + 120) {
        shotFrom(game, e, p.x, p.z);
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

// ---- update -----------------------------------------------------------------
export function updateEnemies(game, dt) {
  const list = game.enemies;
  const n = list.length;   // enemies summoned/split this frame start next frame
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (e.dead) continue;
    e.age += dt;
    e.flash = Math.max(0, e.flash - dt);
    e.shieldFlash = Math.max(0, e.shieldFlash - dt);
    (behaviors[e.behavior] || behaviors.rush)(e, dt, game);
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

// Central death hook — collisions.js calls this. cause: 'shot'|'explosion'|'contact'
export function killEnemy(game, e, cause = 'shot') {
  if (e.dead) return;
  e.dead = true;
  game.score += e.score;
  game.kills++;
  fx.explosion(e.x, e.z, e.radius * 1.4, e.color);
  fx.textPop(e.x, e.z, `+${e.score}`, e.elite ? ELITE.color : '#ffd166');
  audio.enemyDie();

  // splitter -> minis, spawned at the death site with slight x offsets
  if (e.def.splitInto) {
    const n = randInt(e.def.splitCount[0], e.def.splitCount[1]);
    for (let i = 0; i < n; i++) {
      const ox = (i - (n - 1) / 2) * 26 + rand(-6, 6);
      spawnEnemy(game, e.def.splitInto, e.x + ox, e.z + rand(-12, 12));
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

// Enemy touched the player: hurt the player, enemy dies (no reward, no split)
export function enemyContact(game, e) {
  damagePlayer(game, e.damage);
  if (e.isBoss) { fx.shake(6, 0.2); return; }
  e.dead = true;
  fx.explosion(e.x, e.z, e.radius, e.color);
}

// ---- drawing ----------------------------------------------------------------
// Every type gets its own silhouette. Called inside a save/restore already
// translated to the enemy's screen position; r is the drawn radius in px.
const SHAPES = {
  grunt(ctx, e, r) {
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.fillRect(-r * 1.05, -r * 0.15, r * 0.34, r * 0.75);   // hunched shoulders
    ctx.fillRect(r * 0.71, -r * 0.15, r * 0.34, r * 0.75);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.arc(0, r * 0.22, r * 0.85, 0, Math.PI);
    ctx.fill();
    ctx.fillStyle = DARK;
    ctx.beginPath();
    ctx.arc(-r * 0.32, r * 0.12, r * 0.17, 0, TAU);
    ctx.arc(r * 0.32, r * 0.12, r * 0.17, 0, TAU);
    ctx.fill();
  },

  runner(ctx, e, r) {
    ctx.rotate(Math.cos(e.age * e.def.zigFreq + e.phase) * 0.3);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
    ctx.beginPath();
    ctx.moveTo(0, r * 1.2);
    ctx.lineTo(r * 0.82, -r * 0.35);
    ctx.lineTo(0, -r * 0.05);
    ctx.lineTo(-r * 0.82, -r * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.beginPath();
    ctx.moveTo(-r * 0.26, -r * 0.2);
    ctx.lineTo(0, -r * 1.15);
    ctx.lineTo(r * 0.26, -r * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = DARK;
    ctx.beginPath();
    ctx.arc(0, r * 0.42, r * 0.17, 0, TAU);
    ctx.fill();
  },

  tank(ctx, e, r) {
    const w = r * 1.2, h = r * 0.95;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';                        // treads
    ctx.fillRect(-w - r * 0.24, -h * 0.7, r * 0.3, h * 1.5);
    ctx.fillRect(w - r * 0.06, -h * 0.7, r * 0.3, h * 1.5);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;        // angular slab
    ctx.beginPath();
    ctx.moveTo(-w, -h * 0.6);
    ctx.lineTo(-w * 0.78, h);
    ctx.lineTo(w * 0.78, h);
    ctx.lineTo(w, -h * 0.6);
    ctx.lineTo(w * 0.62, -h);
    ctx.lineTo(-w * 0.62, -h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';                  // bolted plates
    for (let i = -1; i <= 1; i++) ctx.fillRect(i * w * 0.52 - w * 0.19, h * 0.08, w * 0.38, h * 0.6);
    ctx.fillStyle = DARK;                                     // visor slit
    ctx.fillRect(-w * 0.56, -h * 0.44, w * 1.12, h * 0.32);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(-w * 0.46, -h * 0.37, w * 0.92, h * 0.13);
  },

  shooter(ctx, e, r) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';                        // barrel, player-ward
    ctx.fillRect(-r * 0.17, r * 0.2, r * 0.34, r * 1.15);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;        // diamond hull
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.15);
    ctx.lineTo(r * 0.95, 0);
    ctx.lineTo(0, r * 1.15);
    ctx.lineTo(-r * 0.95, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = DARK;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.3, 0, TAU);
    ctx.fill();
    if (e.charge > 0) {                                       // wind-up flash
      ctx.globalAlpha = 0.35 + e.charge * 0.65;
      ctx.fillStyle = '#fff2a8';
      ctx.beginPath();
      ctx.arc(0, r * 1.32, r * (0.2 + e.charge * 0.42), 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  },

  shield(ctx, e, r) {
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.9, 0, TAU);
    ctx.fill();
    ctx.fillStyle = DARK;
    ctx.beginPath();
    ctx.arc(-r * 0.28, -r * 0.02, r * 0.14, 0, TAU);
    ctx.arc(r * 0.28, -r * 0.02, r * 0.14, 0, TAU);
    ctx.fill();
    const frac = e.shieldMaxHp > 0 ? clamp(e.shieldHp / e.shieldMaxHp, 0, 1) : 0;
    const col = e.def.shieldColor || '#8fd6ff';
    if (frac > 0) {                                           // frontal plate, dims as it weakens
      ctx.strokeStyle = e.shieldFlash > 0 ? '#ffffff' : col;
      ctx.globalAlpha = 0.32 + frac * 0.62;
      ctx.lineWidth = Math.max(2, r * 0.3);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {                                                  // shattered stubs
      ctx.strokeStyle = 'rgba(143,214,255,0.28)';
      ctx.lineWidth = Math.max(1.5, r * 0.18);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.18, Math.PI * 0.33);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 1.15, Math.PI * 0.67, Math.PI * 0.82);
      ctx.stroke();
    }
  },

  splitter(ctx, e, r) {
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;        // wobbly blob
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
    ctx.fillStyle = 'rgba(0,0,0,0.3)';                        // the minis inside
    for (let i = 0; i < 3; i++) {
      const a = e.age * 1.6 + (i / 3) * TAU;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36, r * 0.22, 0, TAU);
      ctx.fill();
    }
  },

  mini(ctx, e, r) {
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
    ctx.beginPath();
    ctx.arc(0, 0, r * (0.95 + Math.sin(e.age * 9 + e.phase) * 0.1), 0, TAU);
    ctx.fill();
    ctx.fillStyle = DARK;
    ctx.beginPath();
    ctx.arc(0, r * 0.14, r * 0.26, 0, TAU);
    ctx.fill();
  },

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
    ctx.fillStyle = e.flash > 0 || blink ? '#fff2a8' : e.color;
    ctx.beginPath();                                          // ram / arrowhead
    ctx.moveTo(0, r * 1.3);
    ctx.lineTo(r * 0.9, -r * 0.1);
    ctx.lineTo(r * 0.45, -r * 0.95);
    ctx.lineTo(-r * 0.45, -r * 0.95);
    ctx.lineTo(-r * 0.9, -r * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(-r * 0.62, r * 0.22, r * 1.24, r * 0.26);
    ctx.fillStyle = DARK;
    ctx.beginPath();
    ctx.arc(0, -r * 0.3, r * 0.2, 0, TAU);
    ctx.fill();
  },

  boss(ctx, e, r) {
    const ph = e.bossPhase;
    const col = e.flash > 0 ? '#ffffff' : e.color;
    const tele = e.state === 1 ? clamp(e.stateT / SLAM_TELEGRAPH, 0, 1) : 0;
    ctx.scale(1 + Math.sin(e.age * (2 + ph)) * 0.03 + tele * 0.12,
      1 + Math.sin(e.age * (2 + ph)) * 0.03 + tele * 0.1);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';                       // shoulder pods
    ctx.fillRect(-r * 1.35, -r * 0.55, r * 0.55, r * 1.2);
    ctx.fillRect(r * 0.8, -r * 0.55, r * 0.55, r * 1.2);
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
    ctx.beginPath();                                          // horns
    ctx.moveTo(-r * 0.9, -r * 0.6);
    ctx.lineTo(-r * 1.28, -r * 1.5);
    ctx.lineTo(-r * 0.42, -r * 0.85);
    ctx.closePath();
    ctx.moveTo(r * 0.9, -r * 0.6);
    ctx.lineTo(r * 1.28, -r * 1.5);
    ctx.lineTo(r * 0.42, -r * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';                 // chest plate
    ctx.fillRect(-r * 0.75, r * 0.25, r * 1.5, r * 0.4);
    ctx.fillStyle = DARK;                                     // visor
    ctx.fillRect(-r * 0.72, -r * 0.36, r * 1.44, r * 0.44);
    ctx.fillStyle = ph === 3 ? '#ff5a5a' : ph === 2 ? '#ffb02e' : '#ffe08a';
    for (let i = -1; i <= 1; i++) ctx.fillRect(i * r * 0.42 - r * 0.14, -r * 0.29, r * 0.28, r * 0.17);
    if (ph >= 2) {                                            // battle damage
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = Math.max(1.5, r * 0.07);
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, r * 0.9);
      ctx.lineTo(-r * 0.2, r * 0.2);
      ctx.lineTo(-r * 0.42, -r * 0.1);
      if (ph === 3) { ctx.moveTo(r * 0.55, r * 0.85); ctx.lineTo(r * 0.3, r * 0.1); }
      ctx.stroke();
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
      ctx.globalAlpha = 1;
    }

    ctx.save();
    (SHAPES[e.type] || SHAPES.grunt)(ctx, e, r, k);
    ctx.restore();

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
