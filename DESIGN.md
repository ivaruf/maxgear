# MAXGEAR — Internal Design Specification

Lane-runner auto-shooter ("misleading mobile ad game, but real"). One 3–4 minute run:
tutorial waves → escalating encounters with upgrade gates → boss → victory.

## Tech
- Vanilla JS ES modules, Canvas 2D, no build step, no dependencies.
- Serve statically (`python3 -m http.server`). DOM overlay for HUD + menu screens, canvas for world.

## Coordinate system (WORLD SPACE — everyone works here)
- `x`: horizontal, **road spans x ∈ [-200, +200]** (`ROAD_HALF = 200` in config.js).
- `z`: forward distance in world units. Player `z` increases at `game.runSpeed` (u/sec, 0 during boss arena).
- All speeds are **world units per second**. All times are **seconds**. `dt` is clamped ≤ 0.05.
- Screen projection is owned by `render.js`: `project(view, x, z) -> {sx, sy, f}` (f = perspective scale,
  1 near player, →0 at horizon). **Never project manually; always call `project`.**
- **Drawing scale convention:** pixels-per-world-unit at an entity's depth is `k = f * view.unitScale`.
  Size every drawn shape in WORLD units × k (e.g. an enemy of radius 17 draws at `17 * k * ~1.15`).
- Camera: `view.camZ = player.z - CAM_BACK`. Entities are culled/despawned when `z < player.z - DESPAWN_BEHIND`.
- Spawning happens at `z = player.z + SPAWN_AHEAD` (just beyond the visible horizon).

## Collision conventions
- All collisions are **circles in the x/z plane** (`x`, `z`, `radius` on every entity).
- Gates are crossing bands: trigger when `prevZ < gate.z <= z` and `|player.x - slot.x| < slot.halfW`.
- `collisions.js` owns ALL collision resolution. Entity modules expose hooks
  (`killEnemy`, `damageObstacle`, `gateOnShot`, `applyGateSlot`, `player.takeDamage`) but never scan other arrays.

## Game object (single source of truth, created in main.js)
```js
game = {
  state: 'title'|'playing'|'paused'|'victory'|'defeat',
  time, runSpeed, score, kills,
  player,                 // see player.js
  enemies: [], projectiles: [], enemyShots: [],
  gates: [], obstacles: [], pickups: [],
  boss: null,             // reference to the boss enemy while alive
  level: {...},           // director state (level.js)
}
```
Arrays use swap-remove of entities with `dead === true` during the cleanup pass in main.js.

## Update order (main.js — fixed, do not reorder)
input → level director → player (move+fire) → projectiles/enemyShots → enemies → obstacles →
pickups → gates → collisions → cleanup → fx → ui.

## Render order (render.js)
sky/background → road → all world entities **sorted by z descending** (painter's algo) →
player+squad → projectiles → fx particles/floaters → screen flash. HUD is DOM.

## Player stats & level tracks (v1.2 — DERIVED STATS)
Persistent build state = `player.tracks` (integer level map, LV0-5; plating -2..5).
`stats` is a pure function of it: `recomputeStats(player)` in js/upgrades.js resets to
BASE_STATS (config.js), runs each track's `build(stats, lv, player)` (exactly ONE track owns
each stat field), then `finalize()` (derived spreadDeg) and clampStats. NEVER mutate stats
persistently outside this flow — the next recompute erases it. Bad effects are therefore
LEVEL operations (rust = -1 level) or instant HP hits (breach). CAPS (config.js) are
crash-guards; LV5 is the design cap. Boss HP = `bossTargetHp(player)` (landed-DPS estimate
× ~24s, clamp 4.5k-60k) — lives in upgrades.js so it can't rot.

18 tracks: damage, fireRate, multishot, homing, lance, blast, arc (chain lightning), burn,
frost, crit, saw (orbiting flywheels), broadside (aux guns), shrapnel, squad, plating,
aegis, siphon, thrust. Non-tracks: repair, surplus (instants); rust, breach (bad, DEFUSABLE
by shooting to 0); tradeScattergun / tradeGlassCannon / tradeOverpressure (mixed).

