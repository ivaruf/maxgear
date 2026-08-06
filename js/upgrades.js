// MAXGEAR v1.2 — upgrade ROSTER + derived-stat engine. SYSTEMS-CORE OWNS THIS FILE.
//
// Imports config.js + utils.js ONLY (no game modules) so it never creates a
// cycle and can be unit-tested headless.
//
// ============================================================================
// THE MODEL
// ============================================================================
// Persistent build state is an integer LEVEL MAP: player.tracks = { damage: 3 }.
// `player.stats` is a PURE FUNCTION of it:
//
//   recomputeStats(player)
//     -> Object.assign(stats, BASE_STATS) + stats.maxHp = PLAYER_DEFAULTS.maxHp
//     -> for key of TRACK_ORDER: TRACKS[key].build(stats, lv, player)   (ABSOLUTE writes)
//     -> finalize(stats)          (derived spreadDeg + CAPS crash-guards)
//     -> reconcile player.maxHp / player.hp / living allies' hp
//
// Exactly ONE track owns each stat field, every build() writes ABSOLUTE values
// from its per-level table, so -1 levels (rust) are trivially correct and no
// multiplicative penalty can ever survive a recompute. There is NO value
// variance any more: a level is a level.
//
// ============================================================================
// ENTRY SHAPES (the contract gates.js / ui.js consume)
// ============================================================================
// TRACKS[key] — the 18 levelled tracks:
//   { key, name:'HEAVY SHOT', kind:'good', category:'offense'|'defence',
//     icon:'shell',                 // ICONS key in gates.js
//     track: true,
//     minLv: 0,                     // plating is -2
//     maxLv: 5,
//     build(stats, lv, player),     // writes ABSOLUTE values for that level
//     desc(levels, player) }        // '+2 LEVELS'
//
// INSTANTS[key] / BAD[key] / MIXED[key] — the non-levelled entries:
//   { key, name, kind:'good'|'bad'|'mixed', category:'utility',
//     track: false,
//     icon                          // good/bad
//     iconGain, iconLoss,           // mixed (matches the existing drawSlot split)
//     slotLevels, slotLevelCap,     // the slot values level.js forces for this entry
//     effect: {...},                // declarative summary (healFrac/score/damageFrac/...)
//     trade: { gainKey, gainLv, loseKey?, loseLv?, instantDamageFrac? },   // mixed
//     desc(levels, player),         // 'HEAL 40%' / '-25% HP' / '+2 SPLIT BARREL / -1 HEAVY SHOT'
//     run(game, slot, host) }       // side effects -> { label, changes:[{key,from,to}] }
//
// ENTRIES = { ...TRACKS, ...INSTANTS, ...BAD, ...MIXED } — one lookup for gates.js.
//
// `host` is DEPENDENCY INJECTION so this file stays free of game imports.
// gates.js passes its own imports:
//   host = { healPlayer, damagePlayer }      // damagePlayer(game, amt, ignoreInvuln, opts)
//
// ============================================================================
// SLOT CONTRACT (level.js -> gates.js)
// ============================================================================
// level.js emits slot defs as { key, levels, levelCap }; gates.js adds
// charge/hitFlash/preview* and geometry. SIGNED levels unify both directions:
//
//   good/mixed : levels 1..3, levelCap 2..3   — charging counts UP to levelCap
//   bad        : levels -1/-2, levelCap 0     — charging counts UP to 0 (= DEFUSED)
//   instants   : levels 1,     levelCap 1     — fixed one-shot, not chargeable
//
// so gates.js needs exactly ONE rule:  chargeable  <=>  slot.levels < slot.levelCap
//                                      on charge:  slot.levels += 1
// A bad slot at levels === 0 is DEFUSED and applies nothing (run() no-ops).
//
// RECOMMENDED apply path (one call, all semantics live here):
//   const res = applyUpgrade(game, slot, host);
//   // res = { key, kind, name, label, from, to, changes:[{key,from,to}] }
//   game.lastUpgrade = res;               // ui.js toast + end screen
// The primitives are exported too (addLevels / recomputeStats / entry.run) if
// gates.js prefers the inline flow from the design doc.
//
// PREVIEW (gates.js refreshPreview, every frame — allocation-light, no RNG):
//   const pv = previewSlot(player, slot.key, slot.levels);
//   // pv = { key, name, kind, from, to }   ('rust' resolves your best track LIVE)
//   slot.previewKey = pv.key; slot.previewFrom = pv.from; slot.previewTo = pv.to;
//   legendText = slotLabel(player, slot.key, slot.levels);   // 'TESLA COIL LV3 → LV5'
//
// POOL HELPERS for level.js: trackLevel, isMaxed, isOffered, bestTrack.
//
// ICON KEYS: reused from the existing gates.js ICONS map — shell, rof, fan,
// bomb, crit, chevrons, ally, cross, shellDown, heartCrack.
// NEW glyphs gates.js must add — homing, lance, arc, flame, frost, saw,
// broadside, shards, plate, aegis, siphon, surplus. drawIcon() no-ops on an
// unknown key, so a missing glyph degrades to "no icon", never a crash.
//
// LV5 RIDERS WITH NO STAT FIELD (BASE_STATS is lead-owned; read the level):
//   homing LV5 re-acquire, blast LV5 stagger 0.2s, arc LV5 stagger 0.12s,
//   saw LV5 stagger 0.1s, burn LV5 boss x1.5.
//   -> consumers test `trackLevel(player, 'blast') >= 5`.
//   Riders that DO have a field: burn LV4 spread (burnSpread 90), frost LV5
//   (frostHard 1), lance LV5 (pierceShield 1), saw LV3 shot-shred (sawCount>=3).

