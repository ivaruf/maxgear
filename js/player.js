// Player + allied squad: movement, auto-fire, damage intake.
// Upgrades mutate player.stats ONLY (see DESIGN.md); clampStats() keeps caps.

import { ROAD_HALF, PLAYER_DEFAULTS, BASE_STATS, CAPS, BASE_RUN_SPEED, CAM_BACK, FOCAL } from './config.js';
import { clamp } from './utils.js';
import { fireVolley } from './projectiles.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { project } from './render.js';

export function createPlayer() {
  return {
    x: 0,
    z: 0,
    prevZ: 0,
    radius: PLAYER_DEFAULTS.radius,
    hp: PLAYER_DEFAULTS.maxHp,
    maxHp: PLAYER_DEFAULTS.maxHp,
    stats: { ...BASE_STATS },
    fireTimer: 0,
    invuln: 0,
    hurtFlash: 0,
    dead: false,
  };
}

export function clampStats(stats) {
  stats.squad = clamp(Math.round(stats.squad), 0, CAPS.squad);
  stats.projectiles = clamp(Math.round(stats.projectiles), 1, CAPS.projectiles);
  stats.fireInterval = Math.max(stats.fireInterval, CAPS.fireIntervalMin);
  stats.pierce = clamp(Math.round(stats.pierce), 0, CAPS.pierce);
  stats.ricochet = clamp(Math.round(stats.ricochet), 0, CAPS.ricochet);
  stats.critChance = clamp(stats.critChance, 0, CAPS.critChance);
  stats.moveSpeed = clamp(stats.moveSpeed, 160, CAPS.moveSpeed);
  stats.damage = clamp(stats.damage, 1, CAPS.damage);
}

// Squad members fan out in a wedge behind the player.
export function squadOffsets(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const rank = Math.floor(i / 2) + 1;
    out.push({ dx: side * rank * 34, dz: -rank * 26 });
  }
  return out;
}

export function updatePlayer(game, dt, input) {
  const p = game.player;
  p.prevZ = p.z;
  p.z += game.runSpeed * dt;

  // Keyboard steering
  let vx = input.axis() * p.stats.moveSpeed;
  p.x += vx * dt;
  // Pointer drag: CSS px -> world units at player depth
  const dragPx = input.takeDrag();
  if (dragPx !== 0) {
    const fPlayer = FOCAL / (FOCAL + CAM_BACK);
    p.x += dragPx / (game.view.unitScale * fPlayer);
  }
  p.x = clamp(p.x, -ROAD_HALF + p.radius, ROAD_HALF - p.radius);

  // Auto-fire: player + each squad member fires the full volley
  p.fireTimer -= dt;
  if (p.fireTimer <= 0) {
    p.fireTimer = p.stats.fireInterval;
    fireVolley(game, p.x, p.z + 20, p.stats);
    for (const o of squadOffsets(p.stats.squad)) {
      fireVolley(game, clamp(p.x + o.dx, -ROAD_HALF, ROAD_HALF), p.z + 20 + o.dz, p.stats);
    }
    audio.shoot();
  }

  p.invuln = Math.max(0, p.invuln - dt);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt);
}

export function damagePlayer(game, amount, ignoreInvuln = false) {
  const p = game.player;
  if (p.dead || game.state !== 'playing') return;
  if (p.invuln > 0 && !ignoreInvuln) return;
  p.hp -= amount;
  // never shorten an active shield-token window (ignoreInvuln hits would otherwise reset it)
  p.invuln = Math.max(p.invuln, PLAYER_DEFAULTS.invulnTime);
  p.hurtFlash = 0.25;
  fx.shake(6, 0.25);
  fx.flash('#ff2233', 0.22, 0.25);
  audio.hurt();
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    fx.explosion(p.x, p.z, 90, '#35e0ff');
    audio.explode();
  }
}

export function healPlayer(game, amount) {
  const p = game.player;
  p.hp = Math.min(p.maxHp, p.hp + amount);
  fx.textPop(p.x, p.z + 30, `+${Math.round(amount)}`, '#3ddc84');
}

function drawShip(ctx, sx, sy, s, color, glow) {
  ctx.save();
  ctx.translate(sx, sy);
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  // Hull: arrow-like wedge
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -18 * s);
  ctx.lineTo(13 * s, 10 * s);
  ctx.lineTo(0, 4 * s);
  ctx.lineTo(-13 * s, 10 * s);
  ctx.closePath();
  ctx.fill();
  // Cockpit
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(0, -4 * s, 3.6 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawPlayer(ctx, view, game) {
  const p = game.player;
  if (p.dead) return;

  // Squad first (behind)
  for (const o of squadOffsets(p.stats.squad)) {
    const pos = project(view, clamp(p.x + o.dx, -ROAD_HALF, ROAD_HALF), p.z + o.dz);
    drawShip(ctx, pos.sx, pos.sy, pos.f * view.unitScale * 0.8, '#2fb8d6', false);
  }

  const { sx, sy, f } = project(view, p.x, p.z);
  const s = f * view.unitScale; // pixels per world unit at player depth
  if (p.invuln > 0.55) {
    // long invulnerability (shield token) draws as a bubble, not a blink
    ctx.save();
    ctx.strokeStyle = 'rgba(53,224,255,0.8)';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#35e0ff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(sx, sy - 4 * s, 26 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (p.invuln > 0 && Math.floor(p.invuln * 20) % 2 === 0) {
    ctx.globalAlpha = 0.35;
  }
  drawShip(ctx, sx, sy, s, p.hurtFlash > 0 ? '#ff8090' : '#35e0ff', true);
  ctx.globalAlpha = 1;
}
