// Upgrade definitions + gate rows. UPGRADE-AGENT OWNS THIS FILE.
// A gate row = 1-2 slots at the same z. Crossing a slot applies its upgrade
// and consumes the row. Chargeable slots gain value when shot (gateOnShot).

import { ROAD_HALF } from './config.js';
import { clamp } from './utils.js';
import { project } from './render.js';
import { clampStats } from './player.js';
import { healPlayer, damagePlayer } from './player.js';
import { fx } from './effects.js';
import { audio } from './audio.js';

export const GATE_COLORS = { good: '#3ddc84', bad: '#ff4d5a', mixed: '#c77dff' };

// value flows: base -> (chargeable: +chargeStep per hit, capped) -> apply(game, value)
export const UPGRADES = {
  damage: {
    kind: 'good', base: 10, chargeable: true, chargeStep: 1, max: 40,
    label: (v) => `+${v} DMG`,
    apply: (game, v) => { game.player.stats.damage += v; },
  },
  fireRate: {
    kind: 'good', base: 25, chargeable: true, chargeStep: 1, max: 60,
    label: (v) => `+${v}% FIRE RATE`,
    apply: (game, v) => { game.player.stats.fireInterval /= 1 + v / 100; },
  },
  multishot: {
    kind: 'good', base: 1,
    label: (v) => `+${v} SHOT${v > 1 ? 'S' : ''}`,
    apply: (game, v) => { game.player.stats.projectiles += v; },
  },
  squad: {
    kind: 'good', base: 1, chargeable: true, chargeStep: 0.08, max: 3,
    label: (v) => `+${Math.floor(v)} ALLY`,
    apply: (game, v) => { game.player.stats.squad += Math.floor(v); },
  },
  heal: {
    kind: 'good', base: 30,
    label: (v) => `HEAL ${v}`,
    apply: (game, v) => healPlayer(game, v),
  },
  loseDamage: {
    kind: 'bad', base: 25,
    label: (v) => `-${v}% DMG`,
    apply: (game, v) => { game.player.stats.damage *= 1 - v / 100; },
  },
  hurt: {
    kind: 'bad', base: 20,
    label: (v) => `-${v} HP`,
    apply: (game, v) => damagePlayer(game, v, true),
  },
};

// Spawn a row of gate slots. defs: [{key, value?}] length 1-2.
export function spawnGateRow(game, z, defs) {
  const n = defs.length;
  const slots = defs.map((d, i) => {
    const up = UPGRADES[d.key];
    if (!up) { console.error(`Unknown upgrade: ${d.key}`); return null; }
    const halfW = n === 1 ? ROAD_HALF * 0.55 : ROAD_HALF * 0.46;
    const x = n === 1 ? 0 : (i === 0 ? -ROAD_HALF * 0.5 : ROAD_HALF * 0.5);
    return {
      key: d.key, up,
      x, halfW,
      value: d.value ?? up.base,
      chargeable: !!up.chargeable,
      chargeProgress: 0,
      hitFlash: 0,
    };
  }).filter(Boolean);
  game.gates.push({ z, slots, used: false, dead: false });
}

export function updateGates(game, dt) {
  for (const g of game.gates) {
    for (const s of g.slots) s.hitFlash = Math.max(0, s.hitFlash - dt);
    if (g.z < game.player.z - 40) g.dead = true;
  }
}

// Projectile hit a chargeable slot (called from collisions.js)
export function gateOnShot(game, gate, slot) {
  if (!slot.chargeable || gate.used) return;
  const up = slot.up;
  slot.chargeProgress += up.chargeStep;
  slot.value = clamp(slot.value + up.chargeStep, 0, up.max ?? Infinity);
  slot.hitFlash = 0.1;
}

// Player crossed a slot (called from collisions.js)
export function applyGateSlot(game, gate, slot) {
  if (gate.used) return;
  gate.used = true;
  gate.dead = true;
  const v = Math.round(slot.value);
  slot.up.apply(game, v);
  clampStats(game.player.stats);
  const color = GATE_COLORS[slot.up.kind];
  fx.textPop(game.player.x, game.player.z + 60, slot.up.label(v), color);
  fx.flash(color, 0.12, 0.3);
  if (slot.up.kind === 'bad') audio.gateBad(); else audio.gateGood();
  game.lastUpgrade = { label: slot.up.label(v), kind: slot.up.kind };
}

export function drawGates(ctx, view, game) {
  const sorted = [...game.gates].sort((a, b) => b.z - a.z);
  for (const g of sorted) {
    if (g.dead) continue;
    for (const s of g.slots) {
      const color = GATE_COLORS[s.up.kind];
      const L = project(view, s.x - s.halfW, g.z);
      const R = project(view, s.x + s.halfW, g.z);
      const h = 90 * L.f * view.unitScale * 0.16 * 2.4;
      // Glass panel
      ctx.globalAlpha = s.hitFlash > 0 ? 0.75 : 0.4;
      ctx.fillStyle = color;
      ctx.fillRect(L.sx, L.sy - h, R.sx - L.sx, h);
      ctx.globalAlpha = 1;
      // Frame posts
      ctx.fillStyle = color;
      const pw = Math.max(2, 5 * L.f);
      ctx.fillRect(L.sx - pw / 2, L.sy - h, pw, h);
      ctx.fillRect(R.sx - pw / 2, R.sy - h, pw, h);
      ctx.fillRect(L.sx, L.sy - h - pw, R.sx - L.sx, pw);
      // Label
      const cx = (L.sx + R.sx) / 2;
      const fs = Math.max(11, 30 * L.f);
      ctx.font = `900 ${fs}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 4;
      ctx.fillText(s.up.label(Math.round(s.value)), cx, L.sy - h * 0.45);
      if (s.chargeable) {
        ctx.font = `600 ${fs * 0.5}px sans-serif`;
        ctx.fillStyle = '#ffd166';
        ctx.fillText('⌖ SHOOT ME', cx, L.sy - h * 0.18);
      }
      ctx.shadowBlur = 0;
    }
  }
}