import { BASE_STATS, CAPS, PLAYER_DEFAULTS, ALLY_SHOT } from './config.js';
import { clamp, choice } from './utils.js';

const MAXHP_FLOOR = 30;          // plating can never trade the hull below this
const LV5 = 5;                   // design cap for every track

// ---------------------------------------------------------------------------
// Per-level tables. Index = lv - 1. ABSOLUTE values, straight from design §A.
// ---------------------------------------------------------------------------
const LEVELS = {
  // ---- offense -----------------------------------------------------------
  damage:    { damage: [18, 26, 36, 50, 70] },
  fireRate:  { fireInterval: [0.246, 0.200, 0.160, 0.128, 0.107] },
  multishot: { projectiles: [2, 3, 4, 5, 6] },
  homing:    { homing: [3, 5.5, 8, 12, 18], homeRange: [260, 320, 380, 440, 520] },
  lance:     { lance: [1, 2, 3, 4, 6], pierceShield: [0, 0, 0, 0, 1] },
  blast:     { blastR: [80, 105, 130, 160, 195], blastFrac: [0.50, 0.60, 0.70, 0.80, 0.95] },
  arc:       {
    chainJumps: [1, 2, 3, 4, 6],
    chainFrac: [0.35, 0.45, 0.55, 0.65, 0.80],
    chainRange: [140, 165, 190, 215, 250],
  },
  burn:      { burnDps: [8, 16, 26, 40, 60], burnTime: [2.0, 2.4, 2.8, 3.2, 4.0], burnSpread: [0, 0, 0, 90, 90] },
  frost:     { frostSlow: [0.18, 0.28, 0.38, 0.48, 0.60], frostTime: [1.2, 1.5, 1.8, 2.1, 2.5], frostHard: [0, 0, 0, 0, 1] },
  crit:      { critChance: [0.15, 0.25, 0.35, 0.45, 0.55], critMul: [2, 2, 2.25, 2.5, 3] },
  saw:       {
    sawCount: [1, 2, 3, 4, 6],
    sawDmg: [6, 10, 16, 24, 34],
    sawR: [72, 76, 80, 86, 92],
    sawSpin: [2.2, 2.5, 2.8, 3.2, 3.8],
  },
  broadside: { auxLv: [1, 2, 3, 4, 5], auxFrac: [0.50, 0.55, 0.60, 0.70, 0.85] },
  shrapnel:  { shrapnelN: [3, 4, 5, 6, 8], shrapnelFrac: [0.25, 0.30, 0.35, 0.40, 0.50] },
  // ---- defence / utility -------------------------------------------------
  squad:     { squad: [1, 2, 3, 5, 7], allyHp: [60, 60, 75, 90, 110] },
  aegis:     { aegisMax: [1, 1, 1, 1, 2], aegisCd: [11, 9, 7.5, 6, 4.5], aegisShock: [0, 0, 30, 60, 60] },
  siphon:    { siphon: [0.8, 1.5, 2.5, 4, 6], siphonCap: [6, 8, 10, 14, 20] },
  thrust:    { moveSpeed: [400, 440, 480, 520, 560] },
};

