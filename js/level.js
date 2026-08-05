// Level director: distance-keyed segment timeline. LEVEL-AGENT OWNS THIS FILE.
//
// The whole run is DATA. The director below is the only thing that spawns;
// nothing in this file spawns imperatively outside of it.
//
// Segment types: wave | gates | obstacles | pickup | boss
//   wave      { entries: [{ type, count?, pattern?, stagger?, xOffset?, opts?, fixed? }] }
//              `fixed: true` opts the entry OUT of v1.3 type substitution — every
//              SHOWCASE wave (a type's first appearance) is fixed.
//   gates     { defs: [slot, slot?], levels, levelCap } — v1.2 LEVEL tracks:
//              `levels`/`levelCap` are the ROW TIER (design §B3) and every slot
//              inherits them unless it overrides. See resolveGateDefs() for the
//              slot grammar ('@own' / '@new' / pools / {key}). No value variance.
//   obstacles { layout: [{ type, x, dz?, opts? }], repeat?: { times, dz } }
//   pickup    { items:  [{ kind, x, dz? }],        repeat?: { times, dz } }
//   boss      {}                                        sets game.pendingBossAt
//
// Timing: BASE_RUN_SPEED is 250 u/s, so 1 second of travel = 250 units.
//   BOSS_AT 45000 -> 180 s (3:00) of driving before the boss arena.
//   Segments land every ~200-800 units (~1-3 s) so there is never dead air,
//   with deliberately quiet stretches after each difficulty spike.
//
// ============================================================================
// v1.3 — RUN VARIETY (five knobs, all bounded so the authored pacing survives)
// ============================================================================
//   1 DENSITY      one roll per run scales every wave count (x0.85..1.25)
//   2 Z-JITTER     every non-tutorial, non-boss segment slides +/-150 in z
//                  (gate rows +/-100) without ever reordering or crowding
//   3 SUBSTITUTION 35% of non-`fixed` wave entries swap their type for a
//                  same-TIER type that has already been showcased at that z
//   4 AMBUSHES     unscheduled 2-4 unit waves between the authored segments
//   5 GATE MODS    narrow rows / a third slot / off-centre single slots
// The TUTORIAL (z < TUTORIAL_Z) and the BOSS segment are exempt from all of it:
// the teaching beats and the arena hand-off are identical every run.
// Loot: v1.3 also moved most open-road pickups INTO crates (obstacles.js
// CRATE_LOOT + forced-loot crates), so items have to be shot for.

import { ROAD_HALF, SPAWN_AHEAD } from './config.js';
import { clamp, rand, randInt, choice, chance } from './utils.js';
import { spawnEnemy } from './enemies.js';
import { spawnGateRow } from './gates.js';
import { spawnObstacle } from './obstacles.js';
import { spawnPickup } from './pickups.js';
import { ENTRIES, TRACK_ORDER, bestTrack, isMaxed, isOffered, trackLevel } from './upgrades.js';

// ---- gate slot resolution ---------------------------------------------------
// A gate row is 1-2 SLOTS; every slot resolves to { key, levels, levelCap },
// which is exactly what spawnGateRow() consumes.
//
// SLOT GRAMMAR (one entry of seg.defs per slot):
//   '@own'                    your highest-level non-maxed track (double down)
//   '@new'                    a random LV0 track (branch out)
//   'damage'                  explicit key
//   ['a', 'b', '@new']        random pool; maxed keys are filtered out, and
//                             '@own'/'@new' may appear as pool entries too
//   { key|own|new|pool, levels?, levelCap? }    same, with a tier override
//
// TIERS (design §B3) come from the SEGMENT: seg.levels / seg.levelCap.
//   G1-G2 1/3 · G3-G7 1/2 · G8-G11 2/3 · G12-G14 2/3 (G14 @own slot: 3)
// Per-kind slot values are forced by upgrades.js so gates.js only needs the
// rule `chargeable <=> levels < levelCap`:
//   bad      levels -1/-2, levelCap 0  (charging DEFUSES up to 0)
//   instants levels 1,     levelCap 1  (fixed one-shot)
//   mixed    levels 2..3   (the trade's GAIN side scales, the loss never does)
//
// FALLBACK CHAIN when a token can't resolve (everything maxed / duplicated):
//   @own -> @new -> any non-maxed track -> 'surplus' (never a dead gate).
// The second slot never duplicates the first — so on a fully maxed build the
// row reads SURPLUS + REPAIR rather than the same instant twice.
const OWN = '@own';
const NEW = '@new';
const FALLBACK_INSTANTS = ['surplus', 'repair'];

// '@own': owned (LV1+) and still has headroom.
const pickOwn = (player, taken) =>
  bestTrack(player, (key, lv, def) => !taken.has(key) && lv >= 1 && lv < def.maxLv);

const pickFrom = (player, taken, test) => {
  const open = TRACK_ORDER.filter((k) => !taken.has(k) && test(k));
  return open.length ? choice(open) : null;
};
const pickNew = (player, taken) => pickFrom(player, taken, (k) => trackLevel(player, k) === 0);
const pickAny = (player, taken) => pickFrom(player, taken, (k) => !isMaxed(player, k));

function pickToken(player, tok, taken) {
  if (tok === OWN) return pickOwn(player, taken);
  if (tok === NEW) return pickNew(player, taken);
  if (!tok || taken.has(tok) || !isOffered(player, tok)) return null;
  return tok;
}

