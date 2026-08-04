// Obstacles: destructible cover + road hazards. LEVEL-AGENT OWNS THIS FILE.
// Damage/destruction is routed through damageObstacle() from collisions.js.
//
// Drawing follows the DESIGN.md scale convention: k = f * view.unitScale is the
// pixels-per-world-unit at the obstacle's depth, and EVERY shape is sized in
// world units * k. The draw origin is the obstacle's footprint on the road, so
// shapes are built upward (negative y) and appear to stand on the asphalt.
//
// Type geometry read (kept deliberately distinct at a glance):
//   crate   = wooden box with planks          -> shoot it, it drops loot
//   barrier = 3 concrete segments + chevrons  -> shoot through or steer around
//   spikes  = metal triangles on a base plate -> indestructible, steer around
//   mine    = disc + blinking red lamp        -> pops and blasts what's near it

import { DESPAWN_BEHIND } from './config.js';
import { chance, dist2 } from './utils.js';
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

function dropLoot(game, o) {
  if (!chance(o.def.dropChance)) return;
  if (o.type === 'barrier') {
    // Breaking a wall is the biggest investment -> pays out twice.
    spawnPickup(game, 'gem', o.x - 20, o.z);
    spawnPickup(game, chance(0.55) ? 'heal' : 'gem', o.x + 20, o.z);
  } else {
    spawnPickup(game, chance(0.5) ? 'heal' : 'gem', o.x, o.z);
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
function groundShadow(ctx, rx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, rx * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const DRAW = {
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
      // Hazard chevrons, clipped inside the block path we just built
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,196,61,0.8)';
      ctx.lineWidth = Math.max(1.5, sw * 0.15);
      ctx.beginPath();
      for (let s = -1; s <= 2; s++) {
        const bx = x0 + sw * (0.1 + s * 0.4);
        ctx.moveTo(bx, 0);
        ctx.lineTo(bx + sw * 0.36, -h);
      }
      ctx.stroke();
      ctx.restore();
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
    }
    // Bright top rail: the "wall" cue, visible from far away
    ctx.fillStyle = lit ? '#ffffff' : '#e8edf5';
    ctx.fillRect(-w / 2, -h - h * 0.1, w, h * 0.1);
    // HP read-out so "keep shooting, it is nearly down" is legible
    if (frac < 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(-w / 2, -h - h * 0.32, w, h * 0.12);
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(-w / 2, -h - h * 0.32, w * frac, h * 0.12);
    }
  },

  spikes(ctx, o, k) {
    const w = o.radius * 2 * k;
    const h = o.def.height * k;
    groundShadow(ctx, w * 0.55);
    // Bolted base plate (signals "welded to the road, not shootable")
    ctx.fillStyle = '#2c3245';
    ctx.fillRect(-w / 2, -h * 0.18, w, h * 0.18);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(-w / 2 + w * (0.12 + i * 0.25), -h * 0.14, w * 0.035, h * 0.07);
    }
    const N = 5;
    const bw = (w / N) * 0.88;
    for (let i = 0; i < N; i++) {
      const cx = -w / 2 + (w * (i + 0.5)) / N;
      // Two-tone faces = metal, not a flat triangle
      ctx.beginPath();
      ctx.moveTo(cx, -h);
      ctx.lineTo(cx - bw / 2, -h * 0.12);
      ctx.lineTo(cx, -h * 0.12);
      ctx.closePath();
      ctx.fillStyle = o.def.color;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, -h);
      ctx.lineTo(cx + bw / 2, -h * 0.12);
      ctx.lineTo(cx, -h * 0.12);
      ctx.closePath();
      ctx.fillStyle = '#5b6478';
      ctx.fill();
      // Tip glint
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(cx - bw * 0.06, -h, bw * 0.12, h * 0.14);
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
    // Prongs + antenna
    ctx.strokeStyle = '#5a6478';
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.beginPath();
    for (const s of [-1, 1]) {
      ctx.moveTo(s * r * 0.55, -r * 0.12);
      ctx.lineTo(s * r * 1.2, -r * 0.34);
    }
    ctx.moveTo(0, -r * 0.62); ctx.lineTo(0, -r * 1.15);
    ctx.stroke();
    // Squat disc lying on the asphalt
    ctx.fillStyle = o.flash > 0 ? '#ffffff' : o.def.color;
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.3, r, r * 0.44, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.42, r * 0.62, r * 0.24, 0, 0, Math.PI * 2);
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