## Enemy format (enemies.js, data-driven)
```js
ENEMY_TYPES.grunt = { hp, speed, damage, radius, score, color, behavior:'rush', ... }
```
Behavior = named function in `behaviors` map: `(e, dt, game) => void`. Enemies move by mutating
`e.x/e.z`. Death goes through `killEnemy(game, e, cause)` (handles score, fx, splitting, drops).
Enemy ranged attacks push into `game.enemyShots` via `fireEnemyShot(game, x, z, tx, tz, speed, dmg)`.

## Upgrade / gate format (upgrades.js owns the roster; gates.js owns the apparatus)
`ENTRIES[key]` = track or instant/bad/mixed entry (see upgrades.js header for exact shapes).
Gate slots (from level.js `resolveGateDefs`): `{ key, levels (signed), levelCap }` →
spawnGateRow builds `{ key, up, x, halfW, levels, levels0, levelCap, charge, chargeable,
hitFlash, previewKey/previewName/previewFrom/previewTo }`. ONE rule: chargeable ⟺
levels < levelCap; 14 hits = +1 level; bad slots charge -2 → -1 → 0 = DEFUSED (crossing a
defused slot is a no-op). Panels are ICON + ±N + 5-pip strip (words live in the HUD legend).
Level pools: '@own' (highest non-maxed track), '@new' (random LV0), arrays = pools filtered
of maxed keys. Icons come from js/icons.js (colored palette painters + level pips);
projectile appearance from js/bulletStyle.js (style recomputed on weapon-stat change,
double-buffered; cyan-anchored hue clamp ±40° is LOAD-BEARING — player fire must never
read as enemy/gate colors).

## Campaign (v1.4)
js/campaign.js: LEVELS (4 defs: length/tier/enemyPool/gateRows/end) + DIFFICULTIES
(enemyHp/enemyDmg/density/bossSec). js/saves.js: 3 localStorage slots, autosaved at level
clear ({difficulty, levelIndex=NEXT, tracks, score, kills, cleared}). main.js flow:
title → slots → newgame(difficulty) → startLevel(i); build persists via startLevel's
carry; game.campaign.introduced (Set) makes enemy showcases fire once per campaign.
level.js createLevel(levelDef, difficulty, introduced) GENERATES the timeline (tutorial
on fresh L1 → showcases → blocks → midpoint set-piece → recovery → end fight); gate pools
tier-filtered (ENTRIES[key].tier). enemies.js: difficulty multiplies non-boss hp + all
damage; foreman = 2-phase mini-boss (main.js DPS-scales it at 0.55×, ironclad 1×,
× bossSec/24). New machines: bomber (game.mortars, telegraphed AoE, player-only damage),
welder (heals most-damaged non-boss in 260), turret (static, heavy: survives all contact).

## Level format (level.js, data-driven)
Timeline of segments keyed by distance: `{ at: 900, type:'wave'|'gates'|'obstacles'|'pickup'|'boss', ... }`.
Director spawns a segment when `player.z + SPAWN_AHEAD >= at`. Boss segment sets `runSpeed = 0`
and arena mode; victory = boss dead. Progress = `player.z / bossAt`.

v1.3 per-run randomness (knobs = exported consts at the top of level.js): wave-count
density roll, segment z-jitter (tutorial + boss fixed), same-tier enemy substitution
respecting UNLOCKS (`fixed: true` wave entries never substitute), random ambush waves,
and gate mods — narrow rows (×0.62 width), THIRD slots (gate rows are 1-3 slots;
`spawnGateRow(game, z, defs, opts {narrow, offCenter})`), off-center singles.
Crate loot = weighted CRATE_LOOT table in obstacles.js (heal/gem/shieldToken/overdrive/
steamburst/gearbox); crates accept per-instance {dropChance, loot} overrides; most loot
lives IN crates, few open pickups remain (QA safety heals + pre-boss recovery).