// Pool = per-run variety. Resolve every token, then pick among the survivors.
function pickPool(player, pool, taken) {
  const open = [];
  for (const tok of pool) {
    const key = pickToken(player, tok, taken);
    if (key && !open.includes(key)) open.push(key);
  }
  return open.length ? choice(open) : null;
}

function normalizeDef(d) {
  if (typeof d === 'string') return { tokens: [d] };
  if (Array.isArray(d)) return { tokens: d, pool: true };
  if (d && typeof d === 'object') {
    if (Array.isArray(d.pool)) return { tokens: d.pool, pool: true, levels: d.levels, levelCap: d.levelCap };
    if (d.own) return { tokens: [OWN], levels: d.levels, levelCap: d.levelCap };
    if (d.new) return { tokens: [NEW], levels: d.levels, levelCap: d.levelCap };
    return { tokens: [d.key], levels: d.levels, levelCap: d.levelCap };
  }
  return { tokens: [] };
}

// Turn a resolved key + the row tier into the slot contract gates.js reads.
function slotFor(key, spec, tier) {
  const e = ENTRIES[key];
  if (e && !e.track) {
    if (e.kind === 'bad') {
      return { key, levels: -Math.max(1, Math.abs(spec.levels ?? e.slotLevels ?? 1)), levelCap: 0 };
    }
    if (e.kind === 'mixed') {
      const levels = Math.max(1, spec.levels ?? e.slotLevels ?? tier.levels ?? 2);
      return { key, levels, levelCap: Math.max(levels, spec.levelCap ?? tier.levelCap ?? levels) };
    }
    const levels = Math.max(1, e.slotLevels ?? 1);        // instants: fixed
    return { key, levels, levelCap: Math.max(levels, e.slotLevelCap ?? levels) };
  }
  const levels = Math.max(1, spec.levels ?? tier.levels ?? 1);
  return { key, levels, levelCap: Math.max(levels, spec.levelCap ?? tier.levelCap ?? levels) };
}

// tier = the gates segment ({ levels, levelCap }); game supplies player.tracks.
export function resolveGateDefs(game, defs, tier = {}) {
  const player = game?.player ?? { tracks: {} };
  const taken = new Set();
  const out = [];
  for (const d of defs) {
    const spec = normalizeDef(d);
    let key = spec.pool
      ? pickPool(player, spec.tokens, taken)
      : pickToken(player, spec.tokens[0], taken);
    if (!key) {
      key = pickOwn(player, taken) ?? pickNew(player, taken) ?? pickAny(player, taken)
        ?? FALLBACK_INSTANTS.find((k) => !taken.has(k)) ?? 'surplus';
    }
    taken.add(key);
    out.push(slotFor(key, spec, tier));
  }
  return out;
}

// ---- run tuning (named so the lead can retune without reading the timeline) --
export const BOSS_AT = 45000;      // 45000 / 250 u/s = 180 s of pre-boss travel
export const HP_SCALE_K = 11000;   // enemy hpScale = 1 + z / K
export const HP_SCALE_MAX = 6;     // ceiling: hpScale tops out at 6x base HP
export const GATE_ROWS = 14;       // upgrade opportunities before the boss

// ---- v1.3 variety knobs -----------------------------------------------------
// Rolled ONCE per run in createLevel() (density / jitter / gate mods) so a run
// is internally consistent and inspectable; substitution + ambushes roll live.
export const DENSITY = [0.85, 1.25];        // multiplies every wave count
export const SEG_JITTER = 150;              // +/- z slide, wave/obstacles/pickup
export const GATE_JITTER = 100;             // +/- z slide, gate rows
export const MIN_GAP = 120;                 // z gap a slide may never eat into
export const TUTORIAL_Z = 4000;             // below this NOTHING moves or changes
export const JITTER_Z_MAX = BOSS_AT - 400;  // never slide loot past the run halt

// Type substitution. UNLOCKS = the z each type is first SHOWCASED at; a wave may
// only ever substitute in a type the player has already been introduced to.
export const UNLOCKS = {
  grunt: 0, runner: 4150, shooter: 6900, splitter: 10700,
  mini: 10700, tank: 14450, charger: 18250, shield: 22050,
};
// Same-tier swaps only, so a wave keeps its ROLE. `mini` is light on purpose:
// the 10/12-strong swarm waves must never become a wall of tanks.
export const TIERS = {
  light: ['grunt', 'runner', 'mini'],
  medium: ['shooter', 'splitter'],
  heavy: ['tank', 'charger', 'shield'],
};
export const SUB_CHANCE = 0.35;             // per non-fixed wave entry
const TIER_OF = Object.fromEntries(
  Object.entries(TIERS).flatMap(([tier, types]) => types.map((t) => [t, tier])),
);

// Ambushes (updateLevel keeps lvl.nextAmbushZ).
export const AMBUSH_START = 5000;
export const AMBUSH_GAP = [1600, 2800];     // z between ambush ROLLS
export const AMBUSH_CHANCE = 0.5;
export const AMBUSH_COUNT = [2, 4];         // before the density multiplier
export const AMBUSH_PATTERNS = ['pincer', 'edges', 'vee'];
export const AMBUSH_MAX_ENEMIES = 18;       // skip when the field is this busy
export const AMBUSH_CLEAR = 700;            // keep-away from boss arena + gate rows
export const AMBUSH_TIER_WEIGHTS = { light: 3, medium: 2, heavy: 1 };

