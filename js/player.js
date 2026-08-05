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
    allies: [],          // persistent squad ships (see ALLY below)
    fireTimer: 0,
    invuln: 0,
    hurtFlash: 0,
    dead: false,
  };
}

// Squad ships: orbit the main ship, fire the same volleys, and are MORTAL —
// they have their own HP, absorb enemy contact/shots, and die when spent.
export const ALLY = {
  radius: 12,
  maxHp: 60,
  orbitR: 46,          // world units around the player
  orbitSpeed: 1.15,    // rad/s
  invulnTime: 0.35,    // per-ally i-frames so one wave can't delete it instantly
  hurtBarTime: 1.6,    // s the mini HP bar lingers after damage
};

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

// Keep the ally roster in sync with stats.squad: upgrades grow it (fresh ships
// arrive at full HP), clampStats caps it, and deaths shrink stats.squad back.
function syncAllies(game) {
  const p = game.player;
  while (p.allies.length < p.stats.squad) {
    p.allies.push({
      x: p.x, z: p.z,
      radius: ALLY.radius,
      hp: ALLY.maxHp, maxHp: ALLY.maxHp,
      invuln: 0.6,     // spawn grace
      flash: 0, hurtT: 0,
      dead: false,
    });
  }
  if (p.allies.length > p.stats.squad) p.allies.length = p.stats.squad;
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

  // ---- allies: bury the dead, sync with stats, orbit the mothership --------
  let lost = false;
  for (let i = p.allies.length - 1; i >= 0; i--) {
    if (p.allies[i].dead) { p.allies.splice(i, 1); lost = true; }
  }
  if (lost) p.stats.squad = p.allies.length;
  syncAllies(game);
  const n = p.allies.length;
  for (let i = 0; i < n; i++) {
    const a = p.allies[i];
    const ang = game.time * ALLY.orbitSpeed + (i / n) * Math.PI * 2;
    a.x = clamp(p.x + Math.cos(ang) * ALLY.orbitR, -ROAD_HALF + a.radius, ROAD_HALF - a.radius);
    a.z = p.z + Math.sin(ang) * ALLY.orbitR;
    a.invuln = Math.max(0, a.invuln - dt);
    a.flash = Math.max(0, a.flash - dt);
    a.hurtT = Math.max(0, a.hurtT - dt);
  }

  // Auto-fire: player + every living ally fires the full volley
  p.fireTimer -= dt;
  if (p.fireTimer <= 0) {
    p.fireTimer = p.stats.fireInterval;
    fireVolley(game, p.x, p.z + 20, p.stats);
    for (const a of p.allies) fireVolley(game, a.x, a.z + 14, p.stats);
    audio.shoot();
  }

  p.invuln = Math.max(0, p.invuln - dt);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt);
}

// An ally got hit (collisions.js). Own HP, own i-frames, no revive.
export function damageAlly(game, ally, amount) {
  if (ally.dead || ally.invuln > 0 || game.state !== 'playing') return;
  ally.hp -= amount;
  ally.invuln = ALLY.invulnTime;
  ally.flash = 0.2;
  ally.hurtT = ALLY.hurtBarTime;
  fx.hitSpark(ally.x, ally.z, '#2fb8d6');
  audio.hit();
  if (ally.hp <= 0) {
    ally.hp = 0;
    ally.dead = true;
    fx.explosion(ally.x, ally.z, 46, '#2fb8d6');
    fx.textPop(ally.x, ally.z + 20, 'ALLY DOWN', '#8fd8ff');
    audio.explode();
  }
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
  if (p.dead) return; // a heal collected during the death beat must not revive the HUD
  const used = Math.min(p.maxHp - p.hp, amount);
  p.hp += used;
  if (used > 0) fx.textPop(p.x, p.z + 30, `+${Math.round(used)}`, '#56b06c');
  // Overflow repairs the most damaged ally instead of evaporating.
  let over = amount - used;
  if (over > 0 && p.allies.length) {
    let worst = null;
    for (const a of p.allies) {
      if (a.hp < a.maxHp && (!worst || a.hp / a.maxHp < worst.hp / worst.maxHp)) worst = a;
    }
    if (worst) {
      worst.hp = Math.min(worst.maxHp, worst.hp + over);
      fx.textPop(worst.x, worst.z + 20, `+${Math.round(over)}`, '#8fd8ff');
      fx.hitSpark(worst.x, worst.z, '#8fd8ff');
    }
  }
}

// Steampunk gyro-wedge: aether-glow hull (silhouette unchanged for readability),
// brass trim, porthole cockpit, and a spinning brass tail gear driven by t.
function drawShip(ctx, sx, sy, s, color, glow, t = 0) {
  ctx.save();
  ctx.translate(sx, sy);

  // Tail gear (behind the hull), slowly counter-rotating
  ctx.save();
  ctx.translate(0, 8 * s);
  ctx.rotate(t * 2.4);
  ctx.fillStyle = '#c9973b';
  const R = 6.5 * s, r = 4.6 * s;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2, a1 = a0 + Math.PI / 8;
    ctx.arc(0, 0, R, a0, a0 + Math.PI / 16);
    ctx.arc(0, 0, r, a1, a1 + Math.PI / 8);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8a6a2a';
  ctx.beginPath();
  ctx.arc(0, 0, 1.8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  // Hull: arrow-like wedge (same silhouette as pre-retheme)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -18 * s);
  ctx.lineTo(13 * s, 10 * s);
  ctx.lineTo(0, 4 * s);
  ctx.lineTo(-13 * s, 10 * s);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  // Brass trim along the hull edges
  ctx.strokeStyle = 'rgba(240,180,41,0.85)';
  ctx.lineWidth = Math.max(1, 1.3 * s);
  ctx.stroke();
  // Porthole cockpit: brass ring around glass
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(0, -4 * s, 3.4 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#c9973b';
  ctx.lineWidth = Math.max(1, 1.1 * s);
  ctx.stroke();
  ctx.restore();
}

export function drawPlayer(ctx, view, game) {
  const p = game.player;
  if (p.dead) return;

  // Allies first (they orbit through both in-front and behind positions)
  for (let i = 0; i < p.allies.length; i++) {
    const a = p.allies[i];
    const pos = project(view, a.x, a.z);
    const as = pos.f * view.unitScale * 0.72;
    if (a.invuln > 0.4) ctx.globalAlpha = 0.55; // spawn/i-frame shimmer
    drawShip(ctx, pos.sx, pos.sy, as, a.flash > 0 ? '#ff8090' : '#2fb8d6', false, game.time + i * 1.7);
    ctx.globalAlpha = 1;
    // mini HP bar only while recently hurt — no permanent clutter
    if (a.hurtT > 0 && !a.dead) {
      const bw = 26 * as;
      ctx.globalAlpha = Math.min(1, a.hurtT / 0.4);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(pos.sx - bw / 2, pos.sy - 26 * as, bw, 3);
      ctx.fillStyle = '#2fb8d6';
      ctx.fillRect(pos.sx - bw / 2, pos.sy - 26 * as, bw * (a.hp / a.maxHp), 3);
      ctx.globalAlpha = 1;
    }
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
  drawShip(ctx, sx, sy, s, p.hurtFlash > 0 ? '#ff8090' : '#35e0ff', true, game.time);
  ctx.globalAlpha = 1;
}
