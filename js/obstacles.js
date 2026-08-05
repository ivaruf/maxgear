// Obstacles: destructible cover + road hazards. LEVEL-AGENT OWNS THIS FILE.
// Damage/destruction is routed through damageObstacle() from collisions.js.
//
// Drawing follows the DESIGN.md scale convention: k = f * view.unitScale is the
// pixels-per-world-unit at the obstacle's depth, and EVERY shape is sized in
// world units * k. The draw origin is the obstacle's footprint on the road, so
// shapes are built upward (negative y) and appear to stand on the asphalt.
//
// Type geometry read (kept deliberately distinct at a glance):
//   crate   = wooden crate, brass corner caps -> shoot it, it drops loot
//   barrier = 3 riveted iron plate segments   -> shoot through or steer around
//   spikes  = gear teeth on a riveted plate   -> indestructible, steer around
//   mine    = clockwork bomb + blinking lamp  -> pops and blasts what's near it
//
// v1.3 — crates are the run's LOOT CHANNEL. level.js moved most open-road
// pickups into crates, so a break now rolls the weighted CRATE_LOOT table (six
// pickup kinds), and a spawn can force the payout with instance overrides:
//   spawnObstacle(game, 'crate', x, z, { extra: { dropChance: 1, loot: 'heal' } })
// (spawnObstacle already spreads opts.extra onto the instance; dropLoot reads
//  o.dropChance ?? o.def.dropChance and o.loot.)

import { DESPAWN_BEHIND } from './config.js';
import { chance, rand, dist2 } from './utils.js';
import { project } from './render.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { spawnPickup } from './pickups.js';
import { damagePlayer } from './player.js';
import { killEnemy } from './enemies.js';

// ---- named tuning -----------------------------------------------------------
export const MINE_BLAST_RADIUS = 120;   // world units, enemies/obstacles only
export const MINE_BLAST_DAMAGE = 40;    // per enemy inside the radius
export const MINE_CONTACT_DAMAGE = 22;  // player only, on touch

export const OBSTACLE_TYPES = {
  crate: {
    hp: 30, radius: 24, height: 46, contactDamage: 12, score: 5,
    color: '#a07b4f', destructible: true, dropChance: 0.35,
  },
  barrier: {
    // Wide destructible wall: 110 units across = ~27% of the road per segment.
    hp: 80, radius: 55, height: 54, contactDamage: 20, score: 20,
    color: '#9aa2b1', destructible: true, dropChance: 0.75,
  },
  spikes: {
    hp: Infinity, radius: 26, height: 30, contactDamage: 18, score: 0,
    color: '#8a93a8', destructible: false, dropChance: 0,
  },
  mine: {
    // Dies to a single base-damage shot; the blast is the point, not the HP.
    hp: 10, radius: 18, height: 18, contactDamage: MINE_CONTACT_DAMAGE, score: 10,
    color: '#3d4459', destructible: true, dropChance: 0.1,
    blast: { radius: MINE_BLAST_RADIUS, damage: MINE_BLAST_DAMAGE, color: '#ffb347' },
  },
};

export function spawnObstacle(game, typeKey, x, z, opts = {}) {
  const t = OBSTACLE_TYPES[typeKey];
  if (!t) { console.error(`Unknown obstacle type: ${typeKey}`); return null; }
  const hp = t.hp * (opts.hpScale ?? 1);
  const o = {
    type: typeKey, def: t,
    x, z,
    hp, maxHp: hp,
    radius: t.radius,
    contactDamage: t.contactDamage,
    destructible: t.destructible,
    flash: 0, age: 0,
    dead: false,
    ...opts.extra,
  };
  game.obstacles.push(o);
  return o;
}

export function updateObstacles(game, dt) {
  for (const o of game.obstacles) {
    o.age += dt;
    o.flash = Math.max(0, o.flash - dt);
    if (o.z < game.player.z - DESPAWN_BEHIND) o.dead = true;
  }
}

// ---- mines ------------------------------------------------------------------
// A mine blast is hostile to ENEMIES and other OBSTACLES only. The player is
// only ever hurt by touching a mine (contactDamage), so shooting a mine is
// always the correct, rewarding play. Chains through other mines (each is
// already flagged dead before it blasts, so recursion terminates).
function mineBlast(game, o) {
  const b = o.def.blast;
  fx.explosion(o.x, o.z, b.radius * 0.7, b.color);
  fx.shake(4, 0.18);
  audio.explode();
  const r2 = b.radius * b.radius;
  const n = game.enemies.length; // snapshot: killEnemy can push split minis mid-loop
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (e.dead) continue;
    if (dist2(e.x, e.z, o.x, o.z) > r2) continue;
    e.hp -= b.damage;
    e.flash = 0.07;
    fx.textPop(e.x, e.z, `${b.damage}`, b.color);
    if (e.hp <= 0) killEnemy(game, e, 'explosion');
  }
  for (const other of game.obstacles) {
    if (other === o || other.dead || !other.destructible) continue;
    if (dist2(other.x, other.z, o.x, o.z) <= r2) damageObstacle(game, other, b.damage);
  }
}