// Gate row modifiers (gates.js owns the geometry; we only roll + pass opts).
export const GATE_NARROW_CHANCE = 0.28;     // tighter slot bands
export const GATE_THIRD_CHANCE = 0.30;      // 2-slot rows -> 3 choices
export const GATE_THIRD_MIN_Z = 6000;       // ...never in the first two zones
export const GATE_OFFCENTER_CHANCE = 0.40;  // single-slot rows slide off x=0

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

// v1.3 type substitution: keep the authored SHAPE of a wave (count, pattern,
// stagger, elite flag) but roll a same-tier stand-in for its type, so the same
// stretch of road never reads identically twice. A type can only stand in once
// it has had its own showcase (UNLOCKS), and the substitute is always a
// DIFFERENT type — otherwise the entry is left alone.
function substituteType(type, z) {
  const tier = TIER_OF[type];
  if (!tier) return type;
  const pool = TIERS[tier].filter((t) => t !== type && (UNLOCKS[t] ?? 0) <= z);
  return pool.length ? choice(pool) : type;
}

export function spawnWave(game, z, entries) {
  for (const en of entries) {
    const count = en.count ?? 1;
    const stagger = en.stagger ?? 60;
    const pattern = PATTERNS[en.pattern] || PATTERNS.random;
    // `fixed` entries (every showcase wave + pre-rolled ambushes) never swap.
    const type = !en.fixed && chance(SUB_CHANCE) ? substituteType(en.type, z) : en.type;
    for (let i = 0; i < count; i++) {
      const { tx, dzUnit } = pattern(i, count);
      const x = clamp(tx * ROAD_HALF + (en.xOffset ?? 0), -ROAD_HALF + 18, ROAD_HALF - 18);
      spawnEnemy(game, type, x, z + stagger * dzUnit, en.opts);
    }
  }
}

// ---- the run ----------------------------------------------------------------
// Written in distance order. Percentages in the zone headers are of BOSS_AT.
//
// LOOT IS IN CRATES (v1.3). `drop(kind)` forces a crate to pay out that pickup
// on 100% of breaks (obstacles.js instance overrides), and most of the old
// standalone `pickup` segments were converted to 1-2 such crates at the SAME z:
// the payout is unchanged, you just have to shoot for it. Free-standing pickups
// now only survive where QA/pacing needs a guaranteed grab:
//   the tutorial pair (2150/3850), the safety heals at 8900 and 16650,
//   the set-piece recovery at 26150 and the pre-boss cluster (43000+).
// Crates with NO drop() roll the weighted CRATE_LOOT table (six kinds).
const drop = (loot) => Object.freeze({ extra: Object.freeze({ dropChance: 1, loot }) });
const DROP_HEAL = drop('heal');
const DROP_GEM = drop('gem');
const DROP_SHIELD = drop('shieldToken');

