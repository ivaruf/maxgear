// Animated upgrade-effect vignettes for the level-clear KEEP screen (v1.5).
// Each track gets a small looping demo: the player's ACTUAL bullet style (via
// bulletStyle.js) firing at dummy cog-machines, with the effect played out —
// arcs jump, burns tick, saws orbit, aegis blocks. Fully procedural.
//
// startPreview(canvas, key, level) -> stop()   (one rAF loop per call)

import { BASE_STATS } from './config.js';
import { recomputeStats, TRACKS } from './upgrades.js';
import { computeBulletStyle, ensureBulletSprites } from './bulletStyle.js';

const TAU = Math.PI * 2;
const CYCLE = 2.6;                 // s per loop
const BRASS = '#c9973b';
const BRASS_HI = '#f0b429';
const IRON = '#241c14';
const CYAN = '#35e0ff';

// Build the real stats + bullet style a lone track at `level` would produce.
function buildEnv(key, level) {
  const fake = {
    tracks: { [key]: level },
    stats: { ...BASE_STATS },
    maxHp: 100, hp: 100, allies: [],
  };
  try { recomputeStats(fake); } catch (e) { /* stats stay base */ }
  const style = {};
  let baked = null;
  try {
    computeBulletStyle(fake.stats, style);
    ensureBulletSprites(style, { dpr: 1, unitScale: 2, W: 280, H: 150 });
    if (style.body) baked = style;
  } catch (e) { baked = null; }
  return { stats: fake.stats, style: baked };
}

// ---- tiny scene kit ----------------------------------------------------------

function ship(x, c, y, s, t, o = {}) {
  // tail gear
  x.save();
  x.translate(c, y + 6 * s);
  x.rotate(t * 2.4);
  x.fillStyle = BRASS;
  x.beginPath();
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * TAU;
    x.arc(0, 0, 5 * s, a0, a0 + TAU / 32);
    x.arc(0, 0, 3.6 * s, a0 + TAU / 16, a0 + TAU / 10);
  }
  x.closePath();
  x.fill();
  x.restore();
  // hull (pointing right)
  x.save();
  x.translate(c, y);
  x.rotate(Math.PI / 2);
  x.shadowColor = CYAN;
  x.shadowBlur = 10;
  x.fillStyle = o.hurt ? '#ff8090' : CYAN;
  x.beginPath();
  x.moveTo(0, -14 * s);
  x.lineTo(10 * s, 8 * s);
  x.lineTo(0, 3 * s);
  x.lineTo(-10 * s, 8 * s);
  x.closePath();
  x.fill();
  x.shadowBlur = 0;
  x.strokeStyle = 'rgba(240,180,41,0.85)';
  x.lineWidth = Math.max(1, s);
  x.stroke();
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.beginPath();
  x.arc(0, -3 * s, 2.6 * s, 0, TAU);
  x.fill();
  // plating strips
  if (o.plates) {
    x.fillStyle = BRASS_HI;
    for (let i = 0; i < Math.min(o.plates, 5); i++) {
      x.fillRect(-9 * s + i * 3.8 * s, 5.4 * s, 2.6 * s, 2 * s);
    }
  }
  // broadside barrels
  if (o.barrels) {
    x.fillStyle = BRASS;
    for (const a of [-Math.PI / 2, Math.PI / 2, Math.PI]) {
      x.save(); x.rotate(a); x.fillRect(-1.2 * s, 8 * s, 2.4 * s, 5 * s); x.restore();
    }
  }
  x.restore();
  // thrust plume (points left, behind the rightward ship)
  if (o.plume) {
    const flick = 0.7 + 0.3 * Math.sin(t * 30);
    x.fillStyle = `rgba(53,224,255,${0.35 * flick})`;
    x.beginPath();
    x.moveTo(c - 14 * s, y);
    x.lineTo(c - (22 + 8 * o.plume) * s * flick, y - 3 * s);
    x.lineTo(c - (22 + 8 * o.plume) * s * flick, y + 3 * s);
    x.closePath();
    x.fill();
  }
}