// ---- crate loot -------------------------------------------------------------
// The weighted payout table for a broken crate (and barrier). Weights sum to 1
// but do not have to: rollCrateLoot() normalises, so the lead can retune any
// single line without touching the others. The three v1.3 kinds are deliberately
// rare — finding an OVERDRIVE / STEAMBURST / GEARBOX should read as a jackpot.
export const CRATE_LOOT = {
  heal: 0.28,
  gem: 0.30,
  shieldToken: 0.12,
  overdrive: 0.13,
  steamburst: 0.09,
  gearbox: 0.08,
};

// Weighted pick. The total is summed per roll (6 adds, only on a crate break —
// never in a per-frame loop) so a live-edited table can never go stale.
export function rollCrateLoot() {
  const kinds = Object.keys(CRATE_LOOT);
  let total = 0;
  for (const k of kinds) total += CRATE_LOOT[k];
  let r = rand(0, total);
  for (const k of kinds) {
    r -= CRATE_LOOT[k];
    if (r <= 0) return k;
  }
  return kinds[kinds.length - 1] || 'gem';
}

// What THIS obstacle pays out:
//   o.loot        forced kind (level.js guaranteed-loot crates) — skips the table
//   mines         keep the old heal/gem coin flip: a minefield spitting
//                 jackpot pickups would reward walking into it
//   crate/barrier roll CRATE_LOOT
function lootKind(o) {
  if (o.loot) return o.loot;
  if (o.type === 'mine') return chance(0.5) ? 'heal' : 'gem';
  return rollCrateLoot();
}

function dropLoot(game, o) {
  if (!chance(o.dropChance ?? o.def.dropChance)) return;
  if (o.type === 'barrier') {
    // Breaking a wall is the biggest investment -> pays out twice (same table).
    spawnPickup(game, lootKind(o), o.x - 20, o.z);
    spawnPickup(game, lootKind(o), o.x + 20, o.z);
  } else {
    spawnPickup(game, lootKind(o), o.x, o.z);
  }
}

// Projectile (or explosion) damaged an obstacle
export function damageObstacle(game, o, amount) {
  if (!o.destructible || o.dead) return;
  o.hp -= amount;
  o.flash = 0.08;
  if (o.hp > 0) return;
  o.dead = true;
  game.score += o.def.score;
  fx.explosion(o.x, o.z, o.radius, o.def.color);
  audio.hit();
  if (o.def.blast) mineBlast(game, o);
  dropLoot(game, o);
}

// Player ran into an obstacle
export function obstacleContact(game, o) {
  damagePlayer(game, o.contactDamage);
  if (!o.destructible) return;             // spikes stay in the road
  o.dead = true;
  fx.explosion(o.x, o.z, o.radius, o.def.color);
  if (o.def.blast) mineBlast(game, o);     // touched mine still clears the area
}

// ---- drawing ----------------------------------------------------------------
// STEAMPUNK materials (draw-only). Silhouettes, footprints and every telegraph
// (HP bar, cracks, tip glints, blast ring) are unchanged — only the surfaces
// became wood-and-brass / riveted iron / clockwork.
const TAU = Math.PI * 2;
const BRASS = '#c9973b';
const BRASS_HI = '#f0b429';
const BRASS_LO = '#6f5220';
const IRON_DK = '#241e18';

// Cog silhouette baked ONCE at unit radius, scaled at draw time (no per-frame
// path building). Path2D is guarded so the module still imports without a DOM.
function cogPath(teeth, rTip, rRoot, rHole) {
  const p = new Path2D();
  const step = TAU / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const a0 = a - step * 0.32, a1 = a - step * 0.15;
    const a2 = a + step * 0.15, a3 = a + step * 0.32;
    p[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a0) * rRoot, Math.sin(a0) * rRoot);
    p.lineTo(Math.cos(a1) * rTip, Math.sin(a1) * rTip);
    p.lineTo(Math.cos(a2) * rTip, Math.sin(a2) * rTip);
    p.lineTo(Math.cos(a3) * rRoot, Math.sin(a3) * rRoot);
  }
  p.closePath();
  if (rHole > 0) {              // reverse-wound subpath = hub hole
    p.moveTo(rHole, 0);
    p.arc(0, 0, rHole, 0, TAU, true);
    p.closePath();
  }
  return p;
}
const COG = typeof Path2D !== 'undefined' ? cogPath(8, 1, 0.7, 0.28) : null;