const TIMELINE = [
  // == ZONE 1 — TUTORIAL (0-4000 | 0-16 s) =================================
  // Sparse, slow, forgiving. Teaches: things die if you point at them, crates
  // pay out, gates can be shot to make them better, spikes must be dodged.
  { at: 350, type: 'wave', entries: [{ type: 'grunt', count: 2, pattern: 'line', stagger: 0 }] },
  { at: 750, type: 'obstacles', layout: [{ type: 'crate', x: -120 }, { type: 'crate', x: 120 }] },
  // G1 — first gate is a single chargeable slot: "SHOOT ME" is unmissable.
  // Tutorial tier: 1 level granted, chargeable up to 3.
  { at: 1200, type: 'gates', levels: 1, levelCap: 3, defs: [{ key: 'damage' }] },
  { at: 1550, type: 'wave', entries: [{ type: 'grunt', count: 3, pattern: 'line', stagger: 90 }] },
  { at: 2000, type: 'obstacles', layout: [{ type: 'crate', x: -60 }, { type: 'crate', x: 60 }] },
  { at: 2150, type: 'pickup', items: [{ kind: 'gem', x: -60 }, { kind: 'gem', x: 60 }] },
  { at: 2500, type: 'wave', entries: [{ type: 'grunt', count: 4, pattern: 'vee', stagger: 70 }] },
  { at: 2900, type: 'obstacles', layout: [{ type: 'spikes', x: -70 }, { type: 'spikes', x: 70 }] },
  // G2 — second chargeable single: reinforces "shoot the gate for longer".
  { at: 3200, type: 'gates', levels: 1, levelCap: 3, defs: [{ key: 'fireRate' }] },
  { at: 3600, type: 'wave', entries: [{ type: 'grunt', count: 3, pattern: 'line', stagger: 80 }] },
  { at: 3850, type: 'pickup', items: [{ kind: 'heal', x: 0 }] },

  // == ZONE 2A — RUNNER (4000-6400 | 16-26 s) ==============================
  { at: 4150, type: 'wave', entries: [{ type: 'runner', count: 3, pattern: 'center', stagger: 130, fixed: true }] }, // showcase
  { at: 4650, type: 'wave', entries: [{ type: 'runner', count: 4, pattern: 'columns', stagger: 90 }] },
  { at: 5050, type: 'obstacles', layout: [{ type: 'crate', x: -150 }, { type: 'spikes', x: 0 }, { type: 'crate', x: 150 }] },
  { at: 5450, type: 'wave', entries: [
    { type: 'grunt', count: 3, pattern: 'line', stagger: 70 },
    { type: 'runner', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 5950, type: 'obstacles', layout: [{ type: 'crate', x: -50, opts: DROP_HEAL }, { type: 'crate', x: 50, opts: DROP_GEM }] },
  // G3 — first real dilemma: two good options, no safe default. Offense both
  // sides: the run should feel like it is arming up before it starts taxing.
  { at: 6400, type: 'gates', levels: 1, levelCap: 2, defs: [
    ['multishot', 'damage', 'blast'], ['squad', 'fireRate', 'crit'],
  ] },

  // == ZONE 2B — SHOOTER (6400-10200 | 26-41 s) ============================
  { at: 6900, type: 'wave', entries: [{ type: 'shooter', count: 2, pattern: 'line', stagger: 0, fixed: true }] },  // showcase
  { at: 7350, type: 'wave', entries: [
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'grunt', count: 3, pattern: 'line', stagger: 60 },
  ] },
  // First barrier: covers x -200..20, right shoulder stays open. Gem crates behind it.
  { at: 7900, type: 'obstacles', layout: [{ type: 'barrier', x: -145 }, { type: 'barrier', x: -35 }] },
  { at: 8050, type: 'obstacles', layout: [{ type: 'crate', x: -110, opts: DROP_GEM }, { type: 'crate', x: -70, dz: 110, opts: DROP_GEM }] },
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
  // HULL BREACH spawns at full strength (-2 = 25% maxHp) and defuses in two
  // charge steps: full -> half -> DEFUSED.
  { at: 10200, type: 'gates', levels: 1, levelCap: 2, defs: [
    ['lance', 'crit', 'burn', 'arc'], { key: 'breach', levels: -2 },
  ] },

  // == ZONE 2C — SPLITTER (10200-14000 | 41-56 s) ==========================
  { at: 10700, type: 'wave', entries: [{ type: 'splitter', count: 2, pattern: 'center', stagger: 140, fixed: true }] }, // showcase (also introduces mini via splits)
  { at: 11200, type: 'wave', entries: [
    { type: 'splitter', count: 2, pattern: 'line', stagger: 0 },
    { type: 'grunt', count: 3, pattern: 'line', stagger: 60 },
  ] },
  // Mine tutorial: two mines, then a tight grunt line walking straight into them.
  { at: 11700, type: 'obstacles', layout: [{ type: 'mine', x: -70 }, { type: 'mine', x: 70 }] },
  { at: 11880, type: 'wave', entries: [{ type: 'grunt', count: 4, pattern: 'line', stagger: 30 }] },
  { at: 12300, type: 'obstacles', layout: [{ type: 'crate', x: 0, opts: DROP_HEAL }] },
  { at: 12650, type: 'wave', entries: [
    { type: 'splitter', count: 2, pattern: 'vee', stagger: 90 },
    { type: 'runner', count: 4, pattern: 'columns', stagger: 70 },
  ] },
  { at: 13200, type: 'obstacles', layout: [{ type: 'crate', x: -160 }, { type: 'mine', x: 0 }, { type: 'crate', x: 160 }] },
  { at: 13600, type: 'wave', entries: [
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'grunt', count: 3, pattern: 'line', stagger: 60 },
  ] },
  // G5 — good/good power spike right before the first tank: more bodies/coverage
  // on the left, more punch per shot on the right.
  { at: 14000, type: 'gates', levels: 1, levelCap: 2, defs: [
    ['squad', 'multishot', 'saw', 'broadside'], ['blast', 'damage', 'shrapnel'],
  ] },

  // == ZONE 2D — TANK (14000-17800 | 56-71 s) ==============================
  { at: 14450, type: 'wave', entries: [{ type: 'tank', count: 1, pattern: 'center', fixed: true }] },     // showcase
  { at: 14950, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center' },
    { type: 'grunt', count: 4, pattern: 'line', stagger: 50 },
  ] },
  { at: 15400, type: 'obstacles', layout: [{ type: 'crate', x: -60, opts: DROP_HEAL }, { type: 'crate', x: 40, opts: DROP_GEM }] },
  // Barrier covering x -90..130: this time the LEFT shoulder is the escape.
  { at: 15800, type: 'obstacles', layout: [{ type: 'barrier', x: -35 }, { type: 'barrier', x: 75 }] },
  { at: 15950, type: 'obstacles', layout: [{ type: 'crate', x: 10, opts: DROP_GEM }, { type: 'crate', x: 70, dz: 110, opts: DROP_GEM }] },
  { at: 16350, type: 'wave', entries: [
    { type: 'splitter', count: 3, pattern: 'line', stagger: 70 },
    { type: 'runner', count: 4, pattern: 'pincer', stagger: 40 },
  ] },
  { at: 16650, type: 'pickup', items: [{ kind: 'heal', x: -50 }, { kind: 'heal', x: 50 }] }, // breather between the two Zone-2B walls (QA death cluster)
  { at: 16950, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center' },
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 17450, type: 'obstacles', layout: [{ type: 'crate', x: 0, opts: DROP_HEAL }] },
  // G6 — mixed: straight offense vs the scattergun trade (MIXED on the RIGHT).
  { at: 17800, type: 'gates', levels: 1, levelCap: 2, defs: [
    ['crit', 'fireRate', 'arc', 'frost'], ['tradeScattergun', 'homing'],
  ] },

  // == ZONE 2E — CHARGER (17800-21600 | 71-86 s) ===========================
  { at: 18250, type: 'wave', entries: [{ type: 'charger', count: 2, pattern: 'center', stagger: 170, fixed: true }] }, // showcase
  { at: 18750, type: 'wave', entries: [
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'runner', count: 4, pattern: 'columns', stagger: 70 },
  ] },
  { at: 19300, type: 'obstacles', repeat: { times: 3, dz: 230 }, layout: [{ type: 'mine', x: -110 }, { type: 'mine', x: 30 }] },
  { at: 19550, type: 'wave', entries: [{ type: 'grunt', count: 5, pattern: 'line', stagger: 40 }] },
  { at: 20050, type: 'obstacles', layout: [{ type: 'crate', x: 0, opts: DROP_HEAL }] },
  { at: 20400, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center' },
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'shooter', count: 2, pattern: 'line', stagger: 0 },
  ] },
  // Spikes across x -200..80: commit to the right lane, a gem crate pays for it.
  { at: 21050, type: 'obstacles', layout: [{ type: 'spikes', x: -150 }, { type: 'spikes', x: -50 }, { type: 'spikes', x: 50 }] },
  { at: 21200, type: 'obstacles', layout: [{ type: 'crate', x: 150, opts: DROP_GEM }] },
  // G7 — first "double down vs buy utility" row: sharpen what you already have,
  // or pick up survivability before the shield wall.
  { at: 21600, type: 'gates', levels: 1, levelCap: 2, defs: [
    '@own', ['thrust', 'siphon', 'aegis'],
  ] },

  // == ZONE 2F — SHIELD (21600-24400 | 86-98 s) ============================
  { at: 22050, type: 'wave', entries: [{ type: 'shield', count: 2, pattern: 'line', stagger: 0, fixed: true }] },    // showcase
  // Shields hold the middle, runners hug both shoulders: no safe lane, flank or die.
  { at: 22550, type: 'wave', entries: [
    { type: 'shield', count: 2, pattern: 'line', stagger: 0 },
    { type: 'runner', count: 5, pattern: 'edges', stagger: 60 },
  ] },
  { at: 23050, type: 'obstacles', layout: [{ type: 'crate', x: -40, opts: DROP_HEAL }, { type: 'crate', x: 40, opts: DROP_SHIELD }] },
  { at: 23450, type: 'wave', entries: [
    { type: 'shield', count: 1, pattern: 'center' },
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'splitter', count: 2, pattern: 'line', stagger: 80 },
  ] },
  { at: 24050, type: 'obstacles', layout: [
    { type: 'crate', x: -150 }, { type: 'crate', x: -50 }, { type: 'crate', x: 50 }, { type: 'crate', x: 150 },
  ] },
  // G8 — good/bad with the BAD slot on the LEFT this time (bait flipped).
  // From here on rows grant 2 levels and charge to 3. RUST eats one level of
  // your best offensive track unless you shoot it out.
  { at: 24400, type: 'gates', levels: 2, levelCap: 3, defs: [
    { key: 'rust', levels: -1 }, '@new',
  ] },

  // == ZONE 3 — MIDPOINT SET-PIECE (24850-26900 | 55-60%) ==================
  // A concrete line across x -200..130 with an elite tank + escort walking out
  // from behind it. Break the wall for the gem crates, or squeeze right and
  // fight in the open. Recovery is guaranteed immediately afterwards.
  { at: 24850, type: 'obstacles', layout: [{ type: 'barrier', x: -145 }, { type: 'barrier', x: -35 }, { type: 'barrier', x: 75 }] },
  { at: 24980, type: 'obstacles', layout: [{ type: 'crate', x: -145, opts: DROP_GEM }, { type: 'crate', x: -35, dz: 110, opts: DROP_GEM }] },
  { at: 25050, type: 'wave', entries: [{ type: 'tank', count: 1, pattern: 'center', opts: { elite: true } }] },
  { at: 25200, type: 'wave', entries: [
    { type: 'shield', count: 2, pattern: 'pincer', stagger: 0 },
    { type: 'shooter', count: 2, pattern: 'line', stagger: 0 },
    { type: 'grunt', count: 4, pattern: 'line', stagger: 60 },
  ] },
  { at: 25850, type: 'wave', entries: [{ type: 'charger', count: 2, pattern: 'pincer', stagger: 0 }] },
  { at: 26150, type: 'pickup', items: [{ kind: 'heal', x: -60 }, { kind: 'shieldToken', x: 0 }, { kind: 'heal', x: 60 }] },
  // G9 — recovery row, deliberately tight after the set-piece.
  { at: 26400, type: 'gates', levels: 2, levelCap: 3, defs: [
    ['repair', 'plating'], ['plating', 'squad', 'aegis'],
  ] },
  { at: 26800, type: 'obstacles', layout: [{ type: 'crate', x: -40, opts: DROP_GEM }, { type: 'crate', x: 40, dz: 120, opts: DROP_GEM }] },

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
  { at: 29250, type: 'obstacles', layout: [{ type: 'crate', x: 0, opts: DROP_HEAL }] },
  { at: 29550, type: 'wave', entries: [
    { type: 'tank', count: 2, pattern: 'line', stagger: 0 },
    { type: 'shield', count: 1, pattern: 'center' },
  ] },
  // G10 — the risk row: all-in trade (MIXED on the LEFT) vs a safe repair.
  { at: 30200, type: 'gates', levels: 2, levelCap: 3, defs: [
    ['tradeGlassCannon', 'tradeScattergun'], ['repair', 'plating', 'aegis'],
  ] },
  { at: 30700, type: 'wave', entries: [{ type: 'mini', count: 10, pattern: 'columns', stagger: 40 }] },  // swarm
  { at: 31350, type: 'obstacles', repeat: { times: 2, dz: 430 }, layout: [
    { type: 'spikes', x: -160 }, { type: 'spikes', x: -60 },
    { type: 'spikes', x: 60, dz: 215 }, { type: 'spikes', x: 160, dz: 215 },
  ] },
  { at: 31500, type: 'obstacles', layout: [{ type: 'crate', x: 100, opts: DROP_GEM }, { type: 'crate', x: -100, dz: 215, opts: DROP_GEM }] },
  { at: 31950, type: 'wave', entries: [
    { type: 'shooter', count: 4, pattern: 'line', stagger: 0 },
    { type: 'charger', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 32550, type: 'obstacles', layout: [{ type: 'crate', x: 0, opts: DROP_HEAL }] },
  { at: 32900, type: 'wave', entries: [{ type: 'runner', count: 5, pattern: 'pincer', stagger: 0, opts: { elite: true } }] },
  { at: 33450, type: 'wave', entries: [{ type: 'splitter', count: 4, pattern: 'vee', stagger: 80 }] },
  // G11 — good/bad, bad slot back on the RIGHT. Late RUST bites -2 levels.
  { at: 34000, type: 'gates', levels: 2, levelCap: 3, defs: [
    '@own', { key: 'rust', levels: -2 },
  ] },
  { at: 34500, type: 'obstacles', layout: [
    { type: 'barrier', x: -145 }, { type: 'barrier', x: -35 }, { type: 'mine', x: 130 },
  ] },
  { at: 34650, type: 'obstacles', layout: [{ type: 'crate', x: -110, opts: DROP_GEM }, { type: 'crate', x: -70, dz: 110, opts: DROP_GEM }] },
  { at: 35050, type: 'wave', entries: [
    { type: 'tank', count: 1, pattern: 'center', opts: { elite: true } },
    { type: 'grunt', count: 5, pattern: 'line', stagger: 50 },
  ] },
  { at: 35700, type: 'obstacles', layout: [{ type: 'crate', x: -40, opts: DROP_HEAL }, { type: 'crate', x: 40, opts: DROP_SHIELD }] },
  { at: 36100, type: 'wave', entries: [
    { type: 'shield', count: 3, pattern: 'line', stagger: 0 },
    { type: 'runner', count: 6, pattern: 'pincer', stagger: 40 },
  ] },
  { at: 36800, type: 'wave', entries: [{ type: 'mini', count: 12, pattern: 'random', stagger: 30 }] },   // big swarm
  { at: 37350, type: 'obstacles', layout: [{ type: 'crate', x: 0, opts: DROP_HEAL }] },
  // G12 — mixed: risky blast build (MIXED on the LEFT) vs doubling down.
  { at: 37800, type: 'gates', levels: 2, levelCap: 3, defs: [
    ['tradeOverpressure', 'blast'], '@own',
  ] },
  // Dense minefield, only the right shoulder is clean.
  { at: 38250, type: 'obstacles', repeat: { times: 4, dz: 210 }, layout: [
    { type: 'mine', x: -140 }, { type: 'mine', x: -40 }, { type: 'mine', x: 60 },
  ] },
  { at: 38500, type: 'wave', entries: [
    { type: 'charger', count: 4, pattern: 'pincer', stagger: 0 },
    { type: 'shooter', count: 3, pattern: 'line', stagger: 0 },
  ] },
  { at: 39250, type: 'obstacles', layout: [{ type: 'crate', x: 0, opts: DROP_HEAL }] },
  { at: 39600, type: 'wave', entries: [
    { type: 'shield', count: 2, pattern: 'pincer', stagger: 0, opts: { elite: true } },
    { type: 'charger', count: 2, pattern: 'center', stagger: 120, opts: { elite: true } },
  ] },
  { at: 40300, type: 'wave', entries: [
    { type: 'tank', count: 2, pattern: 'line', stagger: 0 },
    { type: 'splitter', count: 3, pattern: 'vee', stagger: 80 },
    { type: 'shooter', count: 2, pattern: 'pincer', stagger: 0 },
  ] },
  { at: 41000, type: 'obstacles', layout: [{ type: 'crate', x: -50, opts: DROP_HEAL }, { type: 'crate', x: 50, opts: DROP_HEAL }] },
  // G13 — hard good/good: sharpen the spike, or open a whole new system.
  { at: 41200, type: 'gates', levels: 2, levelCap: 3, defs: ['@own', '@new'] },

  // == ZONE 5 — PRE-BOSS CALM (41800-44400 | 167-178 s) ====================
  // Deliberately quiet: loot, top up HP, take one last big decision.
  { at: 41800, type: 'obstacles', layout: [
    { type: 'crate', x: -150 }, { type: 'crate', x: -50 }, { type: 'crate', x: 50 }, { type: 'crate', x: 150 },
  ] },
  { at: 42050, type: 'obstacles', layout: [{ type: 'crate', x: -60, opts: DROP_GEM }, { type: 'crate', x: 60, dz: 120, opts: DROP_GEM }] },
  { at: 42500, type: 'wave', entries: [{ type: 'grunt', count: 3, pattern: 'line', stagger: 80 }] },
  { at: 43000, type: 'pickup', items: [{ kind: 'heal', x: -50 }, { kind: 'heal', x: 50 }] },
  // G14 — final call: 3 levels into your best system for boss DPS, or buy
  // survivability for the arena.
  { at: 43400, type: 'gates', levels: 2, levelCap: 3, defs: [
    { own: true, levels: 3 }, { pool: ['plating', 'aegis', 'repair'], levels: 2 },
  ] },
  { at: 43800, type: 'pickup', items: [{ kind: 'heal', x: -60 }, { kind: 'heal', x: 60 }] },
  { at: 44250, type: 'obstacles', layout: [{ type: 'crate', x: -70, opts: DROP_GEM }, { type: 'crate', x: 70, opts: DROP_GEM }] },
  // Last 150 units before the run halts at BOSS_AT - 250: a shieldToken is 3 s
  // of invulnerability, so grabbing it here brackets the boss's opening volley.
  { at: 44600, type: 'pickup', items: [{ kind: 'gem', x: -120 }, { kind: 'shieldToken', x: 0 }, { kind: 'gem', x: 120 }] },

  // == ZONE 6 — BOSS =======================================================
  // main.js halts the run at BOSS_AT - 250 and spawns the boss ahead of it.
  { at: BOSS_AT, type: 'boss' },
];

// ---- per-run assembly -------------------------------------------------------
// createLevel() is where a run gets its PERSONALITY: it copies the authored
// TIMELINE (never mutates it), scales wave counts by one density roll, slides
// segments in z, and rolls the gate-row modifiers. Everything is bounded, and
// the tutorial + boss segments come out byte-identical every run.

// A segment is only jitterable if it is past the tutorial and is not the boss.
const jitterable = (seg) => seg.type !== 'boss' && seg.at >= TUTORIAL_Z;

// Wave counts x density (rounded, never below 1). count 1 is invariant by
// construction (round(1 * 0.85..1.25) === 1), so showcase singles stay singles.
function cloneSegment(s, density) {
  const seg = { ...s, done: false };
  if (s.type === 'wave' && s.entries) {
    seg.entries = s.entries.map((en) => ({
      ...en,
      count: Math.max(1, Math.round((en.count ?? 1) * density)),
    }));
  }
  return seg;
}

// Slide each segment in z without ever reordering the timeline or crowding a
// neighbour. Bounds for segment i are
//   lo = (already-placed i-1) + gap        hi = (authored i+1) - gap
// where gap = min(MIN_GAP, the gap the AUTHORED timeline already had), so a
// jittered run can never be tighter than the shipped one (a few authored pairs
// sit closer than MIN_GAP on purpose — e.g. the midpoint set-piece). Both
// bounds bracket the original `at`, so the clamp always has room.
function jitterTimeline(timeline) {
  const orig = timeline.map((s) => s.at);
  const last = timeline.length - 1;
  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    if (!jitterable(seg)) continue;
    const amp = seg.type === 'gates' ? GATE_JITTER : SEG_JITTER;
    const prevGap = i > 0 ? Math.min(MIN_GAP, orig[i] - orig[i - 1]) : 0;
    const nextGap = i < last ? Math.min(MIN_GAP, orig[i + 1] - orig[i]) : 0;
    // Never slide back into the tutorial, never past the pre-boss halt.
    const lo = Math.max(TUTORIAL_Z, i > 0 ? timeline[i - 1].at + prevGap : -Infinity);
    const hi = Math.min(JITTER_Z_MAX, i < last ? orig[i + 1] - nextGap : Infinity);
    if (hi <= lo) continue;
    seg.at = Math.round(clamp(orig[i] + rand(-amp, amp), lo, hi));
  }
}