function cog(x, X, Y, r, t, o = {}) {
  const spin = t * (o.chill ? 0.5 : 1.6);
  x.save();
  x.translate(X, Y);
  x.rotate(spin);
  x.fillStyle = o.flash ? '#ffffff' : (o.color || '#e5484d');
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const a0 = (i / 10) * TAU;
    x.arc(0, 0, r, a0, a0 + TAU / 40);
    x.arc(0, 0, r * 0.74, a0 + TAU / 20, a0 + TAU / 12.5);
  }
  x.closePath();
  x.fill();
  x.rotate(-spin);
  x.fillStyle = '#1a1512';
  x.beginPath();
  x.arc(0, 0, r * 0.24, 0, TAU);
  x.fill();
  if (o.burn) {
    x.strokeStyle = `rgba(255,138,90,${0.5 + 0.4 * Math.sin(t * 12)})`;
    x.lineWidth = Math.max(1.5, r * 0.14);
    x.beginPath(); x.arc(0, 0, r * 1.05, 0, TAU); x.stroke();
  }
  if (o.chill) {
    x.strokeStyle = 'rgba(159,232,255,0.85)';
    x.lineWidth = Math.max(1.5, r * 0.12);
    x.beginPath(); x.arc(0, 0, r * 1.05, 0, TAU); x.stroke();
  }
  x.restore();
}

// bullet moving left->right; frac 0..1 along the path
function shot(x, env, x0, y0, x1, y1, frac, s = 1) {
  const px = x0 + (x1 - x0) * frac;
  const py = y0 + (y1 - y0) * frac;
  const st = env.style;
  if (st && st.body) {
    const dr = 5 * s;
    const sc = dr / st.ref;
    const ang = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
    x.save();
    x.translate(px, py);
    x.rotate(ang);
    if (st.aura) {
      x.globalCompositeOperation = 'lighter';
      x.drawImage(st.aura, -st.auraCx * sc, -st.auraCy * sc, st.auraW * sc, st.auraH * sc);
      x.globalCompositeOperation = 'source-over';
    }
    x.drawImage(st.body, -st.bodyCx * sc, -st.bodyCy * sc, st.bodyW * sc, st.bodyH * sc);
    x.restore();
  } else {
    x.fillStyle = '#8df3ff';
    x.beginPath();
    x.ellipse(px, py, 3 * s, 6 * s, Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2, 0, TAU);
    x.fill();
  }
  return { x: px, y: py };
}

// expanding impact ring; w = 0..1 window progress
function impact(x, X, Y, w, color = '#ffd166', R = 16) {
  if (w <= 0 || w >= 1) return;
  x.strokeStyle = color;
  x.globalAlpha = 1 - w;
  x.lineWidth = 2.5;
  x.beginPath();
  x.arc(X, Y, R * w, 0, TAU);
  x.stroke();
  x.globalAlpha = 1;
}

function num(x, X, Y, text, w, color = '#ffffff', size = 13) {
  if (w <= 0 || w >= 1) return;
  x.globalAlpha = 1 - w * w;
  x.font = `800 ${size}px sans-serif`;
  x.textAlign = 'center';
  x.lineWidth = 3;
  x.strokeStyle = 'rgba(10,8,5,0.8)';
  x.strokeText(text, X, Y - w * 22);
  x.fillStyle = color;
  x.fillText(text, X, Y - w * 22);
  x.globalAlpha = 1;
}

function bolt(x, x0, y0, x1, y1, seed, color = '#8fd6ff') {
  x.strokeStyle = color;
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(x0, y0);
  const segs = 4;
  for (let i = 1; i < segs; i++) {
    const f = i / segs;
    const jag = Math.sin(seed * 13.7 + i * 5.1) * 7;
    x.lineTo(x0 + (x1 - x0) * f + jag * ((y1 - y0) ? 1 : 0), y0 + (y1 - y0) * f + jag);
  }
  x.lineTo(x1, y1);
  x.stroke();
}

// window helper: progress 0..1 while p in [a,b), else outside
const win = (p, a, b) => (p >= a && p < b ? (p - a) / (b - a) : (p < a ? 0 : 1));

