// ALL collision resolution. LEAD-OWNED.
// Circle vs circle in the x/z plane; gates are crossing bands.
//
// v1.2 rework: this file is where a bullet's stamped riders become world
// effects. It READS projectile fields (never player.stats, except for the saws)
// and WRITES enemy status fields that enemies.js ticks down:
//   e.burnDps / e.burnT          incendiary   (refresh by max, never stacks)
//   e.chillSlow / e.chillT       cryo         (enemies.js derives e.chillMul,
//                                              boss floor lives there)
//   e.stagger                    shared stun channel (blast/arc/saw LV5 riders)
// Per-step budgets (arcs, and shards over in projectiles.js) keep a maxed build
// from turning one volley into a chain reaction.

import { circleHit, dist2 } from './utils.js';
import { killEnemy, enemyContact, interceptShot } from './enemies.js';
import { damageObstacle, obstacleContact } from './obstacles.js';
import { gateOnShot, applyGateSlot } from './gates.js';
import { collectPickup } from './pickups.js';
import { damagePlayer, damageAlly } from './player.js';
import { fx } from './effects.js';
import { audio } from './audio.js';

const ARC_BUDGET = 6;              // tesla arcs per resolve step (design §C S3)
const SAW_CD = 0.35;               // s per blade between bites
const SAW_COLOR = '#f0b429';       // bright brass: flywheels are machinery
const BLAST_LV5_R = 190;           // blastR at LV5 (195) trips the stagger rider
const ARC_LV5_JUMPS = 6;           // chainJumps at LV5
const SAW_LV5_COUNT = 6;           // sawCount at LV5
const NO_SAWS = Object.freeze([]);

let arcBudget = ARC_BUDGET;
const zapped = [];                 // reused chain-target scratch (no per-hit alloc)

// ---- status + arc ----------------------------------------------------------

// Burn refreshes by MAX and never stacks; chill takes the strongest slow seen.
// enemies.js owns the countdowns, the ember/rime tint and the boss slow floor.
function applyStatus(game, e, p) {
  if (p.burnDps) {
    e.burnDps = Math.max(e.burnDps || 0, p.burnDps);
    e.burnT = p.burnTime;
  }
  if (p.frostSlow) {
    e.chillSlow = Math.max(e.chillSlow || 0, p.frostSlow);
    e.chillT = p.frostTime;
    // (the rime puff is enemies.js's, thrown on its own throttle while chilled)
    // CRYO LV5: a committed charger dash is cancelled outright (state 2 -> 3)
    if (p.frostHard && e.behavior === 'charger' && e.state === 2) {
      e.state = 3;
      e.stateT = 0;
    }
  }
}