// Per-row gate modifiers. The TUTORIAL rows (G1/G2) never get one: they are the
// "shoot the gate, it gets better" lesson and must stay wide, centred, 1-slot.
// gates.js owns the geometry — we only decide and pass opts.
function rollGateMods(seg) {
  if (seg.at < TUTORIAL_Z) return;
  if (chance(GATE_NARROW_CHANCE)) seg.narrow = true;
  if (seg.defs.length === 2 && seg.at > GATE_THIRD_MIN_Z && chance(GATE_THIRD_CHANCE)) {
    // A third choice, branching the build out. resolveGateDefs' fallback chain
    // (@own -> any non-maxed -> repair/surplus) covers an exhausted '@new', and
    // its `taken` set guarantees the three slots are DISTINCT keys.
    // NOTE: a new array — the authored defs array is shared with TIMELINE.
    seg.defs = [...seg.defs, NEW];
  }
  if (seg.defs.length === 1 && chance(GATE_OFFCENTER_CHANCE)) seg.offCenter = choice([-1, 1]);
}

export function createLevel() {
  const density = rand(DENSITY[0], DENSITY[1]);
  const timeline = TIMELINE.map((s) => cloneSegment(s, density)).sort((a, b) => a.at - b.at);
  jitterTimeline(timeline);
  timeline.sort((a, b) => a.at - b.at);   // jitter preserves order; keep the invariant explicit
  const gateZs = [];
  for (const seg of timeline) {
    if (seg.type !== 'gates') continue;
    rollGateMods(seg);
    gateZs.push(seg.at);
  }
  const boss = timeline.find((s) => s.type === 'boss');
  return {
    timeline,
    bossAt: boss ? boss.at : BOSS_AT,
    bossStarted: false,
    hpScale: 1,
    density,                    // this run's wave-count multiplier (ambushes read it)
    gateZs,                     // z of every gate row this run (ambush keep-away)
    nextAmbushZ: AMBUSH_START,  // updateLevel advances this
  };
}

