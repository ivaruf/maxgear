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
import { spawnEnemy, ENEMY_TYPES } from './enemies.js';
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

// v1.4 campaign: gate pools only offer tracks whose tier is unlocked by the
// current level (upgrades.js ENTRIES[key].tier; non-tracks are always legal).
// resolveGateDefs sets this from the level def for the duration of one call.
let ACTIVE_TIER = 3;
const tierOK = (key) => {
  const e = ENTRIES[key];
  return !e || !e.track || (e.tier ?? 1) <= ACTIVE_TIER;
};
const FALLBACK_INSTANTS = ['surplus', 'repair'];

// '@own': owned (LV1+) and still has headroom.
const pickOwn = (player, taken) =>
  bestTrack(player, (key, lv, def) => !taken.has(key) && lv >= 1 && lv < def.maxLv);

const pickFrom = (player, taken, test) => {
  const open = TRACK_ORDER.filter((k) => !taken.has(k) && test(k));
  return open.length ? choice(open) : null;
};
const pickNew = (player, taken) => pickFrom(player, taken, (k) => trackLevel(player, k) === 0 && tierOK(k));
const pickAny = (player, taken) => pickFrom(player, taken, (k) => !isMaxed(player, k) && tierOK(k));

function pickToken(player, tok, taken) {
  if (tok === OWN) return pickOwn(player, taken);
  if (tok === NEW) return pickNew(player, taken);
  if (!tok || taken.has(tok) || !isOffered(player, tok) || !tierOK(tok)) return null;
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
  ACTIVE_TIER = tier.maxTier ?? game?.levelDef?.tier ?? 3;
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

// ---- run tuning ---------------------------------------------------------------
// v1.4: runs are GENERATED per campaign level (see generateTimeline). hpScale =
// hpBase + z/length where hpBase grows HP_BASE_PER_LEVEL per campaign level.
export const BOSS_AT = 17000;      // back-compat default (level 4 length)
export const HP_SCALE_MAX = 6;     // ceiling: hpScale tops out at 6x base HP
export const HP_BASE_PER_LEVEL = 0.9;

// ---- v1.3 variety knobs -----------------------------------------------------
// Rolled ONCE per run in createLevel() (density / jitter / gate mods) so a run
// is internally consistent and inspectable; substitution + ambushes roll live.
export const DENSITY = [0.85, 1.25];        // multiplies every wave count
export const SEG_JITTER = 150;              // +/- z slide, wave/obstacles/pickup
export const GATE_JITTER = 100;             // +/- z slide, gate rows
export const MIN_GAP = 120;                 // z gap a slide may never eat into
// jitter bounds are per-level now: [tutorialEnd, length - 400] (see createLevel)

// Same-tier swaps only, so a wave keeps its ROLE. `mini` is light on purpose:
// swarm waves must never become a wall of tanks. A type may stand in only when
// it is AVAILABLE this level (in the pool AND already showcased) — availability
// lives in lvl.available (showcase segments add their type as they fire).
export const TIERS = {
  light: ['grunt', 'runner', 'mini'],
  medium: ['shooter', 'splitter', 'bomber', 'welder'],
  heavy: ['tank', 'charger', 'shield', 'turret'],
};
export const SUB_CHANCE = 0.35;             // per non-fixed wave entry
const TIER_OF = Object.fromEntries(
  Object.entries(TIERS).flatMap(([tier, types]) => types.map((t) => [t, tier])),
);

// Ambushes (updateLevel keeps lvl.nextAmbushZ).
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
function substituteType(type, game) {
  const tier = TIER_OF[type];
  const avail = game.level?.available;
  if (!tier || !avail) return type;
  const pool = TIERS[tier].filter((t) => t !== type && avail.has(t));
  return pool.length ? choice(pool) : type;
}

export function spawnWave(game, z, entries) {
  for (const en of entries) {
    const count = en.count ?? 1;
    const stagger = en.stagger ?? 60;
    const pattern = PATTERNS[en.pattern] || PATTERNS.random;
    // `fixed` entries (every showcase wave + pre-rolled ambushes) never swap.
    const type = !en.fixed && chance(SUB_CHANCE) ? substituteType(en.type, game) : en.type;
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
// Only these segment types may slide; end fights and set-piece anchors do not.
const jitterable = (s) => s.type !== 'boss';

function jitterTimeline(timeline, loZ, hiZ) {
  const orig = timeline.map((s) => s.at);
  const last = timeline.length - 1;
  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    if (!jitterable(seg) || seg.tutorial || seg.fixedAt) continue;
    const amp = seg.type === 'gates' ? GATE_JITTER : SEG_JITTER;
    const prevGap = i > 0 ? Math.min(MIN_GAP, orig[i] - orig[i - 1]) : 0;
    const nextGap = i < last ? Math.min(MIN_GAP, orig[i + 1] - orig[i]) : 0;
    // Never slide back into the tutorial/showcases, never past the pre-end halt.
    const lo = Math.max(loZ, i > 0 ? timeline[i - 1].at + prevGap : -Infinity);
    const hi = Math.min(hiZ, i < last ? orig[i + 1] - nextGap : Infinity);
    if (hi <= lo) continue;
    seg.at = Math.round(clamp(orig[i] + rand(-amp, amp), lo, hi));
  }
}

// Per-row gate modifiers. The TUTORIAL rows (G1/G2) never get one: they are the
// "shoot the gate, it gets better" lesson and must stay wide, centred, 1-slot.
// gates.js owns the geometry — we only decide and pass opts.
function rollGateMods(seg, def) {
  if (seg.tutorial) return;
  if (chance(GATE_NARROW_CHANCE)) seg.narrow = true;
  if (seg.defs.length === 2 && seg.at > def.length * 0.25 && chance(GATE_THIRD_CHANCE)) {
    // A third choice, branching the build out. resolveGateDefs' fallback chain
    // (@own -> any non-maxed -> repair/surplus) covers an exhausted '@new', and
    // its `taken` set guarantees the three slots are DISTINCT keys.
    // NOTE: a new array — the authored defs array is shared with TIMELINE.
    seg.defs = [...seg.defs, NEW];
  }
  if (seg.defs.length === 1 && chance(GATE_OFFCENTER_CHANCE)) seg.offCenter = choice([-1, 1]);
}

// ---------------------------------------------------------------------------
// v1.4 CAMPAIGN GENERATOR — a level is assembled, not authored.
// createLevel(levelDef, difficulty, introduced) builds `length` units of road:
//   [fresh-L1 tutorial] -> showcases for never-seen types -> alternating
//   wave/obstacle/loot blocks -> midpoint set-piece -> late ramp ->
//   pre-end recovery -> end fight at `length`.
// `introduced` (campaign-wide Set) is MUTATED: types this level showcases are
// added, so the next level skips their introduction. Runtime spawn gating
// lives in lvl.available (a showcase adds its type the moment it fires).
// ---------------------------------------------------------------------------

const DEFAULT_DEF = Object.freeze({
  id: 4, name: 'THE IRONWORKS', length: 17000, tier: 3, end: 'ironclad',
  enemyPool: 'all', gateRows: 7,
});

const TRADES = ['tradeScattergun', 'tradeGlassCannon', 'tradeOverpressure'];
const ACT_FLAVOR = ['IGNITION', 'PRESSURE', 'OVERDRIVE'];

function resolvePool(def) {
  if (def.enemyPool !== 'all') return def.enemyPool.slice();
  return Object.keys(ENEMY_TYPES).filter((k) => !ENEMY_TYPES[k].isBoss);
}

// One combat/obstacle block. heat 0..1 = how deep into the level we are.
function rollBlock(z, pool, heat) {
  const r = Math.random();
  if (r < 0.52) {                                   // wave
    const entries = [];
    const n = heat > 0.55 && chance(0.5) ? 2 : 1;
    for (let e = 0; e < n; e++) {
      const type = choice(pool);
      const heavy = TIER_OF[type] === 'heavy';
      const base = heavy ? randInt(1, 2) : randInt(2, 4 + Math.round(heat * 2));
      entries.push({
        type,
        count: Math.max(1, Math.round(base * (0.8 + heat * 0.5))),
        pattern: choice(['line', 'vee', 'columns', 'pincer', 'random', 'edges']),
        stagger: choice([0, 50, 70, 90]),
        opts: heat > 0.8 && chance(0.12) ? { elite: true } : undefined,
      });
    }
    return { at: z, type: 'wave', entries };
  }
  if (r < 0.72) {                                   // hazard course
    const kind = heat > 0.35 && chance(0.4) ? 'mine' : chance(0.5) ? 'spikes' : 'barrier';
    if (kind === 'mine') {
      return { at: z, type: 'obstacles', repeat: { times: randInt(1, 2 + (heat > 0.6 ? 1 : 0)), dz: 240 },
        layout: [{ type: 'mine', x: rand(-130, -60) }, { type: 'mine', x: rand(40, 130) }] };
    }
    if (kind === 'barrier') {
      const side = choice([-1, 1]);
      return { at: z, type: 'obstacles',
        layout: [{ type: 'barrier', x: side * 145 }, { type: 'barrier', x: side * 35 }] };
    }
    const off = choice([-1, 1]);
    return { at: z, type: 'obstacles', repeat: { times: 2, dz: 420 },
      layout: [
        { type: 'spikes', x: off * 130 }, { type: 'spikes', x: off * 30 },
        { type: 'spikes', x: -off * 80, dz: 210 }, { type: 'spikes', x: -off * 175, dz: 210 },
      ] };
  }
  // loot crates (weighted crate table pays; occasionally a forced heal)
  const forced = chance(0.3);
  return { at: z, type: 'obstacles',
    layout: [
      { type: 'crate', x: rand(-140, -50), opts: forced ? drop('heal') : {} },
      { type: 'crate', x: rand(50, 140) },
    ] };
}

// One gate row's slot defs by position in the level.
function gateDefs(def, i, rows) {
  const last = rows - 1;
  const badRow = def.id >= 2 && i === Math.floor(rows / 2);
  if (badRow) {
    const bad = { key: chance(0.5) ? 'rust' : 'breach', levels: def.id >= 3 ? -2 : -1 };
    const good = chance(0.5) ? OWN : NEW;
    return chance(0.5) ? [bad, good] : [good, bad];
  }
  if (def.tier >= 2 && i === last - 1 && chance(0.6)) {
    return chance(0.5)
      ? [choice(TRADES), ['repair', 'plating', OWN]]
      : [['repair', 'plating', OWN], choice(TRADES)];
  }
  if (i === last) return [{ own: true, levels: 2 }, ['plating', 'aegis', 'repair', NEW]];
  return chance(0.5)
    ? [OWN, NEW]
    : [['damage', 'fireRate', 'multishot', 'squad', NEW], [OWN, NEW]];
}

function generateTimeline(def, introduced, pool) {
  const L = def.length;
  const segs = [];
  let z = 350;

  // Fresh-campaign tutorial (level 1 only, before anything else exists)
  const tutorial = def.id === 1 && introduced.size === 0;
  if (tutorial) {
    segs.push({ at: 350, type: 'wave', tutorial: true,
      entries: [{ type: 'grunt', count: 2, pattern: 'line', stagger: 0, fixed: true }] });
    segs.push({ at: 900, type: 'gates', tutorial: true, levels: 1, levelCap: 3,
      defs: [{ key: 'damage' }] });
    segs.push({ at: 1550, type: 'obstacles', tutorial: true,
      layout: [{ type: 'crate', x: -100, opts: drop('heal') }, { type: 'crate', x: 100 }] });
    segs.push({ at: 2300, type: 'gates', tutorial: true, levels: 1, levelCap: 3,
      defs: [{ key: 'fireRate' }] });
    if (!introduced.has('grunt')) introduced.add('grunt');
    z = 3000;
  }

  // Showcases: every pool type the campaign has never seen gets a small fixed
  // intro wave. The segment carries `introduces` so updateLevel can flip the
  // runtime availability gate the moment it fires.
  for (const t of pool) {
    if (introduced.has(t)) continue;
    segs.push({ at: z, type: 'wave', fixedAt: true, introduces: t,
      entries: [{ type: t, count: t === 'mini' ? 4 : 2, pattern: 'center', stagger: 130, fixed: true }] });
    introduced.add(t);
    z += 750;
  }
  const showcasesEnd = z;

  // Gate rows: evenly spread over the remaining road (tutorial rows count
  // toward the budget on a fresh level 1).
  const rowBudget = Math.max(1, def.gateRows - (tutorial ? 2 : 0));
  const g0 = Math.max(showcasesEnd + 500, L * 0.1);
  const g1 = L * 0.92;
  for (let i = 0; i < rowBudget; i++) {
    const gz = Math.round(g0 + ((g1 - g0) * i) / Math.max(1, rowBudget - 1));
    const late = gz > L * 0.55;
    segs.push({ at: gz, type: 'gates',
      levels: late ? 2 : 1, levelCap: late ? 3 : 2, maxTier: def.tier,
      defs: gateDefs(def, i + (tutorial ? 2 : 0), def.gateRows) });
  }

  // Combat/obstacle blocks fill the space between showcases and the pre-end calm
  z = showcasesEnd + rand(300, 600);
  const rampEnd = L - 1500;
  while (z < rampEnd) {
    const heat = clamp((z - showcasesEnd) / (rampEnd - showcasesEnd), 0, 1);
    segs.push(rollBlock(z, pool, heat));
    z += rand(650, 1600 - heat * 500);
  }

  // Midpoint set-piece: a barrier line with an elite behind it, recovery after
  const mid = Math.round(L * 0.55);
  const heavyPool = pool.filter((t) => TIER_OF[t] === 'heavy');
  segs.push({ at: mid, type: 'obstacles', fixedAt: true,
    layout: [{ type: 'barrier', x: -145 }, { type: 'barrier', x: -35 },
      { type: 'crate', x: 120, opts: drop('heal') }] });
  segs.push({ at: mid + 220, type: 'wave', fixedAt: true, entries: [{
    type: heavyPool.length ? choice(heavyPool) : 'grunt',
    count: 1, pattern: 'center', stagger: 0, fixed: true, opts: { elite: true },
  }, { type: choice(pool), count: 3, pattern: 'edges', stagger: 0 }] });

  // Pre-end recovery
  segs.push({ at: L - 1050, type: 'obstacles', fixedAt: true,
    layout: [{ type: 'crate', x: -80, opts: drop('heal') }, { type: 'crate', x: 80, opts: drop('heal') }] });
  segs.push({ at: L - 650, type: 'pickup', fixedAt: true,
    items: def.id >= 3
      ? [{ kind: 'heal', x: -50 }, { kind: 'shieldToken', x: 50 }]
      : [{ kind: 'heal', x: 0 }] });

  // The end fight
  segs.push({ at: L, type: 'boss', fixedAt: true });

  return { segs, tutorialEnd: tutorial ? 3000 : 350 };
}

export function createLevel(def, difficulty, introduced = new Set()) {
  def = def || DEFAULT_DEF;
  const density = rand(DENSITY[0], DENSITY[1]) * (difficulty && difficulty.density ? difficulty.density : 1);
  const pool = resolvePool(def);
  const available = new Set([...introduced].filter((t) => pool.includes(t)));

  const { segs, tutorialEnd } = generateTimeline(def, introduced, pool);
  const timeline = segs.map((s) => cloneSegment(s, density)).sort((a, b) => a.at - b.at);
  jitterTimeline(timeline, tutorialEnd, def.length - 400);
  timeline.sort((a, b) => a.at - b.at);

  const gateZs = [];
  for (const seg of timeline) {
    if (seg.type !== 'gates') continue;
    rollGateMods(seg, def);
    gateZs.push(seg.at);
  }

  return {
    def,
    timeline,
    bossAt: def.length,
    bossStarted: false,
    hpScale: 1,
    hpBase: 1 + (def.id - 1) * HP_BASE_PER_LEVEL,
    density,
    available,                 // runtime spawn gate (showcases add to it)
    gateZs,
    nextAmbushZ: tutorialEnd + 1500,
    acts: [
      [0, `L${def.id} · ${ACT_FLAVOR[0]}`],
      [def.length * 0.38, `L${def.id} · ${ACT_FLAVOR[1]}`],
      [def.length * 0.72, `L${def.id} · ${ACT_FLAVOR[2]}`],
      [def.length - 260, def.end === 'ironclad' ? 'IRONCLAD' : 'FOREMAN'],
    ],
  };
}

// ---- ambushes ---------------------------------------------------------------
// Unscheduled mini-waves so the authored timeline is never the whole story:
// every rand(AMBUSH_GAP) units we flip a coin, and a win drops 2-4 same-tier
// units at the spawn frontier. Guard rails: never in the boss arena run-up,
// never on top of a gate row (the panels must stay readable), never when the
// field is already crowded.
function ambushPool(game) {
  const avail = game.level?.available;
  if (!avail || !avail.size) return null;
  const tiers = [];
  let total = 0;
  for (const tier of Object.keys(TIERS)) {
    const pool = TIERS[tier].filter((t) => avail.has(t));
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
  const pool = ambushPool(game);
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
  if (lvl.nextAmbushZ == null) return;
  while (frontier >= lvl.nextAmbushZ) {
    const z = lvl.nextAmbushZ;
    lvl.nextAmbushZ = z + rand(AMBUSH_GAP[0], AMBUSH_GAP[1]);
    if (chance(AMBUSH_CHANCE) && !ambushBlocked(game, z)) spawnAmbush(game, z);
  }
}

export function updateLevel(game, dt) {
  const lvl = game.level;
  const frontier = game.player.z + SPAWN_AHEAD;

  // Scaling: campaign base (deeper levels are inherently tougher) + in-level
  // growth of ~+1x across the level. Capped so elites never become HP sponges.
  lvl.hpScale = Math.min((lvl.hpBase ?? 1) + game.player.z / (lvl.def?.length ?? 17000), HP_SCALE_MAX);

  const acts = lvl.acts;
  if (acts) {
    for (let i = acts.length - 1; i >= 0; i--) {
      if (game.player.z >= acts[i][0]) { lvl.actLabel = acts[i][1]; break; }
    }
  }

  for (const seg of lvl.timeline) {
    if (seg.done) continue;
    if (seg.at > frontier) break;            // timeline is sorted by `at`
    seg.done = true;
    if (seg.introduces) lvl.available.add(seg.introduces);
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
