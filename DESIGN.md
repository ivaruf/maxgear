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

## Player stats (player.js — upgrades mutate ONLY these)
```js
stats = { damage:10, fireInterval:0.32, projectiles:1, spreadDeg:7, pierce:0,
          critChance:0, explosive:0, ricochet:0, squad:0, moveSpeed:360, magnet:0 }
```
Caps live in `config.js` (`CAPS`) and are enforced in `clampStats()` — upgrades may exceed
temporarily but clamp keeps the game stable (squad ≤ 8, projectiles ≤ 6, fireInterval ≥ 0.07).

## Enemy format (enemies.js, data-driven)
```js
ENEMY_TYPES.grunt = { hp, speed, damage, radius, score, color, behavior:'rush', ... }
```
Behavior = named function in `behaviors` map: `(e, dt, game) => void`. Enemies move by mutating
`e.x/e.z`. Death goes through `killEnemy(game, e, cause)` (handles score, fx, splitting, drops).
Enemy ranged attacks push into `game.enemyShots` via `fireEnemyShot(game, x, z, tx, tz, speed, dmg)`.

## Upgrade / gate format (gates.js, data-driven)
```js
UPGRADES.key = { kind:'good'|'bad'|'mixed', label(v), color?, base?, chargeable?, chargeStep?, max?,
                 apply(game, value) }
```
Gates spawn as rows of 1–2 slots. Chargeable slots gain value when shot (`gateOnShot`). Slot shows
live label + color by kind. Crossing applies exactly one slot, marks the row used, fires fx/toast.

## Level format (level.js, data-driven)
Timeline of segments keyed by distance: `{ at: 900, type:'wave'|'gates'|'obstacles'|'pickup'|'boss', ... }`.
Director spawns a segment when `player.z + SPAWN_AHEAD >= at`. Boss segment sets `runSpeed = 0`
and arena mode; victory = boss dead. Progress = `player.z / bossAt`.

## FX / audio API (call sites already wired — implement, don't rename)
`fx.hitSpark(x,z,color)`, `fx.explosion(x,z,radius,color)`, `fx.muzzle(x,z,dirX?,dirZ?)`, `fx.textPop(x,z,text,color)`,
`fx.gateBurst(x,z,color)`, `fx.bossIntro(dur?)`,
`fx.shake(mag,dur)`, `fx.flash(color,alpha,dur)`, `fx.update(dt)`, `fx.draw(ctx,view)` — world-space x/z.
`audio.shoot/hit/explode/enemyDie/hurt/pickup/gateGood/gateBad/gateCharge/bossRoar/win/lose/click()`,
`audio.toggleMute()`, `audio.setBossMode(bool)`.
Boss HP is DPS-scaled at spawn in main.js (~30s fight for any build) with an overheat-decay failsafe after 75s.

## Visual direction
Dusk synthwave: dark asphalt road, neon cyan player, warm-colored enemies (red/orange/magenta),
gates as translucent glass panels — **blue/green = good, red = bad, purple = trade-off**. Bold flat
geometric shapes, glow via shadowBlur used sparingly, damage numbers as floaters.

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
```
Rules for sub-agents: work ONLY in your files, code against the interfaces above, no new global
state, no DOM access outside ui.js, no top-level side effects (export functions; main.js wires).