// ---- per-track scripts ---------------------------------------------------------
// (ctx, W, H, p [0..1 loop], t [abs seconds], env {stats, style, level})
const SCRIPTS = {
  damage(x, W, H, p, t, env) {
    const sp = (p * 2) % 1;
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    cog(x, W * 0.78, H * 0.55, 15, t, { flash: sp > 0.92 });
    shot(x, env, W * 0.22, H * 0.55, W * 0.74, H * 0.55, sp, 1.5);
    impact(x, W * 0.78, H * 0.55, win(sp, 0.92, 1) , '#ffd166', 20);
    num(x, W * 0.78, H * 0.4, `${Math.round(env.stats.damage)}`, win((p * 2 + 0.5) % 1, 0.4, 1), '#ffffff', 15);
  },
  fireRate(x, W, H, p, t, env) {
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    cog(x, W * 0.78, H * 0.55, 15, t, { flash: Math.sin(t * 18) > 0.5 });
    const n = 5;
    for (let i = 0; i < n; i++) {
      const sp = (p * 3 + i / n) % 1;
      shot(x, env, W * 0.22, H * 0.55, W * 0.74, H * 0.55, sp, 1.2);
    }
    num(x, W * 0.5, H * 0.3, `${(1 / env.stats.fireInterval).toFixed(1)} / s`, win(p, 0.1, 0.9), '#ffd166', 12);
  },
  multishot(x, W, H, p, t, env) {
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    cog(x, W * 0.8, H * 0.3, 11, t, { flash: (p * 2) % 1 > 0.9 });
    cog(x, W * 0.82, H * 0.58, 13, t, { flash: (p * 2) % 1 > 0.9 });
    cog(x, W * 0.8, H * 0.82, 11, t, { flash: (p * 2) % 1 > 0.9 });
    const sp = (p * 2) % 1;
    const n = Math.min(env.stats.projectiles, 5);
    for (let i = 0; i < n; i++) {
      const ty = H * (0.55 + (i - (n - 1) / 2) * 0.16);
      shot(x, env, W * 0.22, H * 0.55, W * 0.78, ty, sp, 1.2);
    }
  },
  homing(x, W, H, p, t, env) {
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    const cy = H * (0.5 + 0.28 * Math.sin(t * 1.8));
    cog(x, W * 0.8, cy, 14, t, { flash: (p * 2) % 1 > 0.9 });
    const sp = (p * 2) % 1;
    // curved path: ease toward the moving target
    const px = W * 0.22 + (W * 0.58) * sp;
    const py = H * 0.55 + (cy - H * 0.55) * sp * sp;
    const st = env.style;
    x.save(); x.translate(px, py); x.rotate(Math.PI / 2 + (cy - H * 0.55) / 120 * sp);
    if (st && st.body) {
      const sc = 7.5 / st.ref;
      x.drawImage(st.body, -st.bodyCx * sc, -st.bodyCy * sc, st.bodyW * sc, st.bodyH * sc);
    } else { x.fillStyle = '#8df3ff'; x.beginPath(); x.ellipse(0, 0, 3, 6, 0, 0, TAU); x.fill(); }
    x.restore();
    // reticle on target
    x.strokeStyle = 'rgba(141,243,255,0.7)';
    x.lineWidth = 1.5;
    x.beginPath(); x.arc(W * 0.8, cy, 20, t * 2, t * 2 + TAU * 0.7); x.stroke();
  },
  lance(x, W, H, p, t, env) {
    ship(x, W * 0.14, H * 0.55, 1.6, t);
    const sp = (p * 2) % 1;
    cog(x, W * 0.56, H * 0.55, 12, t, { flash: sp > 0.55 && sp < 0.75 });
    cog(x, W * 0.82, H * 0.55, 14, t, { flash: sp > 0.88 });
    shot(x, env, W * 0.2, H * 0.55, W * 0.94, H * 0.55, sp, 1.5);
    impact(x, W * 0.56, H * 0.55, win(sp, 0.55, 0.9), '#8df3ff', 14);
    impact(x, W * 0.82, H * 0.55, win(sp, 0.88, 1), '#8df3ff', 16);
  },
  blast(x, W, H, p, t, env) {
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    const sp = (p * 1.5) % 1;
    const boom = win(sp, 0.72, 1);
    cog(x, W * 0.74, H * 0.42, 11, t, { flash: boom > 0 });
    cog(x, W * 0.82, H * 0.66, 13, t, { flash: boom > 0 });
    if (sp < 0.72) shot(x, env, W * 0.22, H * 0.55, W * 0.76, H * 0.55, sp / 0.72, 1.6);
    if (boom > 0 && boom < 1) {
      const R = (env.stats.blastR / 195) * 46 + 18;
      x.fillStyle = `rgba(255,138,90,${0.4 * (1 - boom)})`;
      x.beginPath(); x.arc(W * 0.77, H * 0.55, R * boom, 0, TAU); x.fill();
      impact(x, W * 0.77, H * 0.55, boom, '#ff8a5a', R);
    }
  },
  arc(x, W, H, p, t, env) {
    ship(x, W * 0.14, H * 0.55, 1.6, t);
    const sp = (p * 1.6) % 1;
    const hit = sp > 0.62;
    const cogs = [[W * 0.62, H * 0.55], [W * 0.78, H * 0.32], [W * 0.86, H * 0.72]];
    cogs.forEach(([cx, cy], i) => cog(x, cx, cy, 11 + i, t, { flash: hit && (t * 20 % 2 < 1) }));
    if (sp < 0.62) shot(x, env, W * 0.2, H * 0.55, W * 0.6, H * 0.55, sp / 0.62, 1.4);
    if (hit) {
      const jumps = Math.min(env.stats.chainJumps, 2);
      bolt(x, cogs[0][0], cogs[0][1], cogs[1][0], cogs[1][1], t * 3 | 0);
      if (jumps > 1) bolt(x, cogs[1][0], cogs[1][1], cogs[2][0], cogs[2][1], (t * 3 | 0) + 7);
    }
  },
  burn(x, W, H, p, t, env) {
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    const sp = (p * 1.4) % 1;
    const lit = sp > 0.55;
    cog(x, W * 0.78, H * 0.55, 15, t, { burn: lit, flash: sp > 0.55 && sp < 0.62 });
    if (sp < 0.55) shot(x, env, W * 0.22, H * 0.55, W * 0.74, H * 0.55, sp / 0.55, 1.4);
    if (lit) {
      const tick = ((sp - 0.55) * 5) % 1;
      num(x, W * 0.78, H * 0.4, `${Math.round(env.stats.burnDps * 0.25)}`, tick, '#ff8a5a', 11);
    }
  },
  frost(x, W, H, p, t, env) {
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    const sp = (p * 1.4) % 1;
    const iced = sp > 0.55;
    // chilled cog drifts slower
    const drift = iced ? 6 : 16;
    cog(x, W * 0.78 + Math.sin(t * 2) * drift, H * 0.55, 15, t, { chill: iced });
    if (sp < 0.55) shot(x, env, W * 0.22, H * 0.55, W * 0.74, H * 0.55, sp / 0.55, 1.4);
    if (iced) num(x, W * 0.78, H * 0.36, `-${Math.round(env.stats.frostSlow * 100)}%`, win(sp, 0.6, 1), '#9fe8ff', 12);
  },
  crit(x, W, H, p, t, env) {
    ship(x, W * 0.16, H * 0.55, 1.6, t);
    const sp = (p * 2) % 1;
    const isCrit = (p * 2 | 0) % 2 === 1;   // every other shot crits
    cog(x, W * 0.78, H * 0.55, 15, t, { flash: sp > 0.9 });
    shot(x, env, W * 0.22, H * 0.55, W * 0.74, H * 0.55, sp, isCrit ? 1.9 : 1.3);
    if (isCrit) num(x, W * 0.78, H * 0.4, `x${env.stats.critMul}`, win(sp, 0.9, 1) || win(sp, 0, 0.5) * 0.99, '#ffd166', 16);
  },
  saw(x, W, H, p, t, env) {
    const cx = W * 0.4, cy = H * 0.55;
    ship(x, cx, cy, 1.6, t);
    const n = Math.min(env.stats.sawCount, 4);
    for (let i = 0; i < n; i++) {
      const a = t * env.stats.sawSpin + (i / n) * TAU;
      const sx = cx + Math.cos(a) * 34, sy = cy + Math.sin(a) * 22;
      x.save(); x.translate(sx, sy); x.rotate(t * 6);
      x.fillStyle = BRASS_HI;
      x.beginPath();
      for (let j = 0; j < 8; j++) { const a0 = (j / 8) * TAU; x.arc(0, 0, 7, a0, a0 + TAU / 32); x.arc(0, 0, 5, a0 + TAU / 16, a0 + TAU / 10); }
      x.closePath(); x.fill();
      x.restore();
    }
    // a cog drifts in and gets shredded
    const drift = (p * 1.2) % 1;
    const gx = W * 0.95 - drift * W * 0.4;
    const grinding = gx < cx + 48;
    cog(x, gx, cy, 13, t, { flash: grinding && (t * 16 % 2 < 1) });
    if (grinding) impact(x, gx - 8, cy, (t * 3) % 1, BRASS_HI, 12);
  },
  broadside(x, W, H, p, t, env) {
    const cx = W * 0.45, cy = H * 0.55;
    ship(x, cx, cy, 1.6, t, { barrels: true });
    const sp = (p * 2) % 1;
    shot(x, env, cx + 8, cy, W * 0.9, cy, sp, 1.3);                       // main
    shot(x, env, cx, cy - 8, cx, H * 0.08, sp, 0.9);                      // up
    shot(x, env, cx, cy + 8, cx, H * 0.98, sp, 0.9);                      // down
    if (env.stats.auxLv >= 2) shot(x, env, cx - 10, cy, W * 0.05, cy, sp, 0.9); // rear
  },
  shrapnel(x, W, H, p, t, env) {
    ship(x, W * 0.14, H * 0.55, 1.6, t);
    const sp = (p * 1.5) % 1;
    const popped = sp > 0.6;
    if (!popped) {
      cog(x, W * 0.6, H * 0.55, 12, t);
      shot(x, env, W * 0.2, H * 0.55, W * 0.58, H * 0.55, sp / 0.6, 1.4);
    } else {
      const w = (sp - 0.6) / 0.4;
      const n = Math.min(env.stats.shrapnelN, 6);
      x.fillStyle = BRASS_HI;
      for (let i = 0; i < n; i++) {
        const a = -0.9 + (i / (n - 1)) * 1.8;
        x.save();
        x.translate(W * 0.6 + Math.cos(a) * w * 60, H * 0.55 + Math.sin(a) * w * 46);
        x.rotate(a + w * 6);
        x.fillRect(-3, -1.5, 6, 3);
        x.restore();
      }
      cog(x, W * 0.86, H * 0.5, 12, t, { flash: w > 0.6 });
    }
  },
  squad(x, W, H, p, t, env) {
    const n = Math.min(env.stats.squad, 3);
    ship(x, W * 0.18, H * 0.55, 1.5, t);
    for (let i = 0; i < n; i++) {
      const a = t * 1.15 + (i / Math.max(n, 1)) * TAU;
      ship(x, W * 0.18 + Math.cos(a) * 30, H * 0.55 + Math.sin(a) * 20, 1.0, t + i);
    }
    cog(x, W * 0.8, H * 0.55, 15, t, { flash: (p * 3) % 1 > 0.9 });
    for (let i = 0; i <= n; i++) {
      const sp = (p * 3 + i * 0.23) % 1;
      shot(x, env, W * 0.25, H * (0.45 + 0.07 * i), W * 0.76, H * 0.55, sp, 1.1);
    }
  },
  plating(x, W, H, p, t, env) {
    const lv = Math.max(0, env.level);
    ship(x, W * 0.3, H * 0.55, 1.9, t, { plates: lv });
    // an enemy shot comes in and lands for less
    const sp = (p * 1.6) % 1;
    if (sp < 0.7) {
      x.fillStyle = '#ff8fb0';
      const px = W * 0.9 - sp / 0.7 * (W * 0.52);
      x.beginPath(); x.arc(px, H * 0.55, 4, 0, TAU); x.fill();
    } else {
      impact(x, W * 0.38, H * 0.55, win(sp, 0.7, 1), BRASS_HI, 18);
      const base = 12;
      const took = Math.round(base * (1 - env.stats.armor));
      num(x, W * 0.34, H * 0.4, `-${took}`, win(sp, 0.72, 1), env.stats.armor > 0 ? '#b9e3c4' : '#ffffff', 13);
    }
    num(x, W * 0.7, H * 0.3, `HULL ${env.stats.maxHp}`, win(p, 0.1, 0.95), BRASS_HI, 11);
  },
  aegis(x, W, H, p, t, env) {
    const cx = W * 0.32, cy = H * 0.55;
    const sp = (p * 1.5) % 1;
    const blocked = sp > 0.66;
    ship(x, cx, cy, 1.8, t);
    // ring: bright while charged, shatters on block, fades back in
    const ringA = blocked ? Math.max(0, 1 - (sp - 0.66) * 5) : 0.9;
    if (ringA > 0) {
      x.strokeStyle = `rgba(53,224,255,${ringA * 0.9})`;
      x.lineWidth = 2.5;
      x.beginPath(); x.arc(cx, cy, 26, 0, TAU); x.stroke();
    }
    if (blocked) impact(x, cx + 20, cy, win(sp, 0.66, 1), CYAN, 24);
    if (sp < 0.66) {
      x.fillStyle = '#ff8fb0';
      const px = W * 0.92 - sp / 0.66 * (W * 0.55);
      x.beginPath(); x.arc(px, cy, 4, 0, TAU); x.fill();
    } else {
      num(x, cx, H * 0.34, 'BLOCKED', win(sp, 0.68, 1), CYAN, 12);
    }
  },
  siphon(x, W, H, p, t, env) {
    ship(x, W * 0.18, H * 0.55, 1.6, t);
    const sp = (p * 1.5) % 1;
    const dead = sp > 0.6;
    if (!dead) {
      cog(x, W * 0.76, H * 0.55, 13, t, { flash: sp > 0.55 });
      shot(x, env, W * 0.24, H * 0.55, W * 0.72, H * 0.55, sp / 0.6, 1.3);
    } else {
      const w = (sp - 0.6) / 0.4;
      bolt(x, W * 0.76 - w * (W * 0.5), H * 0.55, W * 0.76, H * 0.55, t * 2 | 0, '#7fd98a');
      num(x, W * 0.22, H * 0.4, `+${env.stats.siphon}`, w, '#56b06c', 13);
    }
  },
  thrust(x, W, H, p, t, env) {
    const sx = W * 0.45 + Math.sin(t * (2 + env.level * 0.5)) * W * 0.26;
    ship(x, sx, H * 0.55, 1.7, t, { plume: 1 + env.level * 0.4 });
    // dodged shots streak past
    for (let i = 0; i < 2; i++) {
      const sp = (p * 2 + i * 0.5) % 1;
      x.fillStyle = '#ff8fb0';
      x.beginPath(); x.arc(W * (0.3 + i * 0.4), H * 0.95 - sp * H * 0.9, 4, 0, TAU); x.fill();
    }
  },
};

