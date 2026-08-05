// Particles, floaters (damage numbers / labels), screen shake, screen flash.
// All positions are WORLD coords; drawing projects via render.project.
// FX-agent: improve visuals freely, keep the exported API identical.
//
// Conventions used here:
//  - `size`, `r1` (end radius / height) and the optional `y` (height above the
//    road plane) are all WORLD units. Everything is drawn at k = f * unitScale.
//  - Particles are drawn additively ('lighter') in a single save/restore block.
//    'steam' is the one exception: it flips to source-over for its two arcs and
//    flips straight back, so soft smoke reads as smoke and not as light.
//  - Particle kinds: spark, ring, flash, ember, pillar, steam (STEAMPUNK puffs)
//    and gear (spinning cog silhouettes — `r1` doubles as spin rate in rad/s).
//  - Rotation is driven by the fx-local `clock` (frozen while paused) and the
//    per-particle `seed`. Never Date.now().
//  - Damage numbers aggregate: a plain-number pop of the same color within
//    MERGE_CELL world units of a floater younger than MERGE_WINDOW is summed
//    into it and re-punched instead of stacking. No call-site changes required.

import { LIMITS } from './config.js';
import { rand, choice } from './utils.js';
import { project } from './render.js';

const CRIT_COLOR = '#ffd166';   // collisions.js tags crit damage numbers with this
const MERGE_WINDOW = 0.3;       // s: nearby numbers merge instead of stacking
const MERGE_CELL = 40;          // world units: merge radius (per-axis box test)
const FLOATER_CAP = 40;

const STEAM = '#e6e1d7';        // DESIGN.md steam
const BRASS_HI = '#f0b429';     // DESIGN.md bright brass
const BRASS = '#c9973b';        // DESIGN.md brass

// One unit-radius cog path, built on first use (never at module load: this file
// must stay importable outside a browser) and reused by every gear particle.
let GEAR_PATH = null;
function gearShape() {
  if (GEAR_PATH) return GEAR_PATH;
  const teeth = 7, depth = 0.3, step = 6.2832 / teeth, rIn = 1 - depth;
  const p = new Path2D();
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const a1 = a + step * 0.14, a2 = a + step * 0.36, a3 = a + step * 0.5;
    const x0 = Math.cos(a) * rIn, y0 = Math.sin(a) * rIn;
    if (i === 0) p.moveTo(x0, y0); else p.lineTo(x0, y0);
    p.lineTo(Math.cos(a1), Math.sin(a1));
    p.lineTo(Math.cos(a2), Math.sin(a2));
    p.lineTo(Math.cos(a3) * rIn, Math.sin(a3) * rIn);
  }
  p.closePath();
  // hub bore, so the silhouette reads as a cog even at a few pixels across
  p.moveTo(0.26, 0);
  p.arc(0, 0, 0.26, 0, 6.2832, true);
  GEAR_PATH = p;
  return p;
}

const particles = [];
const floaters = [];
let cursor = 0;                 // ring-buffer write head once LIMITS.particles is hit

let shakeMag = 0, shakeDur = 0, shakeT = 0;
let flashColor = null, flashAlpha = 0, flashDur = 0, flashT = 0;
let clock = 0;                  // fx-local seconds (frozen while paused)
let bossT = 0, bossDur = 0, bossStage = 0;

// ---- particle plumbing -------------------------------------------------------
// One uniform object shape keeps this monomorphic for the JIT.
function spawn(kind, x, y, z, vx, vy, vz, life, size, color, drag, grav, alpha, r1) {
  const p = {
    kind, x, y, z, vx, vy, vz,
    t: 0, life, size, color,
    drag, grav, alpha, r1,
    seed: Math.random() * 6.2832,
  };
  if (particles.length >= LIMITS.particles) {
    // Strict cap, O(1): overwrite in a rotating slot (update() already
    // swap-removes, so the array is not age-ordered anyway).
    particles[cursor % particles.length] = p;
    cursor = (cursor + 1) % LIMITS.particles;
  } else {
    particles.push(p);
  }
  return p;
}

function doShake(mag, dur) {
  if (mag >= shakeMag * (1 - shakeT / (shakeDur || 1))) {
    shakeMag = mag; shakeDur = dur; shakeT = 0;
  }
}