// ---- ambushes ---------------------------------------------------------------
// Unscheduled mini-waves so the authored timeline is never the whole story:
// every rand(AMBUSH_GAP) units we flip a coin, and a win drops 2-4 same-tier
// units at the spawn frontier. Guard rails: never in the boss arena run-up,
// never on top of a gate row (the panels must stay readable), never when the
// field is already crowded.
function ambushPool(z) {
  const tiers = [];
  let total = 0;
  for (const tier of Object.keys(TIERS)) {
    const pool = TIERS[tier].filter((t) => (UNLOCKS[t] ?? 0) <= z);
    if (!pool.length) continue;              // nothing of this tier introduced yet
    const w = AMBUSH_TIER_WEIGHTS[tier] ?? 1;
    tiers.push({ pool, w });
    total += w;
  }
  if (!tiers.length) return null;
  let r = rand(0, total);
  for (const t of tiers) { r -= t.w; if (r <= 0) return t.pool; }
  return tiers[tiers.length - 1].pool;
}

function ambushBlocked(game, z) {
  const lvl = game.level;
  if (z > lvl.bossAt - AMBUSH_CLEAR) return true;              // boss arena run-up
  if (game.enemies.length > AMBUSH_MAX_ENEMIES) return true;   // field already busy
  for (const gz of lvl.gateZs ?? []) if (Math.abs(gz - z) < AMBUSH_CLEAR) return true;
  for (const g of game.gates) if (!g.dead && Math.abs(g.z - z) < AMBUSH_CLEAR) return true;
  return false;
}