// Gear ornament, rotation driven by obstacle age (never Date.now()).
function drawCog(ctx, x, y, r, rot, fill) {
  if (r < 1.2) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(r, r);
  ctx.fillStyle = fill;
  if (COG) ctx.fill(COG);
  else { ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill(); }
  ctx.restore();
}

// Domed brass rivet.
function rivet(ctx, x, y, r) {
  if (r < 0.85) return;   // sub-pixel at distance: not worth the two arcs
  ctx.fillStyle = 'rgba(40,28,10,0.8)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = BRASS_HI;
  ctx.beginPath();
  ctx.arc(x - r * 0.2, y - r * 0.24, r * 0.52, 0, TAU);
  ctx.fill();
}

// Evenly spaced rivet run along a horizontal edge (count bounded for perf).
function rivetRow(ctx, x0, x1, y, r, n) {
  if (r < 0.85) return;
  const span = x1 - x0;
  for (let i = 0; i < n; i++) rivet(ctx, x0 + (span * (i + 0.5)) / n, y, r);
}

function groundShadow(ctx, rx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, rx * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const DRAW = {
  // Steamer crate: same wooden box (same hexes), now strapped in brass.
  crate(ctx, o, k) {
    const w = o.radius * 2 * k;
    const h = o.def.height * k;
    const lit = o.flash > 0;
    groundShadow(ctx, w * 0.55);
    // Body + lighter top band so it reads as a box, not a sticker
    ctx.fillStyle = lit ? '#fff4dd' : o.def.color;
    ctx.fillRect(-w / 2, -h, w, h);
    ctx.fillStyle = lit ? '#ffffff' : '#c2905c';
    ctx.fillRect(-w / 2, -h, w, h * 0.18);
    // Plank seams + diagonal brace
    ctx.strokeStyle = 'rgba(0,0,0,0.32)';
    ctx.lineWidth = Math.max(1, w * 0.045);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h * 0.62); ctx.lineTo(w / 2, -h * 0.62);
    ctx.moveTo(-w / 2, -h * 0.3); ctx.lineTo(w / 2, -h * 0.3);
    ctx.moveTo(-w / 2, -h * 0.06); ctx.lineTo(w / 2, -h * 0.88);
    ctx.stroke();
    // Brass shipping band across the middle
    ctx.fillStyle = lit ? '#ffffff' : BRASS_LO;
    ctx.fillRect(-w / 2, -h * 0.52, w, h * 0.11);
    ctx.fillStyle = lit ? '#ffffff' : BRASS;
    ctx.fillRect(-w / 2, -h * 0.52, w, h * 0.06);
    // Brass corner caps (L plates) + rivets
    const cs = Math.min(w, h) * 0.26;
    const ct = Math.max(1, cs * 0.32);
    ctx.fillStyle = lit ? '#ffffff' : BRASS;
    for (let i = 0; i < 4; i++) {
      const left = i % 2 === 0;
      const topRow = i < 2;
      ctx.fillRect(left ? -w / 2 : w / 2 - cs, topRow ? -h : -ct, cs, ct);
      ctx.fillRect(left ? -w / 2 : w / 2 - ct, topRow ? -h : -cs, ct, cs);
    }
    if (!lit) {
      const rv = ct * 0.4;
      for (let i = 0; i < 4; i++) {
        const left = i % 2 === 0;
        const topRow = i < 2;
        rivet(ctx, left ? -w / 2 + ct * 0.9 : w / 2 - ct * 0.9,
          topRow ? -h + ct * 0.9 : -ct * 0.9, rv);
      }
      rivet(ctx, 0, -h * 0.465, h * 0.035);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = Math.max(1, w * 0.05);
    ctx.strokeRect(-w / 2, -h, w, h);
  },

  barrier(ctx, o, k) {
    const w = o.radius * 2 * k;
    const h = o.def.height * k;
    const lit = o.flash > 0;
    const frac = Math.max(0, o.hp / o.maxHp);
    groundShadow(ctx, w * 0.52);
    const SEGS = 3;
    const gap = w * 0.025;
    const sw = (w - gap * (SEGS - 1)) / SEGS;
    for (let i = 0; i < SEGS; i++) {
      const x0 = -w / 2 + i * (sw + gap);
      // Slightly tapered concrete block (jersey-barrier silhouette)
      ctx.beginPath();
      ctx.moveTo(x0 + sw * 0.1, -h);
      ctx.lineTo(x0 + sw * 0.9, -h);
      ctx.lineTo(x0 + sw, 0);
      ctx.lineTo(x0, 0);
      ctx.closePath();
      ctx.fillStyle = lit ? '#ffffff' : (i === 1 ? '#8b93a3' : o.def.color);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(1, w * 0.018);
      ctx.stroke();
      // Everything below is clipped inside the block path we just built
      ctx.save();
      ctx.clip();
      // Riveted iron plate: shaded lower body, bright top edge, rivet rows
      ctx.fillStyle = 'rgba(16,20,26,0.28)';
      ctx.fillRect(x0, -h * 0.42, sw, h * 0.42);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x0, -h, sw, Math.max(1, h * 0.05));
      // Brass hazard plate bolted across the segment (was painted chevrons —
      // same gold-on-dark diagonal read, now a plate)
      const pY = -h * 0.78, pH = h * 0.56;
      ctx.fillStyle = lit ? '#ffffff' : 'rgba(201,151,59,0.92)';
      ctx.fillRect(x0, pY, sw, pH);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, pY, sw, pH);
      ctx.clip();
      ctx.strokeStyle = 'rgba(26,21,18,0.82)';
      ctx.lineWidth = Math.max(1.5, sw * 0.15);
      ctx.beginPath();
      for (let s = -1; s <= 2; s++) {
        const bx = x0 + sw * (0.1 + s * 0.4);
        ctx.moveTo(bx, pY + pH);
        ctx.lineTo(bx + pH * 0.66, pY);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(26,21,18,0.5)';
      ctx.lineWidth = Math.max(1, w * 0.012);
      ctx.strokeRect(x0, pY, sw, pH);
      const rv = sw * 0.045;
      rivetRow(ctx, x0, x0 + sw, pY + rv * 1.8, rv, 3);
      rivetRow(ctx, x0, x0 + sw, pY + pH - rv * 1.8, rv, 3);
      // Cracks appear as the wall gives way
      if (frac < 0.6) {
        ctx.strokeStyle = 'rgba(10,12,20,0.75)';
        ctx.lineWidth = Math.max(1, w * 0.014);
        ctx.beginPath();
        ctx.moveTo(x0 + sw * 0.5, 0);
        ctx.lineTo(x0 + sw * 0.36, -h * 0.45);
        ctx.lineTo(x0 + sw * 0.6, -h * 0.72);
        ctx.lineTo(x0 + sw * 0.44, -h);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Bright top rail: the "wall" cue, visible from far away (brass-capped)
    ctx.fillStyle = lit ? '#ffffff' : '#eadfc6';
    ctx.fillRect(-w / 2, -h - h * 0.1, w, h * 0.1);
    ctx.fillStyle = lit ? '#ffffff' : BRASS_LO;
    ctx.fillRect(-w / 2, -h - h * 0.02, w, h * 0.02);
    // HP read-out so "keep shooting, it is nearly down" is legible
    if (frac < 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(-w / 2, -h - h * 0.32, w, h * 0.12);
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(-w / 2, -h - h * 0.32, w * frac, h * 0.12);
    }
  },

  // Upturned GEAR TEETH on a riveted base plate: same 5-tooth strip, same
  // height envelope, same tip glints — still "do not touch".
  spikes(ctx, o, k) {
    const w = o.radius * 2 * k;
    const h = o.def.height * k;
    groundShadow(ctx, w * 0.55);
    // Half-buried cog rim the teeth belong to
    ctx.fillStyle = IRON_DK;
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.5, h * 0.62, 0, Math.PI, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(201,151,59,0.45)';
    ctx.lineWidth = Math.max(1, h * 0.05);
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.5, h * 0.62, 0, Math.PI, TAU);
    ctx.stroke();
    // Bolted base plate (signals "welded to the road, not shootable")
    ctx.fillStyle = '#2a241d';
    ctx.fillRect(-w / 2, -h * 0.18, w, h * 0.18);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(-w / 2, -h * 0.18, w, Math.max(1, h * 0.03));
    const N = 5;
    const bw = (w / N) * 0.88;
    for (let i = 0; i < N; i++) {
      const cx = -w / 2 + (w * (i + 0.5)) / N;
      const tw = bw * 0.19;          // flat gear-tooth tip
      const yb = -h * 0.12;
      // Two-tone flanks = machined metal, not a flat triangle
      ctx.beginPath();
      ctx.moveTo(cx - tw, -h);
      ctx.quadraticCurveTo(cx - bw * 0.42, -h * 0.55, cx - bw / 2, yb);
      ctx.lineTo(cx, yb);
      ctx.lineTo(cx, -h);
      ctx.closePath();
      ctx.fillStyle = o.def.color;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + tw, -h);
      ctx.quadraticCurveTo(cx + bw * 0.42, -h * 0.55, cx + bw / 2, yb);
      ctx.lineTo(cx, yb);
      ctx.lineTo(cx, -h);
      ctx.closePath();
      ctx.fillStyle = '#5b6478';
      ctx.fill();
      // Tip glint
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(cx - bw * 0.06, -h, bw * 0.12, h * 0.14);
    }
    // Rivets on the front face of the plate, below the tooth roots
    for (let i = 0; i < 4; i++) {
      rivet(ctx, -w / 2 + w * (0.14 + i * 0.25), -h * 0.06, w * 0.022);
    }
  },

  mine(ctx, o, k) {
    const r = o.radius * k;
    const blast = o.def.blast.radius * k;
    const blink = (o.age * 3) % 1 < 0.5;
    // Blast telegraph, painted flat on the road
    ctx.save();
    ctx.globalAlpha = blink ? 0.18 : 0.07;
    ctx.strokeStyle = '#ff5964';
    ctx.lineWidth = Math.max(1, r * 0.14);
    ctx.setLineDash([r * 0.55, r * 0.55]);
    ctx.beginPath();
    ctx.ellipse(0, 0, blast, blast * 0.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    groundShadow(ctx, r * 1.05);
    // Brass prongs/pistons + antenna
    ctx.strokeStyle = BRASS_LO;
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.beginPath();
    for (const s of [-1, 1]) {
      ctx.moveTo(s * r * 0.55, -r * 0.12);
      ctx.lineTo(s * r * 1.2, -r * 0.34);
    }
    ctx.moveTo(0, -r * 0.62); ctx.lineTo(0, -r * 1.15);
    ctx.stroke();
    ctx.fillStyle = BRASS;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * r * 1.2, -r * 0.34, Math.max(0.8, r * 0.13), 0, TAU);
      ctx.fill();
    }
    // Squat disc lying on the asphalt
    ctx.fillStyle = o.flash > 0 ? '#ffffff' : o.def.color;
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.3, r, r * 0.44, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.stroke();
    // Brass equator band + rim rivets: a riveted clockwork casing
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = Math.max(1, r * 0.09);
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.3, r * 0.84, r * 0.36, 0, 0, Math.PI * 2);
    ctx.stroke();
    const mrv = r * 0.09;
    if (mrv >= 0.85) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + 0.3;
        rivet(ctx, Math.cos(a) * r * 0.92, -r * 0.3 + Math.sin(a) * r * 0.4, mrv);
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.42, r * 0.62, r * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    // Clockwork: escapement cog + a wind-up key turning on top (from o.age)
    drawCog(ctx, r * 0.44, -r * 0.5, r * 0.28, o.age * 0.9, BRASS);
    const kx = -r * 0.48, ky = -r * 0.74;
    const rot = o.age * 1.2;
    const wl = r * 0.3;
    const kc = Math.cos(rot), ks = Math.sin(rot) * 0.42;
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(kx, ky + r * 0.18);
    ctx.lineTo(kx, ky);
    ctx.moveTo(kx - kc * wl, ky - ks * wl);
    ctx.lineTo(kx + kc * wl, ky + ks * wl);
    ctx.stroke();
    ctx.fillStyle = BRASS_HI;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(kx + s * kc * wl, ky + s * ks * wl, Math.max(0.8, r * 0.11), 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = BRASS_LO;
    ctx.beginPath();
    ctx.arc(kx, ky, Math.max(0.8, r * 0.07), 0, TAU);
    ctx.fill();
    // Blinking red lamp
    if (blink) { ctx.shadowColor = '#ff2b3d'; ctx.shadowBlur = r * 1.4; }
    ctx.fillStyle = blink ? '#ff5964' : '#7a2630';
    ctx.beginPath();
    ctx.arc(0, -r * 1.2, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  },
};

export function drawObstacles(ctx, view, game) {
  const sorted = [...game.obstacles].sort((a, b) => b.z - a.z);
  for (const o of sorted) {
    if (o.dead) continue;
    const { sx, sy, f } = project(view, o.x, o.z);
    const k = f * view.unitScale;   // pixels per world unit at this depth
    if (k <= 0.002) continue;
    ctx.save();
    ctx.translate(sx, sy);          // origin = footprint on the road
    (DRAW[o.type] || DRAW.crate)(ctx, o, k);
    ctx.restore();
  }
}