function doFlash(color, alpha, dur) {
  flashColor = color; flashAlpha = alpha; flashDur = dur; flashT = 0;
}

// Boss intro is a tiny scripted timeline of shakes + flashes (auto-expires).
function advanceBossIntro(dt) {
  bossT += dt;
  if (bossStage === 0 && bossT > 0.45) { bossStage = 1; doShake(7, 0.4); doFlash('#b23bc9', 0.26, 0.3); }
  else if (bossStage === 1 && bossT > 0.8) { bossStage = 2; doShake(4.5, 0.3); }
  if (bossT >= bossDur) { bossDur = 0; bossT = 0; bossStage = 0; }
}

export const fx = {
  reset() {
    particles.length = 0;
    floaters.length = 0;
    cursor = 0;
    shakeMag = shakeDur = shakeT = 0;
    flashAlpha = flashT = flashDur = 0;
    flashColor = null;
    clock = 0;
    bossT = bossDur = bossStage = 0;
  },

  // Small, sharp impact: a couple of fast streaks + a pinpoint flash.
  hitSpark(x, z, color = '#ffd166') {
    spawn('flash', x, 4, z, 0, 0, 0, 0.09, 7, color, 0, 0, 0.7, 9);
    for (let i = 0; i < 4; i++) {
      const a = rand(0, Math.PI * 2), s = rand(150, 330);
      spawn('spark', x, rand(0, 8), z, Math.cos(a) * s, rand(20, 120), Math.sin(a) * s,
        rand(0.09, 0.2), rand(1.4, 2.6), color, 7, -420, 1, 0);
    }
  },

  // Layered blast: core flash + shockwave ring + sparks + slow embers + a few
  // lazy steam puffs (ruptured boiler, not just fire).
  explosion(x, z, radius = 70, color = '#ff8a5a') {
    const sparks = Math.round(Math.min(18, Math.max(8, radius * 0.28)));
    const embers = Math.round(Math.min(7, Math.max(3, radius * 0.09)));
    const puffs = Math.round(Math.min(4, Math.max(2, radius * 0.05)));

    spawn('flash', x, radius * 0.18, z, 0, 0, 0, 0.14, radius * 0.55, '#fff3d6', 0, 0, 0.95, radius * 0.95);
    spawn('ring', x, 2, z, 0, 0, 0, 0.38, radius * 0.25, color, 0, 0, 0.85, radius * 1.75);

    for (let i = 0; i < sparks; i++) {
      const a = rand(0, Math.PI * 2), s = rand(90, 340) * (0.6 + radius / 120);
      spawn('spark', x, rand(0, radius * 0.3), z, Math.cos(a) * s, rand(60, 300), Math.sin(a) * s,
        rand(0.2, 0.45), rand(2, 4.5), i % 5 === 0 ? '#ffe9b0' : color, 3.4, -760, 1, 0);
    }
    for (let i = 0; i < embers; i++) {
      const a = rand(0, Math.PI * 2), s = rand(20, 80);
      spawn('ember', x, rand(2, radius * 0.4), z, Math.cos(a) * s, rand(30, 90), Math.sin(a) * s,
        rand(0.5, 0.95), rand(1.6, 3), color, 1.2, -110, 0.8, 0);
    }
    // steam: slow, expanding, rising, no gravity fall-back
    for (let i = 0; i < puffs; i++) {
      const a = rand(0, Math.PI * 2), s = rand(14, 52);
      spawn('steam', x + Math.cos(a) * radius * 0.22, rand(radius * 0.12, radius * 0.5),
        z + Math.sin(a) * radius * 0.22, Math.cos(a) * s, rand(45, 95), Math.sin(a) * s,
        rand(0.7, 1.15), radius * 0.2, STEAM, 0.85, 12, 0.55, radius * 0.7);
    }
    doShake(Math.min(radius * 0.06, 8), 0.2);
  },

  // Directional muzzle flash (defaults to straight ahead, +z). The aether-cyan
  // core is a gameplay read (player fire) and stays; one ejected spark is warmed
  // to brass so the barrel itself reads as machined metal.
  muzzle(x, z, dirX = 0, dirZ = 1) {
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len, uz = dirZ / len;
    spawn('flash', x + ux * 6, 6, z + uz * 6, 0, 0, 0, 0.07, 6, '#9df3ff', 0, 0, 0.85, 11);
    for (let i = 0; i < 2; i++) {
      spawn('spark', x, 6, z, ux * rand(40, 130) + rand(-50, 50), rand(-10, 40), uz * rand(180, 320),
        0.09, 1.5, i === 0 ? '#d9fbff' : '#ffdca8', 5, 0, 0.9, 0);
    }
  },

  // Gate celebration: light pillar + ground ring + a shower of spinning cogs
  // (same particle budget as the old confetti). Call from gates.js
  // applyGateSlot(): fx.gateBurst(game.player.x, gate.z, color).
  gateBurst(x, z, color = '#56b06c') {
    spawn('pillar', x, 0, z, 0, 0, 0, 0.55, 26, color, 0, 0, 0.9, 280);
    spawn('ring', x, 1, z, 0, 0, 0, 0.42, 24, color, 0, 0, 0.8, 150);
    spawn('flash', x, 10, z, 0, 0, 0, 0.16, 26, '#ffffff', 0, 0, 0.55, 46);
    for (let i = 0; i < 12; i++) {
      const a = rand(0, Math.PI * 2), s = rand(40, 190);
      // r1 = spin rate (rad/s); the slot color stays dominant for the read
      spawn('gear', x, rand(4, 26), z, Math.cos(a) * s, rand(230, 520), Math.sin(a) * s,
        rand(0.5, 0.95), rand(2.4, 4.4), choice([color, color, BRASS_HI, '#ffffff']),
        0.9, -760, 1, rand(-11, 11));
    }
    for (let i = 0; i < 4; i++) {       // a few bright streaks keep the punch
      const a = rand(0, Math.PI * 2), s = rand(60, 200);
      spawn('spark', x, rand(4, 26), z, Math.cos(a) * s, rand(260, 520), Math.sin(a) * s,
        rand(0.4, 0.8), rand(1.8, 3.2), i % 2 ? color : '#ffffff', 0.9, -760, 1, 0);
    }
    doShake(2, 0.14);
  },

  // Boss reveal: letterbox bars + flash + staged heavy shake. Auto-expires.
  // Call from level.js / main.js right where the boss is spawned.
  bossIntro(dur = 1.2) {
    bossDur = dur; bossT = 0; bossStage = 0;
    doFlash('#ffffff', 0.5, 0.28);
    doShake(11, 0.5);
  },

  isBossIntro() { return bossDur > 0; },

  // Plain integers ("17") aggregate: a recent floater of the same color within
  // MERGE_CELL world units absorbs the new value instead of stacking a second
  // number. Anything else ("+10", gate labels) never merges. An explicit `key`
  // (e.g. an enemy id) merges by identity and ignores distance.
  textPop(x, z, text, color = '#ffffff', key = null) {
    const num = /^[0-9]+(\.[0-9]+)?$/.test(text) ? parseFloat(text) : null;

    if (key !== null || num !== null) {
      for (let i = 0; i < floaters.length; i++) {
        const fl = floaters[i];
        if (fl.t >= MERGE_WINDOW) continue;
        if (key !== null) {
          if (fl.key !== key) continue;
        } else if (fl.key !== null || fl.value === null || fl.color !== color
          || Math.abs(fl.x - x) > MERGE_CELL || Math.abs(fl.z - z) > MERGE_CELL) {
          continue;
        }
        if (fl.value !== null && num !== null) {
          fl.value += num;
          fl.text = String(Math.round(fl.value));
        } else {
          fl.text = text;
        }
        fl.x = x; fl.z = z;      // follow the source
        fl.t = 0; fl.pop = 1;    // refresh + punch
        return;
      }
    }

    if (floaters.length >= FLOATER_CAP) floaters.shift();
    floaters.push({
      x, z, text, color,
      t: 0, life: num === null ? 1.0 : 0.8,
      key, value: num,
      crit: num !== null && color === CRIT_COLOR,
      dx: rand(-9, 9), pop: 1,
    });
  },

  shake(mag, dur) { doShake(mag, dur); },

  flash(color, alpha, dur) { doFlash(color, alpha, dur); },

  getShakeX() {
    if (shakeT >= shakeDur) return 0;
    const k = 1 - shakeT / shakeDur;
    return rand(-1, 1) * shakeMag * k;
  },
  getShakeY() {
    if (shakeT >= shakeDur) return 0;
    const k = 1 - shakeT / shakeDur;
    return rand(-1, 1) * shakeMag * k;
  },

  update(dt) {
    clock += dt;
    shakeT += dt;
    flashT += dt;
    if (bossDur > 0) advanceBossIntro(dt);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt;
      if (p.t >= p.life) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
      if (p.drag) {
        const d = p.drag * dt;
        const m = d >= 1 ? 0 : 1 - d;
        p.vx *= m; p.vz *= m; p.vy *= m;
      }
      if (p.grav) p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      if (p.vy) {
        p.y += p.vy * dt;
        if (p.y < 0) {                 // bounce off the road, then settle
          p.y = 0;
          p.vy *= -0.32;
          if (p.vy < 24) p.vy = 0;
        }
      }
    }

    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.t += dt;
      if (f.pop > 0) f.pop = Math.max(0, f.pop - dt * 5);
      if (f.t >= f.life) { floaters[i] = floaters[floaters.length - 1]; floaters.pop(); }
    }
  },

  draw(ctx, view) {
    const uS = view.unitScale;

    // ---- particles: one additive pass ---------------------------------------
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const pr = project(view, p.x, p.z);
      if (pr.f <= 0.015) continue;
      const k = pr.f * uS;
      const py = pr.sy - p.y * k;
      const u = p.t / p.life;
      const fade = 1 - u;

      switch (p.kind) {
        case 'spark': {
          // Short motion trail; screen deltas use unitScale for x/y and vScale for z.
          const tl = 0.05;
          const tx = pr.sx - p.vx * tl * k;
          const ty = py + p.vz * tl * pr.f * view.vScale + p.vy * tl * k;
          ctx.globalAlpha = Math.min(1, p.alpha * fade * 1.25);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.8, p.size * k * (0.4 + fade * 0.6));
          ctx.beginPath();
          ctx.moveTo(pr.sx, py);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          break;
        }
        case 'ring': {
          const r = (p.size + (p.r1 - p.size) * (1 - fade * fade)) * k;
          ctx.globalAlpha = p.alpha * fade * fade;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, 7 * k * fade);
          ctx.beginPath();
          ctx.ellipse(pr.sx, py, r, r * 0.42, 0, 0, 6.2832);
          ctx.stroke();
          break;
        }
        case 'flash': {
          const r = (p.size + (p.r1 - p.size) * u) * k;
          ctx.globalAlpha = p.alpha * fade * fade;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(pr.sx, py, r, 0, 6.2832);
          ctx.fill();
          ctx.globalAlpha = p.alpha * fade;
          ctx.beginPath();
          ctx.arc(pr.sx, py, r * 0.45, 0, 6.2832);
          ctx.fill();
          break;
        }
        case 'ember': {
          const flick = 0.55 + 0.45 * Math.sin(clock * 22 + p.seed);
          ctx.globalAlpha = p.alpha * fade * flick;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(pr.sx, py, Math.max(0.7, p.size * k * (0.5 + fade * 0.5)), 0, 6.2832);
          ctx.fill();
          break;
        }
        case 'steam': {
          // Soft twin-lobe puff: slow expansion, quick fade-in, long fade-out.
          const r = (p.size + (p.r1 - p.size) * (1 - (1 - u) * (1 - u))) * k;
          if (r < 0.8) break;
          const a = p.alpha * Math.min(1, u * 5) * fade * fade;
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = p.color;
          ctx.globalAlpha = a * 0.62;
          ctx.beginPath();
          ctx.arc(pr.sx, py, r, 0, 6.2832);
          ctx.fill();
          ctx.globalAlpha = a * 0.5;
          ctx.beginPath();
          ctx.arc(pr.sx + Math.cos(p.seed) * r * 0.4, py - r * 0.35, r * 0.62, 0, 6.2832);
          ctx.fill();
          ctx.globalCompositeOperation = 'lighter';
          break;
        }
        case 'gear': {
          // Tiny spinning cog silhouette: one shared Path2D, scaled + rotated.
          const r = p.size * k * (0.55 + fade * 0.65);
          if (r < 0.7) break;
          ctx.globalAlpha = Math.min(1, p.alpha * fade * 1.15);
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(pr.sx, py);
          ctx.rotate(p.seed + clock * p.r1);
          ctx.scale(r, r);
          ctx.fill(gearShape());
          ctx.restore();
          break;
        }
        case 'pillar': {
          const grow = Math.min(1, u / 0.22);
          const h = p.r1 * k * grow;
          const w = p.size * k;
          const a = p.alpha * fade * fade;
          ctx.fillStyle = p.color;
          ctx.globalAlpha = a * 0.14;
          ctx.fillRect(pr.sx - w * 1.1, py - h, w * 2.2, h);
          ctx.globalAlpha = a * 0.26;
          ctx.fillRect(pr.sx - w * 0.55, py - h, w * 1.1, h);
          ctx.globalAlpha = a * 0.75;
          ctx.fillRect(pr.sx - w * 0.16, py - h, w * 0.32, h);
          ctx.globalAlpha = a * 0.5;
          ctx.beginPath();
          ctx.ellipse(pr.sx, py, w * 1.6, w * 0.55, 0, 0, 6.2832);
          ctx.fill();
          break;
        }
        default: {
          ctx.globalAlpha = (p.alpha || 1) * fade;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(pr.sx, py, p.size * k * (0.5 + fade * 0.5), 0, 6.2832);
          ctx.fill();
        }
      }
    }
    ctx.restore();

    // ---- floaters (damage numbers / labels) ---------------------------------
    ctx.textAlign = 'center';
    for (let i = 0; i < floaters.length; i++) {
      const fl = floaters[i];
      const pr = project(view, fl.x, fl.z);
      if (pr.f <= 0.02) continue;
      const k = pr.f * uS;
      const u = fl.t / fl.life;
      const size = Math.max(11, (fl.crit ? 19 : 14.5) * k) * (1 + fl.pop * 0.25);
      const sy = pr.sy - (30 + u * 52) * k;
      const sx = pr.sx + fl.dx * k;
      ctx.globalAlpha = 1 - u * u;
      ctx.font = `900 ${size}px sans-serif`;
      ctx.lineWidth = Math.max(2, size * 0.17);
      ctx.strokeStyle = fl.crit ? 'rgba(92,28,0,0.85)' : 'rgba(14,10,6,0.82)';
      ctx.strokeText(fl.text, sx, sy);
      ctx.fillStyle = fl.color;
      ctx.fillText(fl.text, sx, sy);
    }
    ctx.globalAlpha = 1;

    // ---- boss intro letterbox ----------------------------------------------
    if (bossDur > 0) {
      const u = bossT / bossDur;
      const grow = Math.min(1, u / 0.16);
      const close = u > 0.78 ? Math.max(0, 1 - (u - 0.78) / 0.22) : 1;
      const h = view.H * 0.135 * grow * close;
      if (h > 0.5) {
        ctx.fillStyle = '#0f0c09';                 // coal bars
        ctx.fillRect(0, 0, view.W, h);
        ctx.fillRect(0, view.H - h, view.W, h);
        const pulse = 0.45 + 0.55 * Math.abs(Math.sin(bossT * 11));
        ctx.globalAlpha = pulse * close;
        ctx.fillStyle = BRASS;                     // riveted brass rim
        ctx.fillRect(0, h - 2, view.W, 2);
        ctx.fillRect(0, view.H - h, view.W, 2);
        ctx.globalAlpha = 0.7 * close;
        ctx.fillStyle = BRASS_HI;
        const step = Math.max(30, view.W / 16);
        for (let rx = step * 0.5; rx < view.W; rx += step) {
          ctx.fillRect(rx - 1.5, h - 7, 3, 3);
          ctx.fillRect(rx - 1.5, view.H - h + 4, 3, 3);
        }
        ctx.globalAlpha = 1;
      }
    }

    // ---- screen flash -------------------------------------------------------
    if (flashColor && flashT < flashDur) {
      ctx.globalAlpha = flashAlpha * (1 - flashT / flashDur);
      ctx.fillStyle = flashColor;
      ctx.fillRect(0, 0, view.W, view.H);
      ctx.globalAlpha = 1;
    }
  },
};