function spawnAmbush(game, z) {
  const pool = ambushPool(z);
  if (!pool) return;
  const count = Math.max(2, Math.round(randInt(AMBUSH_COUNT[0], AMBUSH_COUNT[1]) * (game.level.density ?? 1)));
  const pattern = choice(AMBUSH_PATTERNS);
  spawnWave(game, z, [{
    type: choice(pool),
    count,
    pattern,
    stagger: pattern === 'vee' ? 70 : 0,   // pincer/edges arrive abreast
    fixed: true,                           // the type was already rolled — no re-roll
    // Tags the spawned enemies (spawnEnemy spreads opts.extra) so ambush units
    // are identifiable in a debug/QA pass. No system reads it.
    opts: { extra: { ambush: true } },
  }]);
}

function updateAmbushes(game, frontier) {
  const lvl = game.level;
  if (lvl.nextAmbushZ == null) lvl.nextAmbushZ = AMBUSH_START;
  while (frontier >= lvl.nextAmbushZ) {
    const z = lvl.nextAmbushZ;
    lvl.nextAmbushZ = z + rand(AMBUSH_GAP[0], AMBUSH_GAP[1]);
    if (chance(AMBUSH_CHANCE) && !ambushBlocked(game, z)) spawnAmbush(game, z);
  }
}