## FX / audio API (call sites already wired — implement, don't rename)
`fx.hitSpark(x,z,color)`, `fx.explosion(x,z,radius,color)`, `fx.muzzle(x,z,dirX?,dirZ?)`, `fx.textPop(x,z,text,color)`,
`fx.gateBurst(x,z,color)`, `fx.bossIntro(dur?)`, `fx.arc(x1,z1,x2,z2,color,w?,life?)`,
`fx.frostPuff(x,z)`, `fx.siphonThread(x1,z1,x2,z2)`, (muzzle takes optional trailing color),
`fx.shake(mag,dur)`, `fx.flash(color,alpha,dur)`, `fx.update(dt)`, `fx.draw(ctx,view)` — world-space x/z.
`audio.shoot/hit/explode/enemyDie/hurt/pickup/gateGood/gateBad/gateCharge/bossRoar/win/lose/click()`,
`audio.toggleMute()`, `audio.setBossMode(bool)`.
Boss HP is DPS-scaled at spawn in main.js (~30s fight for any build) with an overheat-decay failsafe after 75s.

## Visual direction — STEAMPUNK (v1.1 re-theme)
Brass-and-iron Victorian machine age at dusk. The world is machinery: gears, rivets, pistons,
pressure gauges, steam, smokestacks, drifting zeppelins, floating parallax cogs.

**Color semantics ARE gameplay and MUST survive the re-theme** (only materials/shapes change):
- player/allies/projectiles: aether cyan glow (existing `#35e0ff` family) — unchanged hexes
- enemies: rusted red / copper / magenta family — unchanged hexes per type
- gates: **green = good, red = bad, purple = trade-off**, gold = chargeable — hues retuned in
  v1.1.1 to aged enamel so they sit in the brass world: good `#56b06c`, bad `#d2513c`,
  mixed `#a97bd1` (`GATE_COLORS` in gates.js + `--good/--bad/--mixed` in style.css are the
  single sources; keep them in sync)
- Environment shifts to sepia/brass/iron: iron `#1a1512`, coal `#0f0c09`, brass `#c9973b`,
  bright brass `#f0b429`, copper `#b0652f`, rust `#8a3324`, steam `rgba(230,225,215,α)`.

Motifs: slow-rotating gears (drive rotation from entity `age` or `game.time` — never
`Date.now()`), riveted plates, brass frames, pressure-gauge dials, steam puffs, copper piping.
A giant brass clock-face sun on the horizon; industrial smokestack skyline; 1-2 distant zeppelins.

Hard rules for the re-theme:
- DRAW-ONLY + flavor text. No stat, radius, speed, spawn, or collision changes of any kind.
- Keep every exported API/signature; keep hit-flash, HP bars, elite auras, telegraph reads.
- Perf budget unchanged: bake sprites at resize, no new per-frame allocations in hot loops,
  shadowBlur sparingly, respect LIMITS.
- Boss renamed **IRONCLAD** (`ENEMY_TYPES.boss.name` + victory-screen copy).

## File ownership
```
index.html css/style.css            — lead (UI agent may extend style.css)
js/config.js js/utils.js js/main.js — LEAD ONLY (request changes in notes)
js/input.js js/render.js            — lead (FX agent may extend render.js visuals, keep project() intact)
js/player.js js/projectiles.js      — lead
js/collisions.js                    — lead
js/enemies.js                       — enemy agent
js/gates.js js/pickups.js           — upgrade agent
js/level.js js/obstacles.js         — level agent
js/effects.js (+render.js visuals)  — fx agent
js/ui.js js/audio.js (+style.css)   — ui/audio agent
js/upgrades.js                      — upgrade agent (track tables, recompute, boss estimator)
js/icons.js                         — visuals (palette glyph painters + bakes)
js/bulletStyle.js                   — visuals (bespoke bullet styles + sprites)
```
Rules for sub-agents: work ONLY in your files, code against the interfaces above, no new global
state, no DOM access outside ui.js, no top-level side effects (export functions; main.js wires).
