// Level director: distance-keyed segment timeline. LEVEL-AGENT OWNS THIS FILE.
//
// The whole run is DATA. The director below is the only thing that spawns;
// nothing in this file spawns imperatively outside of it.
//
// Segment types: wave | gates | obstacles | pickup | boss
//   wave      { entries: [{ type, count?, pattern?, stagger?, xOffset?, opts? }] }
//   gates     { defs: [{ key, value? }] }               1-2 slots (gates.js)
//   obstacles { layout: [{ type, x, dz?, opts? }], repeat?: { times, dz } }
//   pickup    { items:  [{ kind, x, dz? }],        repeat?: { times, dz } }
//   boss      {}                                        sets game.pendingBossAt
//
// Timing: BASE_RUN_SPEED is 250 u/s, so 1 second of travel = 250 units.
//   BOSS_AT 45000 -> 180 s (3:00) of driving before the boss arena.
//   Segments land every ~200-800 units (~1-3 s) so there is never dead air,
//   with deliberately quiet stretches after each difficulty spike.

import { ROAD_HALF, SPAWN_AHEAD } from './config.js';
import { clamp, rand } from './utils.js';
import { spawnEnemy } from './enemies.js';
import { spawnGateRow } from './gates.js';
import { spawnObstacle } from './obstacles.js';
import { spawnPickup } from './pickups.js';

// ---- run tuning (named so the lead can retune without reading the timeline) --
export const BOSS_AT = 45000;      // 45000 / 250 u/s = 180 s of pre-boss travel
export const HP_SCALE_K = 11000;   // enemy hpScale = 1 + z / K
export const HP_SCALE_MAX = 6;     // ceiling: hpScale tops out at 6x base HP
export const GATE_ROWS = 14;       // upgrade opportunities before the boss

// ---- wave spawn patterns ----------------------------------------------------
// Each pattern maps an index to { tx, dzUnit }:
//   tx     = x as a fraction of ROAD_HALF (-1 .. 1)
//   dzUnit = multiplier for the entry's `stagger` (default 60), so a pattern
//            controls its own depth shape. stagger: 0 => everything abreast.
const PATTERNS = {
  // Rank across the road, echelon back in z (the workhorse "wall of enemies").
  line: (i, n) => ({ tx: n > 1 ? -0.7 + (1.4 * i) / (n - 1) : 0, dzUnit: i }),
  left: (i) => ({ tx: rand(-0.8, -0.2), dzUnit: i }),
  right: (i) => ({ tx: rand(0.2, 0.8), dzUnit: i }),
  center: (i) => ({ tx: rand(-0.3, 0.3), dzUnit: i }),
  random: (i) => ({ tx: rand(-0.8, 0.8), dzUnit: i }),
  // Arrowhead aimed at the player: middle arrives first, wings hang back.
  vee: (i, n) => {
    const mid = (n - 1) / 2;
    return { tx: n > 1 ? ((i - mid) / Math.max(mid, 1)) * 0.75 : 0, dzUnit: Math.abs(i - mid) * 1.4 };
  },
  // Two files marching down the inner lanes.
  columns: (i) => ({ tx: (i % 2 === 0 ? -1 : 1) * 0.45, dzUnit: Math.floor(i / 2) }),
  // Left + right squeeze at the same depth (pair up with stagger: 0).
  pincer: (i) => ({ tx: (i % 2 === 0 ? -1 : 1) * rand(0.55, 0.9), dzUnit: Math.floor(i / 2) }),
  // Hug both shoulders, leaving the middle lane open.
  edges: (i) => ({ tx: (i % 2 === 0 ? -1 : 1) * rand(0.8, 0.95), dzUnit: Math.floor(i / 2) }),
};

export function spawnWave(game, z, entries) {
  for (const en of entries) {
    const count = en.count ?? 1;
    const stagger = en.stagger ?? 60;
    const pattern = PATTERNS[en.pattern] || PATTERNS.random;
    for (let i = 0; i < count; i++) {
      const { tx, dzUnit } = pattern(i, count);
      const x = clamp(tx * ROAD_HALF + (en.xOffset ?? 0), -ROAD_HALF + 18, ROAD_HALF - 18);
      spawnEnemy(game, en.type, x, z + stagger * dzUnit, en.opts);
    }
  }
}

