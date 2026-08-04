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

export const BASE_STATS = {
  damage: 10,
  fireInterval: 0.32,                // s between volleys
  projectiles: 1,
  spreadDeg: 7,                      // angular gap between projectiles in a volley
  pierce: 0,
  critChance: 0,
  explosive: 0,                      // 0 = off, >0 = blast radius multiplier level
  ricochet: 0,                       // number of bounces
  squad: 0,                          // extra allied shooters
  moveSpeed: 360,
  magnet: 0,                         // pickup attraction radius bonus
};

// Hard caps so stacked upgrades never destabilize the game
export const CAPS = {
  squad: 8,
  projectiles: 6,
  fireIntervalMin: 0.07,
  pierce: 4,
  ricochet: 3,
  critChance: 0.6,
  moveSpeed: 560,
  damage: 400,
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