export function startPreview(canvas, key, level) {
  if (!canvas || typeof canvas.getContext !== 'function') return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  const cssW = canvas.clientWidth || 260;
  const cssH = canvas.clientHeight || 130;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const env = buildEnv(key, level);
  env.level = level;
  const script = SCRIPTS[key];
  let raf = 0;
  const t0 = performance.now();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const t = (now - t0) / 1000;
    const p = (t % CYCLE) / CYCLE;
    // backdrop: iron road strip
    const g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, '#171017');
    g.addColorStop(0.5, '#1d1712');
    g.addColorStop(1, '#120d09');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = 'rgba(201,151,59,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cssH * 0.14); ctx.lineTo(cssW, cssH * 0.14);
    ctx.moveTo(0, cssH * 0.92); ctx.lineTo(cssW, cssH * 0.92);
    ctx.stroke();
    // streaming seam ticks for motion
    ctx.fillStyle = 'rgba(201,151,59,0.18)';
    for (let i = 0; i < 5; i++) {
      const sx = ((i / 5 + (t * 0.35)) % 1) * cssW;
      ctx.fillRect(cssW - sx, cssH * 0.16, 2, cssH * 0.74);
    }
    if (script) script(ctx, cssW, cssH, p, t, env);
    else { // generic fallback: icon-less volley
      SCRIPTS.damage(ctx, cssW, cssH, p, t, env);
    }
  }
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
