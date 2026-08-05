// Global tuning constants. LEAD-OWNED — sub-agents request changes via notes.

// World / camera (see DESIGN.md "Coordinate system")
export const ROAD_HALF = 200;        // road spans x in [-200, 200]
export const VIEW_DEPTH = 1500;      // world units visible ahead of camera
export const FOCAL = 480;            // perspective focal length
export const CAM_BACK = 140;         // camera sits this far behind the player
export const SPAWN_AHEAD = 1350;     // spawn segments/entities this far ahead
export const DESPAWN_BEHIND = 90;    // remove entities this far behind the player

export const BASE_RUN_SPEED = 250;   // forward units/sec

export const PLAYER_DEFAULTS = {
  maxHp: 100,
  radius: 16,
  invulnTime: 0.5,                   // s of immunity after taking contact damage
};

// v1.2: stats are DERIVED — upgrades.js recomputes this whole object from
// player.tracks (level map) on every level change. Exactly one track owns
// each field. BASE_STATS is the true LV0 baseline / reset target.
export const BASE_STATS = {
  damage: 10,
  fireInterval: 0.32,                // s between volleys
  projectiles: 1,
  spreadDeg: 7,                      // derived in finalize(): tightens as projectiles grow
  critChance: 0,
  critMul: 2,
  squad: 0,                          // extra allied shooters (mortal escorts)
  allyHp: 60,
  moveSpeed: 360,
  magnet: 90,                        // flat now (magnet is no longer an upgrade track)
  // lance (was pierce)
  lance: 0,
  pierceShield: 0,
  // blast (was explosive)
  blastR: 0,
  blastFrac: 0,
  // arc / chain lightning
  chainJumps: 0,
  chainFrac: 0,
  chainRange: 0,
  // status effects
  burnDps: 0,
  burnTime: 0,
  burnSpread: 0,
  frostSlow: 0,
  frostTime: 0,
  frostHard: 0,
  // homing
  homing: 0,
  homeRange: 0,
  // orbiting saws
  sawCount: 0,
  sawDmg: 0,
  sawR: 0,
  sawSpin: 0,
  // broadside aux guns
  auxLv: 0,
  auxFrac: 0,
  // death burst
  shrapnelN: 0,
  shrapnelFrac: 0,
  // defence
  siphon: 0,
  siphonCap: 0,
  aegisMax: 0,
  aegisCd: 0,
  aegisShock: 0,
  armor: 0,
};

// Crash-guard caps (LV5 is the DESIGN cap; these only stop runaway states)
export const CAPS = {
  squad: 8,
  projectiles: 6,
  fireIntervalMin: 0.07,
  critChance: 0.6,
  moveSpeed: 560,
  damage: 400,
  lance: 6,
  chainJumps: 6,
  sawCount: 6,
  auxLv: 5,
  blastR: 220,
  burnDps: 90,
  frostSlow: 0.65,
  siphon: 8,
  aegisMax: 2,
  armor: 0.25,
};

export const PROJECTILE = {
  speed: 950,
  radius: 7,
  life: 2.2,                         // s before auto-despawn
};

export const LIMITS = {
  projectiles: 400,                  // max live player projectiles (maxed squad+fireRate+multishot needs headroom)
  enemyShots: 120,
  particles: 450,
};
