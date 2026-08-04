// Level director: distance-keyed segment timeline. LEVEL-AGENT OWNS THIS FILE.
// Slice version: short test run. Final version: full 3-4 minute paced run.

import { ROAD_HALF, SPAWN_AHEAD } from './config.js';
import { rand } from './utils.js';
import { spawnEnemy } from './enemies.js';
import { spawnGateRow } from './gates.js';
import { spawnObstacle } from './obstacles.js';
import { spawnPickup } from './pickups.js';

// ---- wave spawn patterns (x positions across the road) ----------------------
export function spawnWave(game, z, entries) {
  for (const en of entries) {
    const count = en.count ?? 1;
    for (let i = 0; i < count; i++) {
      let x;
      switch (en.pattern) {
        case 'line': x = -ROAD_HALF * 0.7 + (ROAD_HALF * 1.4 * i) / Math.max(count - 1, 1); break;
        case 'left': x = rand(-ROAD_HALF * 0.8, -ROAD_HALF * 0.2); break;
        case 'right': x = rand(ROAD_HALF * 0.2, ROAD_HALF * 0.8); break;
        case 'center': x = rand(-ROAD_HALF * 0.3, ROAD_HALF * 0.3); break;
        default: x = rand(-ROAD_HALF * 0.8, ROAD_HALF * 0.8);
      }
      spawnEnemy(game, en.type, x, z + (en.stagger ?? 60) * i, en.opts);
    }
  }
}

// ---- the run ----------------------------------------------------------------
// Segment types: wave | gates | obstacles | pickup | boss
const TIMELINE = [
  { at: 300, type: 'wave', entries: [{ type: 'grunt', count: 3, pattern: 'line' }] },
  { at: 700, type: 'gates', defs: [{ key: 'damage' }, { key: 'fireRate' }] },
  { at: 1000, type: 'wave', entries: [{ type: 'grunt', count: 4, pattern: 'line' }, { type: 'runner', count: 2 }] },
  { at: 1400, type: 'obstacles', layout: [{ type: 'crate', x: -100 }, { type: 'crate', x: 100 }, { type: 'spikes', x: 0 }] },
  { at: 1700, type: 'gates', defs: [{ key: 'multishot' }, { key: 'hurt' }] },
  { at: 2000, type: 'wave', entries: [{ type: 'runner', count: 5 }] },
  { at: 2400, type: 'gates', defs: [{ key: 'squad' }, { key: 'heal' }] },
  { at: 2800, type: 'boss' },
];

export function createLevel() {
  return {
    timeline: TIMELINE.map((s) => ({ ...s, done: false })),
    bossAt: TIMELINE.find((s) => s.type === 'boss').at,
    bossStarted: false,
    hpScale: 1,
  };
}

export function updateLevel(game, dt) {
  const lvl = game.level;
  const frontier = game.player.z + SPAWN_AHEAD;

  // Gentle global scaling with distance so late waves stay threatening
  lvl.hpScale = 1 + game.player.z / 6000;

  for (const seg of lvl.timeline) {
    if (seg.done || seg.at > frontier) continue;
    seg.done = true;
    const z = seg.at;
    switch (seg.type) {
      case 'wave': spawnWave(game, z, seg.entries); break;
      case 'gates': spawnGateRow(game, z, seg.defs); break;
      case 'obstacles':
        for (const o of seg.layout) spawnObstacle(game, o.type, o.x, z + (o.dz ?? 0));
        break;
      case 'pickup':
        for (const p of seg.items) spawnPickup(game, p.kind, p.x, z);
        break;
      case 'boss':
        if (!lvl.bossStarted) {
          lvl.bossStarted = true;
          game.pendingBossAt = seg.at; // main.js stops the run when player arrives
        }
        break;
    }
  }
}

// Progress toward the boss, 0..1 (for the HUD progress bar)
export function levelProgress(game) {
  return Math.min(game.player.z / game.level.bossAt, 1);
}