// ---- the run ----------------------------------------------------------------
// Written in distance order. Percentages in the zone headers are of BOSS_AT.
const TIMELINE = [
  // == ZONE 1 — TUTORIAL (0-4000 | 0-16 s) =================================
  // Sparse, slow, forgiving. Teaches: things die if you point at them, crates
  // pay out, gates can be shot to make them better, spikes must be dodged.
  { at: 350, type: 'wave', entries: [{ type: 'grunt', count: 2, pattern: 'line', stagger: 0 }] },
  { at: 750, type: 'obstacles', layout: [{ type: 'crate', x: -120 }, { type: 'crate', x: 120 }] },
  // G1 — first gate is a single chargeable slot: "SHOOT ME" is unmissable.
  { at: 1200, type: 'gates', defs: [{ key: 'damage' }] },
  { at: 1550, type: 'wave', entries: [{ type: 'grunt', count: 3, pattern: 'line', stagger: 90 }] },
  { at: 2000, type: 'obstacles', layout: [{ type: 'crate', x: -60 }, { type: 'crate', x: 60 }] },
  { at: 2150, type: 'pickup', items: [{ kind: 'gem', x: -60 }, { kind: 'gem', x: 60 }] },
  { at: 2500, type: 'wave', entries: [{ type: 'grunt', count: 4, pattern: 'vee', stagger: 70 }] },
  { at: 2900, type: 'obstacles', layout: [{ type: 'spikes', x: -70 }, { type: 'spikes', x: 70 }] },
  // G2 — second chargeable single: reinforces "shoot the gate for longer".
  { at: 3200, type: 'gates', defs: [{ key: 'fireRate' }] },
  { at: 3600, type: 'wave', entries: [{ type: 'grunt', count: 3, pattern: 'line', stagger: 80 }] },
  { at: 3850, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },

  // == ZONE 2A — RUNNER (4000-6400 | 16-26 s) ==============================
  { at: 4150, type: 'wave', entries: [{ type: 'runner', count: 3, pattern: 'center', stagger: 130 }] }, // showcase
  { at: 4650, type: 'wave', entries: [{ type: 'runner', count: 4, pattern: 'columns', stagger: 90 }] },
  { at: 5050, type: 'obstacles', layout: [{ type: 'crate', x: -150 }, { type: 'spikes', x: 0 }, { type: 'crate', x: 150 }] },
  { at: 5450, type: 'wave', entries: [
    { type: 'grunt', count: 3, pattern: 'line', stagger: 70 },
    { type: 'runner', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 5950, type: 'pickup', items: [{ kind: 'heal', x: -50 }, { kind: 'gem', x: 50 }] },
  // G3 — first real dilemma: two good options, no safe default.
  { at: 6400, type: 'gates', defs: [{ key: 'damage' }, { key: 'multishot' }] },

  // == ZONE 2B — SHOOTER (6400-10200 | 26-41 s) ============================
  { at: 6900, type: 'wave', entries: [{ type: 'shooter', count: 2, pattern: 'line', stagger: 0 }] },   // showcase
  { at: 7350, type: 'wave', entries: [
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'grunt', count: 3, pattern: 'line', stagger: 60 },
  ] },
  // First barrier: covers x -200..20, right shoulder stays open. Gems behind it.
  { at: 7900, type: 'obstacles', layout: [{ type: 'barrier', x: -145 }, { type: 'barrier', x: -35 }] },
  { at: 8050, type: 'pickup', items: [{ kind: 'gem', x: -90 }], repeat: { times: 3, dz: 70 } },
  { at: 8450, type: 'wave', entries: [
    { type: 'runner', count: 5, pattern: 'pincer', stagger: 0 },
    { type: 'shooter', count: 1, pattern: 'center' },
  ] },
  { at: 8900, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  // Spike slalom: row A blocks left-of-centre, row B blocks right-of-centre.
  { at: 9250, type: 'obstacles', repeat: { times: 2, dz: 420 }, layout: [
    { type: 'spikes', x: -130 }, { type: 'spikes', x: -30 },
    { type: 'spikes', x: 80, dz: 210 }, { type: 'spikes', x: 180, dz: 210 },
  ] },
  { at: 9750, type: 'wave', entries: [
    { type: 'grunt', count: 4, pattern: 'line', stagger: 50 },
    { type: 'shooter', count: 2, pattern: 'right', stagger: 90 },
  ] },
  // G4 — good/bad. The bad slot sits on the RIGHT, punishing autopilot.
  { at: 10200, type: 'gates', defs: [{ key: 'pierce' }, { key: 'hurt' }] },

  // == ZONE 2C — SPLITTER (10200-14000 | 41-56 s) ==========================
  { at: 10700, type: 'wave', entries: [{ type: 'splitter', count: 2, pattern: 'center', stagger: 140 }] }, // showcase
  { at: 11200, type: 'wave', entries: [
    { type: 'splitter', count: 2, pattern: 'line', stagger: 0 },
    { type: 'grunt', count: 3, pattern: 'line', stagger: 60 },
  ] },
  // Mine tutorial: two mines, then a tight grunt line walking straight into them.
  { at: 11700, type: 'obstacles', layout: [{ type: 'mine', x: -70 }, { type: 'mine', x: 70 }] },
  { at: 11880, type: 'wave', entries: [{ type: 'grunt', count: 4, pattern: 'line', stagger: 30 }] },
  { at: 12300, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  { at: 12650, type: 'wave', entries: [
    { type: 'splitter', count: 2, pattern: 'vee', stagger: 90 },
    { type: 'runner', count: 4, pattern: 'columns', stagger: 70 },
  ] },
  { at: 13200, type: 'obstacles', layout: [{ type: 'crate', x: -160 }, { type: 'mine', x: 0 }, { type: 'crate', x: 160 }] },
  { at: 13600, type: 'wave', entries: [
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'grunt', count: 3, pattern: 'line', stagger: 60 },
  ] },
  // G5 — good/good power spike right before the first tank.
  { at: 14000, type: 'gates', defs: [{ key: 'squad' }, { key: 'explosive' }] },

  // == ZONE 2D — TANK (14000-17800 | 56-71 s) ==============================
  { at: 14450, type: 'wave', entries: [{ type: 'tank', count: 1, pattern: 'center' }] },                 // showcase
  { at: 14950, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center' },
    { type: 'grunt', count: 4, pattern: 'line', stagger: 50 },
  ] },
  { at: 15400, type: 'pickup', items: [{ kind: 'heal', x: -60 }, { kind: 'gem', x: 0 }, { kind: 'gem', x: 60 }] },
  // Barrier covering x -90..130: this time the LEFT shoulder is the escape.
  { at: 15800, type: 'obstacles', layout: [{ type: 'barrier', x: -35 }, { type: 'barrier', x: 75 }] },
  { at: 15950, type: 'pickup', items: [{ kind: 'gem', x: 20 }], repeat: { times: 3, dz: 70 } },
  { at: 16350, type: 'wave', entries: [
    { type: 'splitter', count: 3, pattern: 'line', stagger: 70 },
    { type: 'runner', count: 4, pattern: 'pincer', stagger: 40 },
  ] },
  { at: 16650, type: 'pickup', items: [{ kind: 'heal', x: -50 }, { kind: 'heal', x: 50 }] }, // breather between the two Zone-2B walls (QA death cluster)
  { at: 16950, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center' },
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 17450, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  // G6 — mixed: raw crit vs a spray-and-pray trade-off.
  { at: 17800, type: 'gates', defs: [{ key: 'crit' }, { key: 'tradeSprayPray' }] },

  // == ZONE 2E — CHARGER (17800-21600 | 71-86 s) ===========================
  { at: 18250, type: 'wave', entries: [{ type: 'charger', count: 2, pattern: 'center', stagger: 170 }] }, // showcase
  { at: 18750, type: 'wave', entries: [
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'runner', count: 4, pattern: 'columns', stagger: 70 },
  ] },
  { at: 19300, type: 'obstacles', repeat: { times: 3, dz: 230 }, layout: [{ type: 'mine', x: -110 }, { type: 'mine', x: 30 }] },
  { at: 19550, type: 'wave', entries: [{ type: 'grunt', count: 5, pattern: 'line', stagger: 40 }] },
  { at: 20050, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  { at: 20400, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center' },
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'shooter', count: 2, pattern: 'line', stagger: 0 },
  ] },
  // Spikes across x -200..80: commit to the right lane, gem pays for it.
  { at: 21050, type: 'obstacles', layout: [{ type: 'spikes', x: -150 }, { type: 'spikes', x: -50 }, { type: 'spikes', x: 50 }] },
  { at: 21200, type: 'pickup', items: [{ kind: 'gem', x: 150 }] },
  // G7 — utility row: dodge better vs loot better.
  { at: 21600, type: 'gates', defs: [{ key: 'moveSpeed' }, { key: 'magnet' }] },

  // == ZONE 2F — SHIELD (21600-24400 | 86-98 s) ============================
  { at: 22050, type: 'wave', entries: [{ type: 'shield', count: 2, pattern: 'line', stagger: 0 }] },     // showcase
  // Shields hold the middle, runners hug both shoulders: no safe lane, flank or die.
  { at: 22550, type: 'wave', entries: [
    { type: 'shield', count: 2, pattern: 'line', stagger: 0 },
    { type: 'runner', count: 5, pattern: 'edges', stagger: 60 },
  ] },
  { at: 23050, type: 'pickup', items: [{ kind: 'heal', x: -40 }, { kind: 'shieldToken', x: 40 }] },
  { at: 23450, type: 'wave', entries: [
    { type: 'shield', count: 1, pattern: 'center' },
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'splitter', count: 2, pattern: 'line', stagger: 80 },
  ] },
  { at: 24050, type: 'obstacles', layout: [
    { type: 'crate', x: -150 }, { type: 'crate', x: -50 }, { type: 'crate', x: 50 }, { type: 'crate', x: 150 },
  ] },
  // G8 — good/bad with the BAD slot on the LEFT this time (bait flipped).
  { at: 24400, type: 'gates', defs: [{ key: 'loseFireRate' }, { key: 'multishot' }] },

  // == ZONE 3 — MIDPOINT SET-PIECE (24850-26900 | 55-60%) ==================
  // A concrete line across x -200..130 with an elite tank + escort walking out
  // from behind it. Break the wall for the gem trail, or squeeze right and
  // fight in the open. Recovery is guaranteed immediately afterwards.
  { at: 24850, type: 'obstacles', layout: [{ type: 'barrier', x: -145 }, { type: 'barrier', x: -35 }, { type: 'barrier', x: 75 }] },
  { at: 24980, type: 'pickup', items: [{ kind: 'gem', x: -145 }, { kind: 'gem', x: -35 }], repeat: { times: 3, dz: 80 } },
  { at: 25050, type: 'wave', entries: [{ type: 'tank', count: 1, pattern: 'center', opts: { elite: true } }] },
  { at: 25200, type: 'wave', entries: [
    { type: 'shield', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'shooter', count: 2, pattern: 'line', stagger: 0 },
    { type: 'grunt', count: 4, pattern: 'line', stagger: 60 },
  ] },
  { at: 25850, type: 'wave', entries: [{ type: 'charger', count: 2, pattern: 'pincer', stagger: 0 }] },
  { at: 26150, type: 'pickup', items: [{ kind: 'heal', x: -60 }, { kind: 'shieldToken', x: 0 }, { kind: 'heal', x: 60 }] },
  // G9 — recovery row, deliberately tight after the set-piece.
  { at: 26400, type: 'gates', defs: [{ key: 'heal' }, { key: 'maxHp' }] },
  { at: 26800, type: 'pickup', items: [{ kind: 'gem', x: 0 }], repeat: { times: 4, dz: 90 } },

  // == ZONE 4 — LATE GAME (27000-41200 | 108-165 s) ========================
  // Dense mixed waves, elites, mine fields, mini swarms. Heals are spaced so
  // every spike has an exit, but nothing is free any more.
  { at: 27350, type: 'wave', entries: [{ type: 'charger', count: 3, pattern: 'pincer', stagger: 0 }] },
  { at: 27900, type: 'wave', entries: [
    { type: 'splitter', count: 3, pattern: 'line', stagger: 70 },
    { type: 'runner', count: 6, pattern: 'columns', stagger: 60 },
  ] },
  { at: 28500, type: 'obstacles', repeat: { times: 3, dz: 260 }, layout: [
    { type: 'mine', x: -120 }, { type: 'mine', x: 0 }, { type: 'mine', x: 120 },
  ] },
  { at: 28700, type: 'wave', entries: [{ type: 'grunt', count: 6, pattern: 'line', stagger: 40 }] }, // chain-reaction bait
  { at: 29250, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  { at: 29550, type: 'wave', entries: [
    { type: 'tank', count: 2, pattern: 'line', stagger: 0 },
    { type: 'shield', count: 1, pattern: 'center' },
  ] },
  // G10 — the risk row: all-in glass cannon vs a straight heal.
  { at: 30200, type: 'gates', defs: [{ key: 'tradeGlassCannon' }, { key: 'heal' }] },
  { at: 30700, type: 'wave', entries: [{ type: 'mini', count: 10, pattern: 'columns', stagger: 40 }] },  // swarm
  { at: 31350, type: 'obstacles', repeat: { times: 2, dz: 430 }, layout: [
    { type: 'spikes', x: -160 }, { type: 'spikes', x: -60 },
    { type: 'spikes', x: 60, dz: 215 }, { type: 'spikes', x: 160, dz: 215 },
  ] },
  { at: 31500, type: 'pickup', items: [{ kind: 'gem', x: 100 }, { kind: 'gem', x: -100, dz: 215 }] },
  { at: 31950, type: 'wave', entries: [
    { type: 'shooter', count: 4, pattern: 'line', stagger: 0 },
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 32550, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  { at: 32900, type: 'wave', entries: [{ type: 'runner', count: 5, pattern: 'pincer', stagger: 0, opts: { elite: true } }] },
  { at: 33450, type: 'wave', entries: [{ type: 'splitter', count: 4, pattern: 'vee', stagger: 80 }] },
  // G11 — good/bad, bad slot back on the right.
  { at: 34000, type: 'gates', defs: [{ key: 'ricochet' }, { key: 'loseDamage' }] },
  { at: 34500, type: 'obstacles', layout: [
    { type: 'barrier', x: -145 }, { type: 'barrier', x: -35 }, { type: 'mine', x: 130 },
  ] },
  { at: 34650, type: 'pickup', items: [{ kind: 'gem', x: -90 }], repeat: { times: 3, dz: 70 } },
  { at: 35050, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center', opts: { elite: true } },
    { type: 'grunt', count: 5, pattern: 'line', stagger: 50 },
  ] },
  { at: 35700, type: 'pickup', items: [{ kind: 'heal', x: -40 }, { kind: 'shieldToken', x: 40 }] },
  { at: 36100, type: 'wave', entries: [
    { type: 'shield', count: 3, pattern: 'line', stagger: 0 },
    { type: 'runner', count: 6, pattern: 'pincer', stagger: 40 },
  ] },
  { at: 36800, type: 'wave', entries: [{ type: 'mini', count: 12, pattern: 'random', stagger: 30 }] },   // big swarm
  { at: 37350, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  // G12 — mixed: risky blast build vs safe coverage.
  { at: 37800, type: 'gates', defs: [{ key: 'tradeBlastRisk' }, { key: 'spread' }] },
  // Dense minefield, only the right shoulder is clean.
  { at: 38250, type: 'obstacles', repeat: { times: 4, dz: 210 }, layout: [
    { type: 'mine', x: -140 }, { type: 'mine', x: -40 }, { type: 'mine', x: 60 },
  ] },
  { at: 38500, type: 'wave', entries: [
    { type: 'charger', count: 4, pattern: 'pincer', stagger: 0 },
    { type: 'shooter', count: 3, pattern: 'line', stagger: 0 },
  ] },
  { at: 39250, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },
  { at: 39600, type: 'wave', entries: [
    { type: 'shield', count: 2, pattern: 'pincer', stagger: 0, opts: { elite: true } },
    { type: 'charger', count: 2, pattern: 'center', stagger: 120, opts: { elite: true } },
  ] },
  { at: 40300, type: 'wave', entries: [
    { type: 'tank', count: 2, pattern: 'line', stagger: 0 },
    { type: 'splitter', count: 3, pattern: 'vee', stagger: 80 },
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 41000, type: 'pickup', items: [{ kind: 'heal', x: -50 }, { kind: 'heal', x: 50 }] },
  // G13 — hard good/good: more damage or more bodies.
  { at: 41200, type: 'gates', defs: [{ key: 'damage' }, { key: 'squad' }] },

  // == ZONE 5 — PRE-BOSS CALM (41800-44400 | 167-178 s) ====================
  // Deliberately quiet: loot, top up HP, take one last big decision.
  { at: 41800, type: 'obstacles', layout: [
    { type: 'crate', x: -150 }, { type: 'crate', x: -50 }, { type: 'crate', x: 50 }, { type: 'crate', x: 150 },
  ] },
  { at: 42050, type: 'pickup', items: [{ kind: 'gem', x: 0 }], repeat: { times: 4, dz: 90 } },
  { at: 42500, type: 'wave', entries: [{ type: 'grunt', count: 3, pattern: 'line', stagger: 80 }] },
  { at: 43000, type: 'pickup', items: [{ kind: 'heal', x: -50 }, { kind: 'heal', x: 50 }] },
  // G14 — final call: go all-in for boss DPS or buy survivability.
  { at: 43400, type: 'gates', defs: [{ key: 'tradeGlassCannon' }, { key: 'maxHp' }] },
  { at: 43800, type: 'pickup', items: [{ kind: 'heal', x: -60 }, { kind: 'heal', x: 60 }] },
  { at: 44250, type: 'pickup', items: [{ kind: 'gem', x: -70 }, { kind: 'gem', x: 0 }, { kind: 'gem', x: 70 }] },
  // Last 150 units before the run halts at BOSS_AT - 250: a shieldToken is 3 s
  // of invulnerability, so grabbing it here brackets the boss's opening volley.
  { at: 44600, type: 'pickup', items: [{ kind: 'gem', x: -120 }, { kind: 'shieldToken', x: 0 }, { kind: 'gem', x: 120 }] },

  // == ZONE 6 — BOSS =======================================================
  // main.js halts the run at BOSS_AT - 250 and spawns the boss ahead of it.
  { at: BOSS_AT, type: 'boss' },
];

export function createLevel() {
  const timeline = TIMELINE.map((s) => ({ ...s, done: false })).sort((a, b) => a.at - b.at);
  const boss = timeline.find((s) => s.type === 'boss');
  return {
    timeline,
    bossAt: boss ? boss.at : BOSS_AT,
    bossStarted: false,
    hpScale: 1,
  };
}

// Zone names shown as the HUD act chip (ui.js reads game.level.actLabel)
const ACTS = [
  [0, 'ACT 1 · WARM-UP'],
  [4000, 'ACT 2 · THE RAMP'],
  [24850, 'ACT 3 · THE WALL'],
  [27350, 'ACT 4 · DEEP RUN'],
  [41800, 'ACT 5 · FINAL APPROACH'],
  [44740, 'WARLORD'],
];

export function updateLevel(game, dt) {
  const lvl = game.level;
  const frontier = game.player.z + SPAWN_AHEAD;

  // Global scaling with distance so late waves stay threatening while the
  // player's DPS multiplies. Capped so elites never become HP sponges.
  lvl.hpScale = Math.min(1 + game.player.z / HP_SCALE_K, HP_SCALE_MAX);

  for (let i = ACTS.length - 1; i >= 0; i--) {
    if (game.player.z >= ACTS[i][0]) { lvl.actLabel = ACTS[i][1]; break; }
  }

  for (const seg of lvl.timeline) {
    if (seg.done) continue;
    if (seg.at > frontier) break;            // timeline is sorted by `at`
    seg.done = true;
    const z = seg.at;
    const reps = seg.repeat?.times ?? 1;
    const repDz = seg.repeat?.dz ?? 0;
    switch (seg.type) {
      case 'wave':
        spawnWave(game, z, seg.entries);
        break;
      case 'gates':
        spawnGateRow(game, z, seg.defs);
        break;
      case 'obstacles':
        for (let r = 0; r < reps; r++) {
          for (const o of seg.layout) {
            spawnObstacle(game, o.type, o.x, z + (o.dz ?? 0) + r * repDz, o.opts ?? {});
          }
        }
        break;
      case 'pickup':
        for (let r = 0; r < reps; r++) {
          for (const p of seg.items) {
            spawnPickup(game, p.kind, p.x, z + (p.dz ?? 0) + r * repDz);
          }
        }
        break;
      case 'boss':
        if (!lvl.bossStarted) {
          lvl.bossStarted = true;
          game.pendingBossAt = seg.at;       // main.js stops the run when player arrives
        }
        break;
    }
  }
}

// Progress toward the boss, 0..1 (for the HUD progress bar)
export function levelProgress(game) {
  return Math.min(game.player.z / game.level.bossAt, 1);
}
