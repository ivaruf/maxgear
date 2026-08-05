# MAXGEAR — Gate Rush

*The ad was fake. This one is real.*

A polished browser arcade lane-shooter inspired by the "misleading mobile game ad" genre —
auto-fire down a brass-and-iron steampunk highway, steer through upgrade gates, multiply your
firepower, mow down waves of clockwork machines, and take down the IRONCLAD at the end of a
~3-minute run — under a giant clock-face sun, drifting zeppelins, and flying gears.

No frameworks, no build step, no assets, no network calls: vanilla JS ES modules + Canvas 2D,
procedural graphics, and Web Audio synthesized sound.

## Run it

Any static file server works (ES modules can't load from `file://`):

```bash
cd maxgear
python3 -m http.server 8000
# then open http://localhost:8000
```

or `npx serve`, or any equivalent. No install, no build, no backend.

## Install as an app / GitHub Pages

The game is a PWA: a service worker (`sw.js`) precaches everything for offline play, and
`manifest.webmanifest` + generated icons make it installable ("Add to Home Screen" /
install icon in the address bar) once it's served over HTTPS.

**Deploy to GitHub Pages:** push the repo, then Settings → Pages → deploy from branch
(root). All paths are relative, so it works from the `https://<user>.github.io/<repo>/`
subpath as-is (`.nojekyll` is included).

**Shipping an update:** bump `VERSION` at the top of `sw.js` (e.g. `v1.0.0` → `v1.0.1`)
in the same commit as your changes. On the next launch the new version is precached in
the background, old caches are deleted, and the page auto-reloads — only from the title
screen, never mid-run. (Without a bump, returning visitors keep playing the cached build.)

**Local dev note:** once the service worker has registered in your browser, it serves the
cached build. While developing, either bump `VERSION`, or use DevTools → Application →
Service Workers → "Update on reload" / "Bypass for network".

## Controls

| Action | Desktop | Mobile |
|---|---|---|
| Steer | `A`/`D` or `←`/`→`, or drag with the mouse | drag horizontally |
| Shoot | automatic | automatic |
| Start | `Space` / `Enter` / click / tap | tap |
| Pause | `Esc` / `P` (or ⏸ button) | ⏸ button |
| Restart | `R` (any time) | tap after win/lose |
| Mute | `M` (or 🔊 button) | 🔊 button |

**Gates:** green = good, red = bad, purple = trade-off. Every upgrade is a **level track
(LV1→LV5)** — crossing a gate grants levels; **shooting** a chargeable gate (pulsing ⌖) pumps
in extra levels before you cross (14 hits = +1). Red gates can be **shot to DEFUSE**: charge
them up to zero and they become harmless scrap. Panels show icon + number + level pips; the
legend at the bottom of the HUD spells out exactly what the approaching gate will do.
You can still thread the gap between a gate pair to take neither.

## Architecture

Plain ES modules around a single mutable `game` state object; data-driven content tables;
one canonical coordinate system. See `DESIGN.md` for the full internal spec.

- **World space:** `x` ∈ [-200, 200] across the road, `z` = forward distance (units), speeds in
  units/sec, times in seconds. The player's `z` advances at `runSpeed` (0 in the boss arena).
- **Projection:** `render.js` owns `project(view, x, z) → {sx, sy, f}` — a pseudo-3D perspective
  (focal-length model) that produces the trapezoid road. All drawing goes through it;
  pixels-per-world-unit at any depth is `f * view.unitScale`.
- **Collisions:** circles in the x/z plane, all resolved in one place (`collisions.js`).
  Gates are crossing bands (trigger when the player's `z` passes the gate's `z` inside a slot).
- **Update order** (fixed, `main.js`): input → level director → player → projectiles → enemies →
  obstacles → pickups → gates → collisions → swap-remove cleanup → fx → HUD.
- **Content is data:** `ENEMY_TYPES` (+ named behavior functions), `UPGRADES` (apply-function
  table), `OBSTACLE_TYPES`, and a ~105-segment distance-keyed level `TIMELINE`.
- **Hard caps** (`config.js CAPS/LIMITS`) keep stacked upgrades and entity counts stable.

```
index.html  css/style.css        shell + DOM HUD/screens
sw.js  manifest.webmanifest      PWA: offline precache + installability
icons/                           generated app icons
js/main.js                       bootstrap, state machine, game loop, SW registration
js/config.js js/utils.js         tuning constants, helpers
js/input.js                      keyboard + pointer-drag input
js/render.js                     projection, camera, background/road, frame orchestration
js/player.js js/projectiles.js   player+squad, volleys, enemy shots
js/collisions.js                 ALL collision resolution
js/enemies.js                    9 enemy types, behaviors, 3-phase boss
js/upgrades.js                   18 level tracks, derived stats, boss DPS estimator
js/gates.js js/pickups.js        gate apparatus (charge/defuse), heal/gem/shield pickups
js/level.js js/obstacles.js      level director + timeline, 4 obstacle types
js/icons.js                      colored upgrade glyphs + level pips (canvas + DOM bakes)
js/bulletStyle.js                bespoke bullet visuals computed from your build
js/effects.js                    particles, arcs, shake, flashes, damage numbers, boss intro
js/ui.js js/audio.js             DOM HUD/screens, procedural SFX + generative music
```

## Enemies

| Type | Feel |
|---|---|
| **Grunt** | basic rusher with mild lane-homing |
| **Runner** | fast, fragile, pronounced zigzag |
| **Tank** | slow armored slab, huge contact damage, barely homes |
| **Shooter** | holds ~500–700 ahead, strafes, fires aimed shots after a visible wind-up |
| **Shield** | frontal plate absorbs your shots until it shatters (then it charges, staggered first) |
| **Splitter** | wobbly blob that bursts into 2–3 minis on death |
| **Mini** | tiny, quick, weak — swarms and splitter spawn |
| **Charger** | plants itself, telegraphs 0.7s, then dashes at your locked position — sidestep it |
| **Elite** (modifier) | any type: 2.5× HP, 1.3× size, gold aura, guaranteed heal drop |
| **IRONCLAD** (boss) | giant clockwork war engine, 3 phases: aimed volleys → sweeping barrages → enraged fans + telegraphed lane slams; summons capped adds that drop heals; brief shield at each phase flip. HP scales to your actual DPS so the fight lasts ~30s for any build. |

## Upgrades — 18 level tracks (LV1→LV5)

Every track scales five levels with rising power AND rising visuals:

**Offense:** Heavy Shot, Forced Draught (fire rate), Split Barrel (multishot), Gyro Shell
(homing), Lance (pierce — LV5 punches through shields), Boiler Bomb (explosive), **Tesla
Coil** (chain lightning), **Incendiary** (burn damage-over-time, LV4 spreads on death),
**Cryo-Vent** (slow, LV5 cancels charger dashes), Hair Trigger (crit chance *and*
multiplier), **Flywheels** (orbiting sawblades that shred enemy shots at LV3+),
**Broadside** (side/rear auto-guns up to an 8-way ring), **Death Burst** (enemies explode
into shrapnel).
**Defence:** Escort (mortal allied ships), Armour Plate (max HP + damage reduction; can go
NEGATIVE via trades), **Aegis Coil** (recharging shield charges, LV3+ shockwave),
**Condenser** (lifesteal on kills), Thrust (move speed).
**Instants:** Repair, Surplus. **Bad gates:** Rust (eats a level of your best track) and
Hull Breach (% HP hit) — both defusable by shooting. **Trades:** Scattergun, Glass Cannon,
Overpressure.

Gate rows offer choices from random pools — including `deepen` ("your best track") vs
`branch out` ("something new") dilemmas — so every run builds differently.

**Your bullets show your build:** projectile size, shape, hue, trails, fins, fuses, orbiting
glints and crackle are computed from the upgrade combination (a lance build fires finned
needles; a bomb build lobs fused orbs; crits are always gold). Cosmetic only — hitboxes
never change.

## Obstacles & pickups

Crates (loot piñatas) · wide barriers (shoot through or steer around, drop double loot) ·
spike strips (indestructible — steer!) · mines (shoot them: the blast hurts *enemies*, only
touching them hurts you; they chain). Pickups: heal cross, score gem, and a 3-second shield
token — while shielded you're a wrecking ball: ramming enemies kills them for full score.

## Testing performed

- Automated Playwright suite in real Chrome: start → steer (keys + drag) → full run → boss →
  victory → restart → defeat → restart → resize → mobile viewport → pause/resume,
  asserting **zero console errors** end-to-end.
- PWA suite: service-worker registration, complete precache, **offline reload + playthrough**,
  and a live update simulation (VERSION bump → new cache installed on launch → old cache
  deleted → auto-reload lands healthy on the title screen).
- Autopilot balance harness playing complete unassisted runs (greedy and cautious gate
  policies): victory at ~3:20–3:35 with real HP pressure; boss fight ~25–35s.
- Maxed-build stress test (6 shots × 9 shooters × 14 volleys/s ≈ 360 live projectiles + horde):
  locked 120 FPS on a laptop, entity counts bounded by design caps.
- Headless module-level simulations (level pacing sweep 0→46,000 units, mine chain reactions,
  slot-geometry overlap sweep, boss pattern gap sampling) plus an adversarial code review pass.

## Known limitations

- Single level / single character; difficulty is not selectable.
- No persistence (high scores reset on reload) and no meta-progression.
- Music is a simple generative loop; it starts after the first interaction (autoplay policy).
- `hpScale` rubber-bands enemy toughness with distance and boss HP scales with your DPS —
  deliberately arcade-fair rather than simulationist.
- Tested in Chromium and Firefox engines; Safari should work (webkit prefixes handled) but
  wasn't part of the automated matrix.
