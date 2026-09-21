# MAXGEAR — Internal Design Specification

Lane-runner auto-shooter ("misleading mobile ad game, but real"). One 3–4 minute run:
tutorial waves → escalating encounters with upgrade gates → boss → victory.

## Tech
- Vanilla JS ES modules, Canvas 2D, no build step, no dependencies.
- Serve statically (`python3 -m http.server`). DOM overlay for HUD + menu screens, canvas for world.
- Menus are laid out twice in `css/style.css`: as one centred column, and — under
  `(orientation: landscape) and (max-height: 500px)`, i.e. a phone on its side — as CSS grids
  placed by area over the same markup (title plaque beside its buttons; sound heading beside
  the board; pause menu beside the board; armoury heading beside BACK
  with grid and detail filling the rest and scrolling inside their own boxes; the KEEP card
  dissolves `#lc-pick` with `display: contents` so its two halves become card cells). Add a
  menu element and it needs a `grid-area` in that block or it lands in an auto row. The
  armoury and KEEP previews are restarted from ui.js's resize listener because a preview
  canvas keeps the pixel size it was started at.

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

## Keep-2 (v1.5)
Level clear -> ui.showLevelClear renders a KEEP grid (positive tracks only; rusted plating
resets for free). Player selects exactly min(2, owned); main.confirmKeep(keys) deletes all
other tracks, recomputes, THEN autosaves and starts the next level. Detail pane =
TRACKS[key].blurb + js/previews.js startPreview(canvas, key, level) — animated per-track
vignette using the real bullet style (bulletStyle.js) and stats at that level. Preview rAF
loop is stopped on any screen change (ui.showScreen guards). Space confirms only when
ui.levelClearSelection() is non-null. Level-1 foreman fights at 0.4x (on-ramp), later 0.55x.

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
`audio.toggleMute()`, `audio.isMuted()`, `audio.setBossMode(bool)`, `audio.unlock()`.
Sound-board API (ui.js only): `musicVolume()`, `sfxVolume()`, `setMusicVolume(v)`,
`setSfxVolume(v)` — both 0..1, and both return true if the move cleared a mute.

## Audio (v1.6 — RENDERED, not synthesised)
Every sound is a file. Thirteen Sonic Pi pieces (`tools/audio/*.rb`) → `assets/audio/*.m4a`,
plus the MAXGEAR theme as the music bed; `tools/audio/build.sh` rebuilds the lot. The
WebAudio oscillator bank and the generative Am-F-C-G loop are DELETED — don't reintroduce
synthesis for a new sound, add a piece and re-run the build.
- Graph: `source → per-voice gain → sfxBus | musicBus → master → destination`. master is the
  mute gate; the two buses are the player's sliders, persisted with mute under
  `maxgear.audio.v1`.
- The `with_fx :level, amp:` at the top of each piece is CALIBRATION against the encoder's
  measured peaks (build.sh's header has the why), not a taste knob. The set spans ~15 dB:
  `shoot` at the bottom, `boss-roar` on top.
- Call sites are unchanged and stay unchanged: same thirteen methods, same throttles. Variety
  now comes from `playbackRate` and clustering now pulls gain, because a sample cannot drop
  its own partials.
- `shoot` is the load-bearing one: it fires once per VOLLEY (player.js), so 3.1/s at base up
  to 14.3/s at fireRate LV5 under overdrive. Successive shots alternate a whole tone apart —
  that alternation is what makes fast fire read as pew-pew instead of a stutter, so nothing
  may start dropping shots at rate (the 45 ms throttle sits clear of the 70 ms top rate on
  purpose). The piece is 110 ms with nothing below 150 Hz for the same reason: bass is what
  sums into mud when a sound repeats. Check both if you retune it.
- `setBossMode` ducks: normal play runs the music at 80% of the slider, the end fight at 100%.
  One fixed track has no intensity layer, so level is the only honest lever.
- The board lives in THE MENU (`#screen-pause`, state `'paused'`), which is the one panel
  behind the corner's ☰ plate and has no second home to drift from: `#sound-board` is a
  single node that never moves. It was bolted into the title screen until v1.8, then had a
  `#screen-sound` of its own until v1.9; both are gone. Two levels and a cutoff are set
  once, and hub CLAUDE.md §2 puts a control like that behind a door rather than on the
  screen a player sees every time. The panel wears two faces — `ui.paintMenu(inRun)` says
  PAUSED and shows RESUME and QUIT mid-run, SETTINGS and CLOSE anywhere else — and
  `main.js`'s `menuReturn` is what CLOSE and Esc both leave by, so they cannot disagree.
  Its controls
  call `audio.unlock()` themselves, because the board may be the player's first touch of the
  game. The two rows are MUSIC and EFFECTS; the second said MACHINERY until v1.8 and the
  flavour moved to the line under the heading, because somebody hunting for a slider should
  not have to decode a word to find it.
- Anything unloaded is SKIPPED, never queued — a clank a second late is worse than no clank.
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
js/screen.js                        — ui/audio agent (see the exception below)
tools/audio/ assets/audio/          — ui/audio agent (the .rb pieces are content; nothing
                                      writes assets/audio except tools/audio/build.sh)
js/upgrades.js                      — upgrade agent (track tables, recompute, boss estimator)
js/icons.js                         — visuals (palette glyph painters + bakes)
js/bulletStyle.js                   — visuals (bespoke bullet styles + sprites)
```
Rules for sub-agents: work ONLY in your files, code against the interfaces above, no new global
state, no DOM access outside ui.js, no top-level side effects (export functions; main.js wires).

`js/screen.js` (v1.7) breaks the last two on purpose and must stay broken. It is the title
screen's fullscreen plate: index.html loads it as its OWN `<script type="module">` beside
main.js, so it imports nothing, exports nothing, touches the DOM at the top level and is not
part of main.js's graph at all. That is the point — the title screen is plain markup the browser
paints before the game runs, so a boot failure anywhere else leaves the plate working, and
nothing in the plate can take the game down. Do not fold it into ui.js, do not import it from
anywhere, and do not rename it to the API it calls: uBlock Origin's default lists ban that
basename across the whole of github.io and a blocked static import blanks the entire module
graph (hub CLAUDE.md §2). It is listed by hand in sw.js's ASSETS for the same reason nothing
imports it.