// ARMOUR PLATE spans LV-2..LV5 (index = lv + 2): the only track that can go
// negative, so it gets a hand-written table instead of the generic writer.
const PLATING_MAXHP = [50, 75, 100, 125, 150, 175, 200, 225];
const PLATING_ARMOR = [0, 0, 0, 0, 0, 0.08, 0.15, 0.22];

// Absolute-write builder from a LEVELS table (no per-call allocation).
function writer(key) {
  const table = LEVELS[key];
  const fields = Object.keys(table);
  return (stats, lv) => {
    const i = clamp(Math.round(lv), 1, LV5) - 1;
    for (let f = 0; f < fields.length; f++) stats[fields[f]] = table[fields[f]][i];
  };
}

const levelsDesc = (levels) => `${levels > 0 ? '+' : ''}${levels} LEVEL${Math.abs(levels) === 1 ? '' : 'S'}`;

function mkTrack(key, name, category, icon, build = null, minLv = 0) {
  return {
    key, name, kind: 'good', category, icon,
    track: true,
    minLv, maxLv: LV5,
    build: build || writer(key),
    desc: levelsDesc,
  };
}

// ---------------------------------------------------------------------------
// A. THE 18 LEVEL TRACKS
// ---------------------------------------------------------------------------
export const TRACKS = {
  // ---- offense (13) ------------------------------------------------------
  damage:    mkTrack('damage', 'HEAVY SHOT', 'offense', 'shell'),
  fireRate:  mkTrack('fireRate', 'FORCED DRAUGHT', 'offense', 'rof'),
  multishot: mkTrack('multishot', 'SPLIT BARREL', 'offense', 'fan'),
  homing:    mkTrack('homing', 'GYRO SHELL', 'offense', 'homing'),
  lance:     mkTrack('lance', 'LANCE', 'offense', 'lance'),
  blast:     mkTrack('blast', 'BOILER BOMB', 'offense', 'bomb'),
  arc:       mkTrack('arc', 'TESLA COIL', 'offense', 'arc'),
  burn:      mkTrack('burn', 'INCENDIARY', 'offense', 'flame'),
  frost:     mkTrack('frost', 'CRYO-VENT', 'offense', 'frost'),
  crit:      mkTrack('crit', 'HAIR TRIGGER', 'offense', 'crit'),
  saw:       mkTrack('saw', 'FLYWHEELS', 'offense', 'saw'),
  broadside: mkTrack('broadside', 'BROADSIDE', 'offense', 'broadside'),
  shrapnel:  mkTrack('shrapnel', 'DEATH BURST', 'offense', 'shards'),
  // ---- defence / utility (5) --------------------------------------------
  squad:     mkTrack('squad', 'ESCORT', 'defence', 'ally'),
  plating:   mkTrack('plating', 'ARMOUR PLATE', 'defence', 'plate', (stats, lv) => {
    const i = clamp(Math.round(lv), -2, LV5) + 2;
    stats.maxHp = PLATING_MAXHP[i];   // reconciled into player.maxHp/hp below
    stats.armor = PLATING_ARMOR[i];
  }, -2),
  aegis:     mkTrack('aegis', 'AEGIS COIL', 'defence', 'aegis'),
  siphon:    mkTrack('siphon', 'CONDENSER', 'defence', 'siphon'),
  thrust:    mkTrack('thrust', 'THRUST', 'defence', 'chevrons'),
};