// TESLA COIL. ONE generation per projectile (p.chained), ARC_BUDGET arcs per
// step: candidates are the nearest other living enemies within chainRange of the
// enemy that was actually hit, but the bolt is drawn hop-to-hop so the arc reads
// as a single travelling discharge.
function chainFrom(game, e, p) {
  const jumps = Math.round(p.chainJumps);
  const range2 = p.chainRange * p.chainRange;
  const damage = p.damage * p.chainFrac;
  const color = (p.style && p.style.glow) || '#8fd6ff';
  const width = 2 + jumps * 0.4;
  // snapshot: killEnemy can push split minis, which must not become hops
  const n = game.enemies.length;
  zapped.length = 0;
  let fromX = e.x, fromZ = e.z;

  for (let j = 0; j < jumps; j++) {
    let best = null, bestD = range2;
    for (let i = 0; i < n; i++) {
      const t = game.enemies[i];
      if (t.dead || t === e) continue;
      if (zapped.indexOf(t) >= 0) continue;
      const d = dist2(t.x, t.z, e.x, e.z);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (!best) break;
    zapped.push(best);
    fx.arc(fromX, fromZ, best.x, best.z, color, width);
    fromX = best.x; fromZ = best.z;
    best.hp -= damage;
    best.flash = 0.07;
    if (jumps >= ARC_LV5_JUMPS) best.stagger = Math.max(best.stagger || 0, 0.12);
    if (best.hp <= 0) killEnemy(game, best, 'chain');
  }
  zapped.length = 0;
}

function hitEnemy(game, e, p) {
  // enemies.js may absorb/deflect the shot (e.g. shielded enemies)
  if (interceptShot(game, e, p)) return;
  e.hp -= p.damage;
  e.flash = 0.07;
  fx.hitSpark(p.x, p.z, p.crit ? '#ffd166' : ((p.style && p.style.spark) || '#9df3ff'));
  fx.textPop(e.x, e.z, `${Math.round(p.damage)}`, p.crit ? '#ffd166' : '#ffffff');
  audio.hit();
  applyStatus(game, e, p);
  if (p.chainJumps && !p.chained && arcBudget > 0) {
    p.chained = true;
    arcBudget--;
    chainFrom(game, e, p);
  }
  // 'shrapnel' tells killEnemy not to spawn a second shard generation
  if (e.hp <= 0) killEnemy(game, e, p.shard ? 'shrapnel' : 'shot');
}

// BOILER BOMB. Radius and splash are stamped on the shot (blastR / blastFrac),
// so a gate crossed mid-flight never retro-buffs a bomb already in the air.
function explode(game, p) {
  const radius = p.blastR;
  const splash = p.damage * p.blastFrac;
  fx.explosion(p.x, p.z, radius, '#ff8a5a');
  audio.explode();
  const r2 = (radius + 20) * (radius + 20);
  const shock = radius >= BLAST_LV5_R;      // LV5 rider: survivors reel
  // index loop over a snapshot length: killEnemy() can push split minis into
  // the array mid-loop, and iterating them here would loop forever if a split
  // child ever splits again
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (e.dead) continue;
    if (dist2(e.x, e.z, p.x, p.z) < r2) {
      // splash hits shields first so shielded enemies keep their identity vs explosive builds
      if (e.shieldHp > 0) {
        e.shieldHp -= splash;
        e.shieldFlash = 0.1;
        continue;
      }
      e.hp -= splash;
      e.flash = 0.07;
      if (e.hp <= 0) killEnemy(game, e, 'explosion');
      else if (shock) e.stagger = Math.max(e.stagger || 0, 0.2);
    }
  }
  for (const o of game.obstacles) {
    if (!o.dead && dist2(o.x, o.z, p.x, p.z) < r2) damageObstacle(game, o, splash);
  }
}

// FLYWHEELS (design §C S5). Brass discs orbit the hull: melee only, invulnerable,
// per-blade cooldown, and from LV3 they shred enemy fire. player.js owns their
// positions and cd countdown; this is the only place they deal damage.
function resolveSaws(game) {
  const player = game.player;
  const saws = player.saws || NO_SAWS;
  if (!saws.length) return;
  const stats = player.stats;
  const dmg = stats.sawDmg || 0;
  const count = stats.sawCount || 0;

  if (dmg > 0) {
    const n = game.enemies.length;         // snapshot: kills may push split minis
    for (let s = 0; s < saws.length; s++) {
      const saw = saws[s];
      if (saw.cd > 0) continue;
      for (let i = 0; i < n; i++) {
        const e = game.enemies[i];
        if (e.dead || !circleHit(saw, e)) continue;
        e.hp -= dmg;
        e.flash = 0.07;
        saw.cd = SAW_CD;
        fx.hitSpark(saw.x, saw.z, SAW_COLOR);
        if (count >= SAW_LV5_COUNT) e.stagger = Math.max(e.stagger || 0, 0.1);
        if (e.hp <= 0) killEnemy(game, e, 'saw');
        break;                             // the bite is spent on one enemy
      }
    }
  }

  // LV3+: the blades also delete incoming shots (no cooldown — that IS the perk)
  if (count >= 3) {
    for (const shot of game.enemyShots) {
      if (shot.dead) continue;
      for (let s = 0; s < saws.length; s++) {
        if (!circleHit(saws[s], shot)) continue;
        shot.dead = true;
        fx.hitSpark(shot.x, shot.z, SAW_COLOR);
        break;
      }
    }
  }
}