// Zone names shown as the HUD act chip (ui.js reads game.level.actLabel)
// Short names: the HUD act chip must not truncate on 360px-wide screens
const ACTS = [
  [0, 'ACT 1 · IGNITION'],
  [4000, 'ACT 2 · FULL STEAM'],
  [24850, 'ACT 3 · IRON WALL'],
  [27350, 'ACT 4 · GEARWORKS'],
  [41800, 'ACT 5 · LAST MILE'],
  [44740, 'IRONCLAD'],
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
      case 'gates': {
        // seg carries the row tier ({ levels, levelCap }); slots may override.
        // v1.3 row modifiers were rolled in createLevel; gates.js owns what the
        // geometry does with them (narrow bands / an off-centre single slot).
        const opts = {};
        if (seg.narrow) opts.narrow = true;
        if (seg.offCenter) opts.offCenter = seg.offCenter;
        spawnGateRow(game, z, resolveGateDefs(game, seg.defs, seg), opts);
        break;
      }
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

  // AFTER the authored segments: gate rows spawned this frame are already in
  // game.gates, so the ambush keep-away test sees them.
  updateAmbushes(game, frontier);
}

// Progress toward the boss, 0..1 (for the HUD progress bar)
export function levelProgress(game) {
  return Math.min(game.player.z / game.level.bossAt, 1);
}