// Campaign availability (v1.4): tier 1 offered from level 1, tier 2 from THE
// FOUNDRY, tier 3 from THE SHIPYARDS. level.js filters gate pools by this;
// non-track entries (instants/bad/mixed) have no tier and are always legal
// (mixed trades additionally gated to levelDef.tier >= 2 in level.js).
const TRACK_TIERS = {
  damage: 1, fireRate: 1, multishot: 1, squad: 1, plating: 1, thrust: 1,
  lance: 2, blast: 2, crit: 2, siphon: 2, aegis: 2,
  arc: 3, burn: 3, frost: 3, homing: 3, saw: 3, broadside: 3, shrapnel: 3,
};
for (const k in TRACKS) TRACKS[k].tier = TRACK_TIERS[k] ?? 1;

// One-line pane descriptions (v1.5 level-clear keep screen). Mechanics first,
// flavor second — the player reads these while deciding what survives.
const TRACK_BLURBS = {
  damage: 'Heavier shells. Every bullet hits harder — the backbone of any build.',
  fireRate: 'Stoke the boiler: shorter time between volleys. Multiplies everything else.',
  multishot: 'Extra barrels fire side-by-side. The volley auto-tightens as it widens.',
  homing: 'Gyroscopic shells curve toward the nearest machine. Stops missing for you.',
  lance: 'Shots become needles that punch THROUGH enemies. LV5 ignores shield plates.',
  blast: 'Shells detonate on impact, splashing nearby machines. Bigger boom per level.',
  arc: 'Hits discharge chain lightning that jumps between machines. Loves crowds.',
  burn: 'Shots ignite machines: damage over time. LV4 spreads fire on death.',
  frost: 'Cryo rounds slow enemy gears — movement AND attacks. LV5 cancels charger dashes.',
  crit: 'A chance for golden critical hits at a rising multiplier (up to 3x).',
  saw: 'Brass flywheels orbit your hull, shredding what they touch. LV3+ blocks enemy shots.',
  broadside: 'Auxiliary guns fire to the sides and rear. LV5 is a full ring of iron.',
  shrapnel: 'Machines burst into shrapnel on death, wounding their neighbours.',
  squad: 'Escort ships orbit you and echo your volley at half strength — lighter shells, same guns. Mortal — they soak hits for you.',
  plating: 'Riveted armour: more hull AND a damage reduction from LV3.',
  aegis: 'A recharging aether shield absorbs a hit outright. LV3+ shocks nearby machines.',
  siphon: 'Condense the steam of the fallen: kills heal you, capped per second.',
  thrust: 'Bigger engines. Strafe faster, dodge what others must tank.',
};
for (const k in TRACKS) TRACKS[k].blurb = TRACK_BLURBS[k] || '';

// Build order. No two builds write the same field, so this only fixes
// determinism (and keeps HUD/end-screen listings stable).
export const TRACK_ORDER = [
  'damage', 'fireRate', 'multishot', 'homing', 'lance', 'blast', 'arc',
  'burn', 'frost', 'crit', 'saw', 'broadside', 'shrapnel',
  'squad', 'plating', 'aegis', 'siphon', 'thrust',
];

export const OFFENSE_TRACKS = TRACK_ORDER.filter((k) => TRACKS[k].category === 'offense');
export const DEFENCE_TRACKS = TRACK_ORDER.filter((k) => TRACKS[k].category === 'defence');

// ---------------------------------------------------------------------------
// Level map access
// ---------------------------------------------------------------------------
export function trackLevel(player, key) {
  const lv = player?.tracks?.[key];
  return typeof lv === 'number' && Number.isFinite(lv) ? lv : 0;
}

export function isMaxed(player, key) {
  const def = TRACKS[key];
  return !!def && trackLevel(player, key) >= def.maxLv;
}

// Can this key still be offered by a gate row? Tracks must have headroom;
// mixed trades need headroom on the side they GRANT; instants/bad always can.
export function isOffered(player, key) {
  const e = ENTRIES[key];
  if (!e) return false;
  if (e.track) return !isMaxed(player, key);
  if (e.trade) return !isMaxed(player, e.trade.gainKey);
  return true;
}