export function resolveCollisions(game, dt) {
  const player = game.player;
  arcBudget = ARC_BUDGET;

  // ---- player projectiles vs enemies / obstacles / chargeable gates --------
  for (const p of game.projectiles) {
    if (p.dead) continue;

    const nE = game.enemies.length; // snapshot: kills may push split minis
    for (let i = 0; i < nE; i++) {
      const e = game.enemies[i];
      if (e.dead) continue;
      if (!circleHit(p, e)) continue;
      if (p.hits && p.hits.has(e)) continue;
      hitEnemy(game, e, p);
      // the blast detonates but no longer consumes the projectile outright:
      // LANCE still applies, so the two upgrades stack as advertised
      if (p.blastR > 0) explode(game, p);
      if (p.lance > 0) {
        p.lance--;
        (p.hits ??= new Set()).add(e);
      } else {
        p.dead = true;
      }
      break;
    }
    if (p.dead) continue;

    for (const o of game.obstacles) {
      if (o.dead || !o.destructible) continue;
      if (circleHit(p, o)) {
        damageObstacle(game, o, p.damage);
        if (p.blastR > 0) explode(game, p);
        p.dead = true;
        break;
      }
    }
    if (p.dead) continue;

    // Chargeable gate slots: projectile crosses the gate line inside a slot.
    // gates.js refreshes s.chargeable every frame (bad slots are chargeable
    // too — shooting them counts DOWN toward DEFUSED), so this stays one flag.
    for (const g of game.gates) {
      if (g.used) continue;
      const prevZ = p.z - p.vz * dt;
      if (prevZ < g.z && p.z >= g.z) {
        for (const s of g.slots) {
          if (s.chargeable && Math.abs(p.x - s.x) < s.halfW) {
            gateOnShot(game, g, s);
            fx.hitSpark(p.x, g.z, '#ffd166');
            p.dead = true;
            break;
          }
        }
      }
      if (p.dead) break;
    }
  }

  // ---- orbiting saws vs enemies / enemy shots --------------------------------
  // Before the shot pass on purpose: a shredded shot must not also hit the ship.
  resolveSaws(game);

  // ---- enemy shots vs player and allies --------------------------------------
  // Orbiting allies soak shots that pass through their circle: squad is armor.
  for (const s of game.enemyShots) {
    if (s.dead) continue;
    if (circleHit(s, player)) {
      s.dead = true;
      damagePlayer(game, s.damage);
      continue;
    }
    for (const a of player.allies) {
      if (a.dead) continue;
      if (circleHit(s, a)) {
        s.dead = true;
        damageAlly(game, a, s.damage);
        break;
      }
    }
  }

  // ---- enemies vs player and allies ------------------------------------------
  for (const e of game.enemies) {
    if (e.dead) continue;
    if (circleHit(e, player)) { enemyContact(game, e); continue; }
    for (const a of player.allies) {
      if (a.dead) continue;
      if (circleHit(e, a)) {
        damageAlly(game, a, e.damage);
        if (!e.isBoss) {
          e.dead = true;
          fx.explosion(e.x, e.z, e.radius, e.color);
        }
        break;
      }
    }
  }

  // ---- obstacles vs player --------------------------------------------------
  for (const o of game.obstacles) {
    if (o.dead) continue;
    if (circleHit(o, player)) obstacleContact(game, o);
  }

  // ---- pickups vs player ----------------------------------------------------
  for (const pk of game.pickups) {
    if (!pk.dead && circleHit(pk, player)) collectPickup(game, pk);
  }

  // ---- gates vs player (crossing band) --------------------------------------
  for (const g of game.gates) {
    if (g.used || g.dead) continue;
    if (player.prevZ < g.z && player.z >= g.z) {
      for (const s of g.slots) {
        if (Math.abs(player.x - s.x) < s.halfW + player.radius * 0.5) {
          applyGateSlot(game, g, s);
          break;
        }
      }
    }
  }
}
