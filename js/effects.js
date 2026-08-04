// Particles, floaters (damage numbers / labels), screen shake, screen flash.
// All positions are WORLD coords; drawing projects via render.project.
// FX-agent: improve visuals freely, keep the exported API identical.

import { LIMITS } from './config.js';
import { rand } from './utils.js';
import { project } from './render.js';

const particles = [];
const floaters = [];
let shakeMag = 0, shakeDur = 0, shakeT = 0;
let flashColor = null, flashAlpha = 0, flashDur = 0, flashT = 0;

function addParticle(p) {
  if (particles.length >= LIMITS.particles) particles.shift();
  particles.push(p);
}

export const fx = {
  reset() {
    particles.length = 0;
    floaters.length = 0;
    shakeMag = shakeDur = shakeT = 0;
    flashAlpha = flashT = flashDur = 0;
    flashColor = null;
  },

  hitSpark(x, z, color = '#ffd166') {
    for (let i = 0; i < 5; i++) {
      addParticle({
        x, z, vx: rand(-160, 160), vz: rand(-160, 160),
        life: rand(0.15, 0.35), t: 0, size: rand(2.5, 5), color,
      });
    }
  },

  explosion(x, z, radius = 70, color = '#ff8a5a') {
    for (let i = 0; i < 16; i++) {
      const a = rand(0, Math.PI * 2), s = rand(60, 340);
      addParticle({
        x, z, vx: Math.cos(a) * s, vz: Math.sin(a) * s,
        life: rand(0.3, 0.6), t: 0, size: rand(3, 8), color,
      });
    }
    this.shake(Math.min(radius * 0.06, 8), 0.2);
  },

  muzzle(x, z) {
    addParticle({ x, z, vx: 0, vz: 60, life: 0.08, t: 0, size: 5, color: '#9df3ff' });
  },

  textPop(x, z, text, color = '#ffffff') {
    if (floaters.length > 40) floaters.shift();
    floaters.push({ x, z, text, color, t: 0, life: 0.8 });
  },

  shake(mag, dur) {
    if (mag >= shakeMag * (1 - shakeT / (shakeDur || 1))) {
      shakeMag = mag; shakeDur = dur; shakeT = 0;
    }
  },

  flash(color, alpha, dur) {
    flashColor = color; flashAlpha = alpha; flashDur = dur; flashT = 0;
  },

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
    shakeT += dt;
    flashT += dt;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt;
      if (p.t >= p.life) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
      p.x += p.vx * dt;
      p.z += p.vz * dt;
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.t += dt;
      if (f.t >= f.life) { floaters[i] = floaters[floaters.length - 1]; floaters.pop(); }
    }
  },

  draw(ctx, view) {
    for (const p of particles) {
      const { sx, sy, f } = project(view, p.x, p.z);
      const k = 1 - p.t / p.life;
      ctx.globalAlpha = k;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx, sy, p.size * f * (0.5 + k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    for (const fl of floaters) {
      const { sx, sy, f } = project(view, fl.x, fl.z);
      const k = fl.t / fl.life;
      ctx.globalAlpha = 1 - k * k;
      ctx.font = `800 ${Math.max(12, 17 * f)}px sans-serif`;
      ctx.fillStyle = fl.color;
      ctx.fillText(fl.text, sx, sy - 30 * f - k * 34);
    }
    ctx.globalAlpha = 1;

    if (flashColor && flashT < flashDur) {
      ctx.globalAlpha = flashAlpha * (1 - flashT / flashDur);
      ctx.fillStyle = flashColor;
      ctx.fillRect(0, 0, view.W, view.H);
      ctx.globalAlpha = 1;
    }
  },
};