// Grant/remove levels. Clamps to the track's own bounds (0..5, plating -2..5).
// Does NOT recompute — callers batch changes then call recomputeStats() once
// (applyUpgrade does this for you).
export function addLevels(player, key, n) {
  const from = trackLevel(player, key);
  const def = TRACKS[key];
  if (!def) return { from, to: from };            // instants have no levels
  if (!player.tracks) player.tracks = {};
  const to = clamp(from + (n || 0), def.minLv, def.maxLv);
  player.tracks[key] = to;
  return { from, to };
}

// Highest-level track passing `filter(key, lv, def)`.
// Ties: offense preferred, then random. Returns null when nothing passes.
// ('@own' in level.js and RUST's victim both come from here.)
export function bestTrack(player, filter = null) {
  let best = null;
  let bestLv = -Infinity;
  for (const key of TRACK_ORDER) {
    const def = TRACKS[key];
    const lv = trackLevel(player, key);
    if (filter && !filter(key, lv, def)) continue;
    if (lv > bestLv) { bestLv = lv; best = [key]; }
    else if (lv === bestLv) best.push(key);
  }
  if (!best) return null;
  if (best.length === 1) return best[0];
  const off = best.filter((k) => TRACKS[k].category === 'offense');
  const pool = off.length ? off : best;
  return pool.length === 1 ? pool[0] : choice(pool);
}

// RUST's victim: your highest-level OWNED offensive track.
export const rustTarget = (player) =>
  bestTrack(player, (key, lv, def) => def.category === 'offense' && lv >= 1);

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------
// Derived fields + CAPS crash-guards. player.js clampStats() still runs after
// this in the gate flow; the overlap is deliberate (this file cannot import it).
export function finalize(stats) {
  stats.projectiles = clamp(Math.round(stats.projectiles), 1, CAPS.projectiles);
  // Volleys tighten as they widen: 1 shot keeps the base cone.
  stats.spreadDeg = stats.projectiles > 1 ? clamp(26 / stats.projectiles, 4.5, 9) : 7;
  stats.damage = clamp(stats.damage, 1, CAPS.damage);
  stats.fireInterval = Math.max(stats.fireInterval, CAPS.fireIntervalMin);
  stats.critChance = clamp(stats.critChance, 0, CAPS.critChance);
  stats.critMul = Math.max(1, stats.critMul);
  stats.squad = clamp(Math.round(stats.squad), 0, CAPS.squad);
  stats.moveSpeed = clamp(stats.moveSpeed, 160, CAPS.moveSpeed);
  stats.lance = clamp(Math.round(stats.lance), 0, CAPS.lance);
  stats.chainJumps = clamp(Math.round(stats.chainJumps), 0, CAPS.chainJumps);
  stats.sawCount = clamp(Math.round(stats.sawCount), 0, CAPS.sawCount);
  stats.auxLv = clamp(Math.round(stats.auxLv), 0, CAPS.auxLv);
  stats.blastR = clamp(stats.blastR, 0, CAPS.blastR);
  stats.burnDps = clamp(stats.burnDps, 0, CAPS.burnDps);
  stats.frostSlow = clamp(stats.frostSlow, 0, CAPS.frostSlow);
  stats.siphon = clamp(stats.siphon, 0, CAPS.siphon);
  stats.aegisMax = clamp(Math.round(stats.aegisMax), 0, CAPS.aegisMax);
  stats.armor = clamp(stats.armor, 0, CAPS.armor);
  stats.maxHp = Math.max(MAXHP_FLOOR, Math.round(stats.maxHp));
  stats.allyHp = Math.max(1, Math.round(stats.allyHp));
  return stats;
}

// HP reconciliation — the only place stats leak back onto the player object.
//  - player.maxHp mirrors stats.maxHp (the HUD/heals keep reading player.maxHp).
//  - GROWING the ceiling comes pre-filled (new plate = new HP), so plating
//    reads as a heal; SHRINKING it (glass cannon, rust on plating) clamps hp.
//  - allyHp: every LIVING ally's max moves to stats.allyHp and gains/loses the
//    same delta. Simplest correct choice: no proportional rescale, so a
//    wounded ally stays wounded by the same absolute amount.
//  - A dead player (hp <= 0) is never healed back above 0 by a recompute.
function reconcile(player, prevMaxHp) {
  const stats = player.stats;
  const next = stats.maxHp;
  player.maxHp = next;
  if (typeof player.hp === 'number') {
    const delta = next - prevMaxHp;
    if (delta > 0 && player.hp > 0) player.hp += delta;
    player.hp = clamp(player.hp, 0, next);
  }
  const allyHp = stats.allyHp;
  const allies = player.allies;
  if (!allies) return;
  for (const a of allies) {
    if (!a || a.dead) continue;
    const prev = typeof a.maxHp === 'number' ? a.maxHp : allyHp;
    const hp = typeof a.hp === 'number' ? a.hp : prev;
    a.maxHp = allyHp;
    a.hp = clamp(allyHp > prev ? hp + (allyHp - prev) : hp, 0, allyHp);
  }
}

// THE recompute. Call after ANY level change (applyUpgrade does it for you).
export function recomputeStats(player) {
  const stats = player.stats || (player.stats = {});
  const prevMaxHp = typeof player.maxHp === 'number' ? player.maxHp
    : (typeof stats.maxHp === 'number' ? stats.maxHp : PLAYER_DEFAULTS.maxHp);
  Object.assign(stats, BASE_STATS);
  stats.maxHp = PLAYER_DEFAULTS.maxHp;        // = ARMOUR PLATE LV0 (100)
  for (const key of TRACK_ORDER) {
    const lv = trackLevel(player, key);
    if (lv !== 0) TRACKS[key].build(stats, lv, player);
  }
  finalize(stats);
  reconcile(player, prevMaxHp);
  return stats;
}

// ---------------------------------------------------------------------------
// D. Boss estimator (design §D) — LANDED dps, defensive/utility excluded.
// ---------------------------------------------------------------------------
export const BOSS_HP_SECONDS = 24;
export const BOSS_HP_MIN = 4500;
export const BOSS_HP_MAX = 60000;

export function estimateBossDps(player) {
  const s = player.stats || BASE_STATS;
  const perShot = s.damage * (1 + s.critChance * (s.critMul - 1));
  const hitFrac = 0.35 + (s.homing ? 0.15 : 0);
  // v1.5.3: escorts volley at ALLY_SHOT.dmgMul strength, so they count as
  // fractional shooters here — else squad-build boss fights overshoot bossSec.
  const volley = (perShot * s.projectiles * (1 + s.squad * ALLY_SHOT.dmgMul) * hitFrac) / s.fireInterval;
  return volley
    + s.burnDps * (trackLevel(player, 'burn') >= LV5 ? 1.5 : 1)
    + (s.blastFrac * perShot * 0.25) / s.fireInterval
    + (s.chainJumps * s.chainFrac * perShot * 0.10) / s.fireInterval;
  // EXCLUDED on purpose: saw / broadside / shrapnel / frost / aegis / siphon /
  // plating / thrust — none of them scale the boss fight reliably.
}

// main.js: boss.maxHp = bossTargetHp(player) (keep the 75s overheat failsafe).
export const bossTargetHp = (player) =>
  clamp(estimateBossDps(player) * BOSS_HP_SECONDS, BOSS_HP_MIN, BOSS_HP_MAX);

// ---------------------------------------------------------------------------
// Non-track entries
// ---------------------------------------------------------------------------
const name = (key) => ENTRIES[key]?.name || key;
const pct = (f) => `${Math.round(f * 100)}%`;

// HULL BREACH bites 25% of maxHp at full strength; each defuse step halves it
// (levels -2 -> -1 -> 0 == DEFUSED).
const BREACH_STEP = 0.125;
const breachFrac = (levels) => clamp(Math.abs(levels || 0) * BREACH_STEP, 0, 0.25);

export const INSTANTS = {
  repair: {
    key: 'repair', name: 'REPAIR', kind: 'good', category: 'utility',
    icon: 'cross', track: false,
    slotLevels: 1, slotLevelCap: 1,             // fixed one-shot, not chargeable
    effect: { healFrac: 0.40 },
    desc: () => 'HEAL 40%',
    run(game, slot, host) {
      const p = game.player;
      host.healPlayer(game, Math.round(p.maxHp * this.effect.healFrac));
      return { label: `REPAIR · HEAL ${pct(this.effect.healFrac)}`, changes: [] };
    },
  },
  surplus: {
    key: 'surplus', name: 'SURPLUS', kind: 'good', category: 'utility',
    icon: 'crit', track: false, // gold starburst reads as "bonus" (no dedicated glyph)
    slotLevels: 1, slotLevelCap: 1,
    effect: { healFrac: 0.20, score: 300 },
    desc: () => 'HEAL 20% · +300',
    // The fallback when every pool is exhausted: never a dead gate.
    run(game, slot, host) {
      const p = game.player;
      host.healPlayer(game, Math.round(p.maxHp * this.effect.healFrac));
      game.score = (game.score || 0) + this.effect.score;
      return { label: `SURPLUS · HEAL ${pct(this.effect.healFrac)} · +${this.effect.score}`, changes: [] };
    },
  },
};

export const BAD = {
  rust: {
    key: 'rust', name: 'RUST', kind: 'bad', category: 'utility',
    icon: 'shellDown', track: false,
    slotLevels: -1, slotLevelCap: 0,            // charging DEFUSES toward 0
    effect: { levels: -1, from: 'bestOffense', defusable: true },
    desc(levels, player) {
      if (!levels) return 'DEFUSED';
      const key = rustTarget(player);
      return key ? `${levels} LV · ${TRACKS[key].name}` : 'NO EFFECT';
    },
    run(game, slot) {
      // slot.levels is signed (-1 / -2); a defused slot (0) applies nothing.
      if (!slot?.levels) return { label: 'RUST · DEFUSED', changes: [] };
      const key = rustTarget(game.player);
      if (!key) return { label: 'RUST · NO EFFECT', changes: [] };
      const ch = { key, ...addLevels(game.player, key, slot.levels) };
      return { label: `RUST · ${TRACKS[key].name} LV${ch.from} → LV${ch.to}`, changes: [ch] };
    },
  },
  breach: {
    key: 'breach', name: 'HULL BREACH', kind: 'bad', category: 'utility',
    icon: 'heartCrack', track: false,
    slotLevels: -2, slotLevelCap: 0,            // full -> half -> DEFUSED
    effect: { damageFrac: 0.25, bypassAegis: true, defusable: true },
    desc: (levels) => (levels ? `-${pct(breachFrac(levels))} HP` : 'DEFUSED'),
    run(game, slot, host) {
      const frac = breachFrac(slot?.levels);
      if (frac <= 0) return { label: 'HULL BREACH · DEFUSED', changes: [] };
      // bypasses AEGIS by design — the shield does not eat a hull breach.
      host.damagePlayer(game, Math.round(game.player.maxHp * frac), true, { bypassAegis: true });
      return { label: `HULL BREACH · -${pct(frac)} HP`, changes: [] };
    },
  },
};

// Trades: the GAIN side scales with slot.levels (chargeable); the LOSS side is
// fixed so charging can never make a trade worse.
function runTrade(game, slot, host) {
  const e = ENTRIES[slot.key];
  const t = e.trade;
  const p = game.player;
  const gainLv = Math.max(1, slot.levels || t.gainLv);
  const changes = [{ key: t.gainKey, ...addLevels(p, t.gainKey, gainLv) }];
  if (t.loseKey) changes.push({ key: t.loseKey, ...addLevels(p, t.loseKey, t.loseLv) });
  recomputeStats(p);                            // maxHp/hp settle BEFORE % damage
  if (t.instantDamageFrac) {
    host.damagePlayer(game, Math.round(p.maxHp * t.instantDamageFrac), true, {});
  }
  return { label: `${e.name} · ${e.desc(gainLv, p)}`, changes };
}

function tradeDesc(levels) {
  const t = this.trade;
  const gain = `+${Math.max(1, levels || t.gainLv)} ${name(t.gainKey)}`;
  const loss = t.loseKey
    ? `${t.loseLv} ${name(t.loseKey)}`
    : `-${pct(t.instantDamageFrac)} HP`;
  return `${gain} / ${loss}`;
}

export const MIXED = {
  tradeScattergun: {
    key: 'tradeScattergun', name: 'SCATTERGUN', kind: 'mixed', category: 'utility',
    iconGain: 'fan', iconLoss: 'shellDown', track: false,
    slotLevels: 2, slotLevelCap: 3,
    trade: { gainKey: 'multishot', gainLv: 2, loseKey: 'damage', loseLv: -1 },
    desc: tradeDesc,
    run: runTrade,
  },
  tradeGlassCannon: {
    key: 'tradeGlassCannon', name: 'GLASS CANNON', kind: 'mixed', category: 'utility',
    iconGain: 'shell', iconLoss: 'plate', track: false,
    slotLevels: 2, slotLevelCap: 3,
    trade: { gainKey: 'damage', gainLv: 2, loseKey: 'plating', loseLv: -2 },
    desc: tradeDesc,
    run: runTrade,
  },
  tradeOverpressure: {
    key: 'tradeOverpressure', name: 'OVERPRESSURE', kind: 'mixed', category: 'utility',
    iconGain: 'bomb', iconLoss: 'heartCrack', track: false,
    slotLevels: 2, slotLevelCap: 3,
    trade: { gainKey: 'blast', gainLv: 2, instantDamageFrac: 0.20 },
    desc: tradeDesc,
    run: runTrade,
  },
};

// One lookup table for gates.js / ui.js.
export const ENTRIES = { ...TRACKS, ...INSTANTS, ...BAD, ...MIXED };

// ---------------------------------------------------------------------------
// Preview / labels (gates.js refreshPreview + ui.js legend/toast/end screen)
// ---------------------------------------------------------------------------
// What WOULD this slot do right now? Pure, no RNG, safe every frame.
export function previewSlot(player, key, levels) {
  const e = ENTRIES[key];
  if (!e) return { key, name: key, kind: 'good', from: 0, to: 0 };
  let tk = null;
  let n = levels || 0;
  if (e.track) tk = key;
  else if (e.trade) { tk = e.trade.gainKey; n = Math.max(1, levels || e.trade.gainLv); }
  else if (key === 'rust' && levels) tk = rustTarget(player);
  if (!tk) return { key, name: e.name, kind: e.kind, from: 0, to: 0 };
  const def = TRACKS[tk];
  const from = trackLevel(player, tk);
  return { key: tk, name: def.name, kind: e.kind, from, to: clamp(from + n, def.minLv, def.maxLv) };
}

// Legend/toast text: 'TESLA COIL LV3 → LV5', 'RUST · -2 LV · HEAVY SHOT'.
export function slotLabel(player, key, levels) {
  const e = ENTRIES[key];
  if (!e) return String(key);
  if (e.track) {
    const pv = previewSlot(player, key, levels);
    return `${e.name} LV${pv.from} → LV${pv.to}`;
  }
  return `${e.name} · ${e.desc(levels, player)}`;
}

// ---------------------------------------------------------------------------
// Apply — the recommended single entry point for gates.js applyGateSlot()
// ---------------------------------------------------------------------------
// host = { healPlayer, damagePlayer } (gates.js already imports both).
// Returns the record ui.js wants on game.lastUpgrade:
//   { key, kind, name, label, from, to, changes:[{key,from,to}] }
export function applyUpgrade(game, slot, host) {
  const p = game.player;
  const e = ENTRIES[slot.key];
  if (!e) { console.error(`Unknown upgrade: ${slot.key}`); return null; }
  let label;
  let changes;
  if (e.track) {
    changes = [{ key: slot.key, ...addLevels(p, slot.key, slot.levels || 0) }];
    label = `${e.name} LV${changes[0].from} → LV${changes[0].to}`;
  } else {
    const res = e.run(game, slot, host) || {};
    label = res.label || slotLabel(p, slot.key, slot.levels);
    changes = res.changes || [];
  }
  recomputeStats(p);                            // idempotent; settles maxHp/allyHp
  const primary = changes[0] || null;
  return {
    key: primary ? primary.key : slot.key,
    kind: e.kind,
    name: e.name,
    label,
    from: primary ? primary.from : 0,
    to: primary ? primary.to : 0,
    changes,
  };
}

// Fresh-run reset: main.js/player.js can wipe the build without touching stats.
export function resetTracks(player) {
  player.tracks = {};
  return recomputeStats(player);
}
