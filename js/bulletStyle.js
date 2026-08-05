// Bespoke player-bullet styling (v1.2, VISUAL DESIGN §C).
//
// LEAF MODULE. It imports utils.js and nothing else — in particular NOT render.js
// (it keeps a local makeSprite copy) — so it stays importable in Node / a worker.
// Every DOM touch is behind canDraw(); headless, sprites stay null and consumers
// fall back to the legacy ellipse path.
//
// What this module is: `stats` in, one immutable-per-recompute *style* out, plus a
// pair of small offscreen sprites baked lazily per view (dpr / reference size).
// Bullets are TINY (2.4px far → ~22px 4K-near), so the read order is
//   tier-1  silhouette aspect (rx/ry) + hue + glow + trail        (reads at 5px)
//   tier-2  bands / fins / fuse / reticle                          (pays at >=7px)
//
// HARD INVARIANTS
//  1. HITBOX IS SACRED. style.rx/ry are cosmetic only and never touch p.radius.
//  2. HUE CLAMP. Player fire is cyan-family: hue is a cyan-anchored weighted
//     circular mean, then hard-clamped to 190° ± 58°. Gold (44°) is unreachable
//     by anything except the crit sub-style, so a crit can never be confused with
//     a hot-damage build.
//  3. NO Date.now(). Every animated input is a `t` argument (game.time).
//  4. No per-frame allocation: colour strings are built once per recompute,
//     canvases are allocated once per style object and redrawn in place.
//
// Style lifetime (player.js owns it, Stage B):
//   createPlayer:  p.styles = createStyleSet(); p.bulletStyle = p.styles.slots[0];
//                  p.styleFrom = {};
//   updatePlayer:  if (!sameWeaponStats(stats, p.styleFrom)) {
//                    snapshotWeaponStats(stats, p.styleFrom);
//                    const next = p.styles.slots[p.styles.cur ^= 1];
//                    computeBulletStyle(stats, next);
//                    p.bulletStyle = next;                  // double buffer:
//                  }                                        // in-flight bullets
//   fireVolley:    proj.style = game.player.bulletStyle || BASE_STYLE;
//   drawProjectiles: ensureBulletSprites(style, view) once per style per frame.
//
// STYLE SCHEMA (everything Stage B may read; * = derived extra beyond design §C)
//   geometry   rx, ry                cosmetic half-extents, multiples of `dr`
//              coreShape             0 ellipse | 1 needle | 2 cog (reserved) | 3 orb+band
//   colour     core, coreHi, glow, spark   hsl() strings (crit: gold hex)
//              edge                  ink rim colour or null
//              glowA                 0.15..1 aura alpha (multishot dims it)
//              hue*                  numeric hue of `core`, always inside 190+-58
//   detail     bandN 0..3, fins 0..1, nose 0..1, trail 0..1.2, fuse 0..1,
//              glints 1..2, glintR, spin (rad/s), crackle 0..1
//   slots      arcs 0..2 (live nose bolts), halo 0..1 (homing reticle),
//              status 0 none | 1 burn | 2 frost, statusM* 0..1, statusRim* colour|null,
//              orbitTrail 0..1 (aux/orbital hint), warm* glow->EMBER lerp amount
//   sprites    body, aura            offscreen canvases (null => legacy fallback)
//              bodyCx/bodyCy/bodyW/bodyH*, auraCx/auraCy/auraW/auraH*   CSS px
//              ref, bakedDpr, bakedRef   bake state (bakedDpr -1 = bake failed)
//   live       liveFeatures[0..3], liveMags*[] (parallel magnitudes)
//   crit       full sub-style, crit.crit === crit
//
// Blit contract, with s = dr / style.ref  (dr = the projected draw radius):
//   pass1 'lighter':   drawImage(aura, sx - auraCx*s, sy - auraCy*s, auraW*s, auraH*s)
//   pass2 source-over: drawImage(body, sx - bodyCx*s, sy - bodyCy*s, bodyW*s, bodyH*s)
//   pass3 'lighter':   for (i) liveFeatures[i].live(ctx, p, st, liveMags[i], game.time)
// The body hotspot is the sprite centre; the aura hotspot is off-centre because the
// trail hangs behind the slug.

import { clamp, lerp } from './utils.js';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

// ---- materials (mirrors DESIGN.md / icons.js MAT) ---------------------------
const INK = 'rgba(10,8,5,0.85)';
const BRASS = '#c9973b';
const BRASS_HI = '#f0b429';
const EMBER = '#ff8a5a';          // burn / blast warmth
const FROST = '#9fe8ff';          // frost rim
const GOLD = '#ffd166';           // crit core
const GOLD_HI = '#fff3d6';
const GOLD_GLOW = '#ffb347';

// Hue law. 190° = aether cyan.
const HUE_ANCHOR = 190;
// 40 keeps the warm-most reachable hue at 150° (teal): hue 132 (from a ±58
// clamp) collided with the good-gate/heal green family — a semantic hazard.
const HUE_CLAMP = 40;

// Cosmetic geometry guards (keep baked sprites bounded).
const RX_MIN = 0.5, RX_MAX = 2.0;
const RY_MIN = 1.5, RY_MAX = 5.0;
const MAX_LIVE = 3;               // live features per style (budget, design §C)
const REF_MAX = 96;               // px: hard cap on the bake reference radius
const TRAIL_Y0 = 0.7;             // trail starts at 0.7*ry (just inside the tail)

// Weapon-stat fields that can change the look. spreadDeg is derived from
// projectiles, so it is deliberately NOT compared.
const WEAPON_FIELDS = [
  'damage', 'fireInterval', 'projectiles', 'lance', 'chainJumps',
  'blastR', 'blastFrac', 'burnDps', 'frostSlow', 'homing',
  'critChance', 'critMul', 'auxLv',
];

// ---- tiny colour kit (bake/recompute time only) -----------------------------

function hexv(c) { const v = parseInt(c, 16); return Number.isFinite(v) ? v : 15; }

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; } else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// '#abc' | '#aabbcc' | 'hsl(h, s%, l%)' | 'rgb(a,b,c)' -> [r,g,b]
function parseColor(c) {
  if (typeof c !== 'string' || !c) return [255, 255, 255];
  if (c.charCodeAt(0) === 35) {
    if (c.length >= 7) {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    return [hexv(c[1]) * 17, hexv(c[2]) * 17, hexv(c[3]) * 17];
  }
  const nums = c.match(/-?[\d.]+/g);
  if (!nums || nums.length < 3) return [255, 255, 255];
  if (c[0] === 'h') return hslToRgb(+nums[0], +nums[1] / 100, +nums[2] / 100);
  return [+nums[0], +nums[1], +nums[2]];
}

function hex2(v) {
  const n = clamp(Math.round(v), 0, 255);
  return (n < 16 ? '0' : '') + n.toString(16);
}
function rgbHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }

// Mix two colour strings in sRGB and return '#rrggbb'.
function mixColor(a, b, t) {
  const A = parseColor(a), B = parseColor(b);
  return rgbHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
}

// 'rgba(r,g,b,a)' from any colour string — used for gradient stops at bake time.
function rgba(c, a) {
  const A = parseColor(c);
  return 'rgba(' + Math.round(A[0]) + ',' + Math.round(A[1]) + ',' + Math.round(A[2]) + ','
    + clamp(a, 0, 1).toFixed(3) + ')';
}

function hsl(h, s, l) {
  return 'hsl(' + h.toFixed(1) + ', ' + Math.round(clamp(s, 0, 1) * 100) + '%, '
    + Math.round(clamp(l, 0, 1) * 100) + '%)';
}

// Deterministic noise so a given style bakes byte-identical filigree every time.
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- headless guards + local makeSprite (NO render.js import) ---------------

function canDraw() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

// Local copy of render.js makeSprite (deliberate duplication: keeps this a leaf).
function makeSprite(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const cx = c.getContext ? c.getContext('2d') : null;
  if (!cx) return null;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas: c, ctx: cx };
}

// Allocate once, redraw in place. Returns a cleared, dpr-scaled 2d context.
function ensureCanvas(style, key, w, h, dpr) {
  const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
  let cv = style[key];
  if (!cv) {
    const s = makeSprite(w, h, dpr);
    if (!s) return null;
    style[key] = s.canvas;
    return s.ctx;
  }
  const g = cv.getContext ? cv.getContext('2d') : null;
  if (!g) return null;
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw; cv.height = bh;              // resizing also clears
  } else {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, bw, bh);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

// ---- geometry helpers -------------------------------------------------------

// Bomb orb radius (shared by the path, the band and the fuse anchor).
function orbR(RX, RY) { return Math.min(RX * 1.15, RY * 0.7); }

// Fin tip reach as a multiple of RX (must match lance.paintBody, or the body
// sprite would clip the fins).
function finReach(fins) { return fins > 0 ? 1 + 0.8 * (0.35 + 0.65 * fins) : 1; }

// coreShape: 0 ellipse | 1 needle | 2 cog (reserved) | 3 orb + band
function corePath(g, shape, RX, RY) {
  g.beginPath();
  if (shape === 1) {                             // needle: sharp nose, finned tail
    g.moveTo(0, -RY);
    g.bezierCurveTo(RX * 0.86, -RY * 0.42, RX, RY * 0.28, RX * 0.44, RY * 0.9);
    g.lineTo(0, RY);
    g.lineTo(-RX * 0.44, RY * 0.9);
    g.bezierCurveTo(-RX, RY * 0.28, -RX * 0.86, -RY * 0.42, 0, -RY);
    g.closePath();
    return;
  }
  if (shape === 3) {                             // boiler bomb: orb + casing tail
    const r = orbR(RX, RY);
    const cy = -RY + r;
    // ONE closed subpath (orb arc + tail flanks). Two subpaths would work for
    // fill(), but stroke() would then draw the tail's top chord straight across
    // the orb — so the silhouette is traced in a single pass instead.
    const wt = r * 0.52, wb = r * 0.34;
    const jy = cy + Math.sqrt(Math.max(0, r * r - wt * wt));   // orb/tail joint
    const ja = Math.atan2(jy - cy, wt);
    g.moveTo(wt, jy);
    g.arc(0, cy, r, ja, Math.PI - ja, true);     // over the top, right -> left
    g.lineTo(-wb, RY);
    g.lineTo(wb, RY);
    g.closePath();
    return;
  }
  if (shape === 2) {                             // cog (reserved): notched ellipse
    const teeth = 6;
    for (let i = 0; i <= teeth * 2; i++) {
      const a = (i / (teeth * 2)) * TAU - Math.PI / 2;
      const k = i % 2 ? 0.82 : 1;
      const x = Math.cos(a) * RX * k, y = Math.sin(a) * RY * k;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    return;
  }
  g.ellipse(0, 0, RX, RY, 0, 0, TAU);            // 0: today's ellipse
}

// Seeded jagged polyline (shared by crackle filigree and live nose bolts).
function jagged(g, x0, y0, x1, y1, segs, amp, phase) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  g.beginPath();
  g.moveTo(x0, y0);
  for (let i = 1; i < segs; i++) {
    const u = i / segs;
    // cheap deterministic wobble; no allocation, no Math.random
    const w = Math.sin(phase + u * 11.7) * 0.6 + Math.sin(phase * 1.7 + u * 23.3) * 0.4;
    const s = Math.sin(u * Math.PI);            // pinned ends
    g.lineTo(x0 + dx * u + nx * w * amp * s, y0 + dy * u + ny * w * amp * s);
  }
  g.lineTo(x1, y1);
  g.stroke();
}

// ---- FEATURE TABLE ---------------------------------------------------------
// { id, hueDeg?, read(stats)->0..1, compute(st, m),
//   paintBody(ctx, st, m, ref)?, paintAura(ctx, st, m, ref)?, live(ctx, p, st, m, t)? }
//
// Order matters: compute() runs top-down (rx multipliers after rx is set, blast's
// orb after lance's needle) and paintBody() hooks run in body-pass order
// (bands -> fins -> fuse). liveFeatures is filled top-down, capped at MAX_LIVE.

export const FEATURES = [
  {
    id: 'damage',
    hueDeg: 34,                                   // ember heat pulls warm...
    read(s) {
      const d = s.damage > 0 ? s.damage : 10;
      return clamp(Math.log2(d / 10) / Math.log2(40), 0, 1);
    },
    compute(st, m) {
      st.rx = 0.9 + 0.55 * m;
      st.bandN = Math.floor(m * 3.99);
      st.nose = Math.max(st.nose, 0.35 + 0.65 * m);
      st.glints = m > 0.6 ? 2 : 1;
      st.glintR = 0.26 + 0.12 * m;
      if (m > 0.25) st.edge = INK;                // heavy slugs get a hard rim
    },
    // brass reinforcing bands, clipped to the core silhouette
    paintBody(g, st, m, ref) {
      const n = st.bandN;
      if (!n || ref < 7) return;
      const RX = st.rx * ref, RY = st.ry * ref;
      g.save();
      corePath(g, st.coreShape, RX, RY);
      g.clip();
      const h = Math.max(0.9, ref * 0.13);
      for (let i = 0; i < n; i++) {
        const y = RY * (-0.34 + (n === 1 ? 0.34 : (i / (n - 1)) * 0.78));
        g.fillStyle = BRASS;
        g.globalAlpha = 0.85;
        g.fillRect(-RX * 1.2, y - h * 0.5, RX * 2.4, h);
        g.fillStyle = BRASS_HI;
        g.globalAlpha = 0.55;
        g.fillRect(-RX * 1.2, y - h * 0.5, RX * 2.4, Math.max(0.5, h * 0.34));
      }
      g.globalAlpha = 1;
      g.restore();
    },
  },
  {
    id: 'fireRate',
    hueDeg: 200,
    read(s) {
      const fi = s.fireInterval > 0 ? s.fireInterval : 0.32;
      return clamp((0.32 - fi) / 0.25, 0, 1);
    },
    compute(st, m) {
      st.trail = 0.25 + 0.75 * m;                 // longer streak = faster gun
      st.rx *= 1 - 0.18 * m;                      // and a thinner slug
    },
  },
  {
    id: 'lance',
    hueDeg: 178,
    read(s) { return clamp((s.lance || 0) / 6, 0, 1); },
    compute(st, m) {
      st.ry = 2.2 * (1 + 0.9 * m);
      if (m > 0) { st.coreShape = 1; st.fins = m; st.nose = Math.max(st.nose, 0.6 + 0.4 * m); }
    },
    // swept tail fins
    paintBody(g, st, m, ref) {
      if (!st.fins || ref < 7) return;
      const RX = st.rx * ref, RY = st.ry * ref;
      const reach = finReach(st.fins);
      g.fillStyle = BRASS;
      g.strokeStyle = INK;
      g.lineWidth = Math.max(0.5, ref * 0.06);
      for (let s = -1; s <= 1; s += 2) {
        g.beginPath();
        g.moveTo(s * RX * 0.42, RY * 0.3);
        g.lineTo(s * RX * reach, RY * 0.96);
        g.lineTo(s * RX * 0.3, RY * 0.99);
        g.closePath();
        g.fill();
        if (ref >= 10) g.stroke();
      }
    },
  },
  {
    id: 'arc',
    hueDeg: 205,
    read(s) { return clamp((s.chainJumps || 0) / 6, 0, 1); },
    compute(st, m) {
      if (m <= 0) return;
      st.arcs = m > 0.5 ? 2 : 1;                  // live nose bolts
      st.crackle = Math.max(st.crackle, 0.35 + 0.65 * m);
    },
    // forked filaments hugging the slug (baked, additive-intended)
    paintAura(g, st, m, ref) {
      if (m <= 0) return;
      const RX = st.rx * ref, RY = st.ry * ref;
      const rng = mulberry32(0x7e51a + Math.round(m * 97));
      g.strokeStyle = rgba(st.spark, 0.5 * st.glowA);
      g.lineWidth = Math.max(0.6, ref * 0.07);
      const n = 2 + (m > 0.6 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = rng() * TAU;
        const r0 = RX * 0.9, r1 = RX * (1.5 + rng() * 0.9);
        jagged(g, Math.cos(a) * r0, Math.sin(a) * r0 * (RY / RX) * 0.35,
          Math.cos(a) * r1, Math.sin(a) * r1 * (RY / RX) * 0.5,
          4, ref * 0.22, rng() * 6.283);
      }
    },
    // 1-2 jagged bolts flicking off the nose (screen space, t = game.time)
    live(g, p, st, m, t) {
      const dr = p.dr;
      if (!(dr > 0) || !st.arcs) return;
      if (!Number.isFinite(p.sx) || !Number.isFinite(p.sy)) return;
      const noseY = p.sy - st.ry * dr * 0.85;
      const seed = p.x * 0.017 + p.z * 0.0031;
      g.strokeStyle = st.spark;
      g.lineWidth = Math.max(0.7, dr * 0.13);
      for (let i = 0; i < st.arcs; i++) {
        const ph = t * 11 + seed * 6.283 + i * 2.4;
        const flick = Math.sin(ph * 1.9);
        if (flick < -0.15) continue;               // gaps read as arcing
        const a = -Math.PI / 2 + (i ? 0.85 : -0.85) + Math.sin(ph) * 0.55;
        const len = dr * (1.5 + 0.9 * Math.abs(Math.cos(ph * 0.7)));
        g.globalAlpha = 0.45 + 0.45 * Math.abs(flick);
        jagged(g, p.sx, noseY, p.sx + Math.cos(a) * len, noseY + Math.sin(a) * len,
          3, dr * 0.42, ph);
      }
      g.globalAlpha = 1;
    },
  },
  {
    id: 'blast',
    hueDeg: 18,
    read(s) { return clamp((s.blastR || 0) / 220, 0, 1); },
    compute(st, m) {
      if (m <= 0) return;
      st.coreShape = 3;                            // orb + band beats the needle
      st.fuse = 0.4 + 0.6 * m;
      st.warm = 0.22;                              // glow lerps toward EMBER
      st.bandN = Math.max(st.bandN, 1);
    },
    // brass equator band + fuse stub with an ember pip
    paintBody(g, st, m, ref) {
      if (!st.fuse || ref < 7) return;
      const RX = st.rx * ref, RY = st.ry * ref;
      const r = orbR(RX, RY);
      const cy = -RY + r;
      g.save();
      corePath(g, st.coreShape, RX, RY);
      g.clip();
      g.fillStyle = BRASS;
      g.globalAlpha = 0.9;
      g.fillRect(-r * 1.2, cy - r * 0.14, r * 2.4, Math.max(1, r * 0.28));
      g.fillStyle = BRASS_HI;
      g.globalAlpha = 0.6;
      g.fillRect(-r * 1.2, cy - r * 0.14, r * 2.4, Math.max(0.5, r * 0.1));
      g.restore();
      g.globalAlpha = 1;
      const fx0 = 0, fy0 = cy - r * 0.95;
      const fx1 = r * 0.55, fy1 = fy0 - r * (0.5 + 0.55 * st.fuse);
      g.strokeStyle = BRASS_HI;
      g.lineWidth = Math.max(0.7, ref * 0.08);
      g.beginPath();
      g.moveTo(fx0, fy0);
      g.quadraticCurveTo(fx1 * 0.4, fy0 - r * 0.45, fx1, fy1);
      g.stroke();
      g.fillStyle = EMBER;
      g.beginPath();
      g.arc(fx1, fy1, Math.max(0.8, ref * 0.11), 0, TAU);
      g.fill();
    },
    // the fuse spark breathes (t = game.time)
    live(g, p, st, m, t) {
      const dr = p.dr;
      if (!(dr > 0) || !st.fuse) return;
      if (!Number.isFinite(p.sx) || !Number.isFinite(p.sy)) return;
      const RY = st.ry * dr;
      const r = Math.min(st.rx * dr * 1.15, RY * 0.7);
      const y = p.sy - RY + r - r * (1.45 + 0.55 * st.fuse);
      const k = 0.55 + 0.45 * Math.sin(t * 17 + p.x * 0.05);
      g.globalAlpha = 0.6 * k;
      g.fillStyle = EMBER;
      g.beginPath();
      g.arc(p.sx + r * 0.55, y, Math.max(0.8, dr * 0.3 * k), 0, TAU);
      g.fill();
      g.globalAlpha = 1;
    },
  },
  {
    id: 'homing',
    read(s) { return clamp((s.homing || 0) / 18, 0, 1); },
    compute(st, m) {
      if (m <= 0) return;
      st.halo = 0.4 + 0.6 * m;
      st.spin = 1.4 + 2.2 * m;                     // rad/s, consumed by live()
    },
    // thin gyro reticle ring (rotationally symmetric: the ticks are live)
    paintAura(g, st, m, ref) {
      if (!st.halo) return;
      const R = st.rx * ref * 1.45;
      g.strokeStyle = rgba(st.spark, 0.4 * st.halo * st.glowA);
      g.lineWidth = Math.max(0.5, ref * 0.055);
      g.beginPath();
      g.ellipse(0, 0, R, R * 0.92, 0, 0, TAU);
      g.stroke();
    },
    live(g, p, st, m, t) {
      const dr = p.dr;
      if (!(dr > 0) || !st.halo) return;
      if (!Number.isFinite(p.sx) || !Number.isFinite(p.sy)) return;
      const R = st.rx * dr * 1.45;
      const a0 = t * st.spin + p.x * 0.01;
      g.strokeStyle = st.spark;
      g.lineWidth = Math.max(0.6, dr * 0.1);
      g.globalAlpha = 0.5 + 0.3 * st.halo;
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = a0 + i * (TAU / 4);
        const c = Math.cos(a), s = Math.sin(a);
        g.moveTo(p.sx + c * R * 0.78, p.sy + s * R * 0.72);
        g.lineTo(p.sx + c * R * 1.24, p.sy + s * R * 1.14);
      }
      g.stroke();
      g.globalAlpha = 1;
    },
  },
  {
    id: 'crit',
    hueDeg: 44,                                    // gold: pulls, never reaches
    read(s) { return clamp((s.critChance || 0) / 0.6, 0, 1); },
    compute(st, m) {
      st.crackle = Math.max(st.crackle, 0.25 * m); // hair trigger fizzes always
    },
  },
  {
    id: 'multishot',
    read(s) { return clamp(((s.projectiles > 0 ? s.projectiles : 1) - 1) / 5, 0, 1); },
    compute(st, m) {
      st.rx *= 1 - 0.12 * m;                       // anti-blob: thinner...
      st.glowA *= 1 - 0.3 * m;                     // ...and dimmer per bullet
    },
  },
  {
    id: 'burn',
    read(s) { return clamp((s.burnDps || 0) / 90, 0, 1); },
    compute(st, m) {
      if (m > 0 && m > st.statusM) { st.status = 1; st.statusM = m; }
    },
  },
  {
    id: 'frost',
    read(s) { return clamp((s.frostSlow || 0) / 0.65, 0, 1); },
    compute(st, m) {
      if (m > 0 && m > st.statusM) { st.status = 2; st.statusM = m; }
    },
  },
];
Object.freeze(FEATURES);
for (let i = 0; i < FEATURES.length; i++) Object.freeze(FEATURES[i]);

// Normalized magnitudes for the current recompute (module scratch, no alloc).
const MAGS = new Float64Array(FEATURES.length);

// ---- style plumbing --------------------------------------------------------

function resetStyle(st) {
  st.rx = 1; st.ry = 2.2; st.coreShape = 0;
  st.core = '#8df3ff'; st.coreHi = '#e8ffff'; st.edge = null;
  st.glow = '#35e0ff'; st.spark = '#9df3ff'; st.glowA = 0.85;
  st.bandN = 0; st.fins = 0; st.nose = 0.35; st.trail = 0.25; st.fuse = 0;
  st.glints = 1; st.glintR = 0.3; st.spin = 0; st.crackle = 0;
  st.arcs = 0; st.halo = 0; st.status = 0; st.orbitTrail = 0;
  st.statusM = 0; st.statusRim = null; st.warm = 0; st.hue = HUE_ANCHOR;
  if (!st.liveFeatures) st.liveFeatures = [];
  if (!st.liveMags) st.liveMags = [];
  st.liveFeatures.length = 0;
  st.liveMags.length = 0;
  // sprite slots: keep the canvases, invalidate the bake
  if (st.body === undefined) { st.body = null; st.aura = null; }
  st.bodyCx = 0; st.bodyCy = 0; st.bodyW = 0; st.bodyH = 0;
  st.auraCx = 0; st.auraCy = 0; st.auraW = 0; st.auraH = 0;
  st.ref = 0; st.bakedDpr = 0; st.bakedRef = 0;
  return st;
}

/** Two style slots + a cursor. In-flight bullets keep the slot they spawned with. */
export function createStyleSet() {
  return { slots: [{}, {}], cur: 0 };
}

/** True when nothing that changes the bullet look differs between a and b. */
export function sameWeaponStats(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < WEAPON_FIELDS.length; i++) {
    const k = WEAPON_FIELDS[i];
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Copy the look-relevant stat fields into `into` (created if omitted). */
export function snapshotWeaponStats(s, into) {
  const out = into || {};
  if (!s) return out;
  for (let i = 0; i < WEAPON_FIELDS.length; i++) {
    const k = WEAPON_FIELDS[i];
    out[k] = s[k];
  }
  return out;
}

/**
 * stats -> style. Writes into `into` (a slot from createStyleSet) and returns it.
 * Pure computation + string building; sprites are baked later by
 * ensureBulletSprites(). Safe to call headless.
 */
export function computeBulletStyle(stats, into) {
  const st = resetStyle(into || {});
  const s = stats || {};

  // 1. normalize every feature magnitude (NaN-proof)
  for (let i = 0; i < FEATURES.length; i++) {
    const m = FEATURES[i].read(s);
    MAGS[i] = Number.isFinite(m) ? clamp(m, 0, 1) : 0;
  }

  // 2. run the table top-down
  for (let i = 0; i < FEATURES.length; i++) FEATURES[i].compute(st, MAGS[i]);

  // aux/broadside + orbital hint (future slot; recompute trigger today)
  st.orbitTrail = clamp((s.auxLv || 0) / 5, 0, 1);

  // 3. cosmetic clamps (never touches p.radius)
  st.rx = clamp(st.rx, RX_MIN, RX_MAX);
  st.ry = clamp(st.ry, RY_MIN, RY_MAX);
  st.trail = clamp(st.trail, 0, 1.2);
  st.glowA = clamp(st.glowA, 0.15, 1);
  st.crackle = clamp(st.crackle, 0, 1);

  // 4. HUE: cyan-anchored weighted circular mean, then HARD CLAMP
  let cx = Math.cos(HUE_ANCHOR * D2R), cy = Math.sin(HUE_ANCHOR * D2R);
  let total = 1, maxW = 0;
  for (let i = 0; i < FEATURES.length; i++) {
    const hd = FEATURES[i].hueDeg, w = MAGS[i];
    if (!hd || w <= 0) continue;
    cx += Math.cos(hd * D2R) * w;
    cy += Math.sin(hd * D2R) * w;
    total += w;
    if (w > maxW) maxW = w;
  }
  const mean = Math.atan2(cy, cx) / D2R;
  const focus = clamp(Math.hypot(cx, cy) / total, 0, 1);   // mix coherence
  let d = ((mean - HUE_ANCHOR + 540) % 360) - 180;
  const h = HUE_ANCHOR + clamp(d, -HUE_CLAMP, HUE_CLAMP);
  const sat = 0.78 + 0.18 * maxW;
  const light = 0.62 + 0.10 * focus;
  st.hue = h;

  // 5. colour strings — built ONCE per recompute
  st.core = hsl(h, sat, light);
  st.coreHi = hsl(h, sat * 0.72, Math.min(0.97, light + 0.26));
  st.spark = hsl(h, Math.min(1, sat * 0.92), Math.min(0.94, light + 0.14));
  let glow = hsl(h, sat, Math.max(0.3, light - 0.08));
  if (st.warm > 0) glow = mixColor(glow, EMBER, st.warm);   // boiler bomb warmth
  st.glow = glow;
  if (st.status === 1) st.statusRim = mixColor(glow, EMBER, 0.55 + 0.35 * st.statusM);
  else if (st.status === 2) st.statusRim = mixColor(glow, FROST, 0.55 + 0.35 * st.statusM);

  // 6. live features (budget-capped, table order = priority)
  for (let i = 0; i < FEATURES.length && st.liveFeatures.length < MAX_LIVE; i++) {
    const f = FEATURES[i];
    if (!f.live) continue;
    // only if this feature actually left something animatable on the style
    if ((f.id === 'arc' && !st.arcs) || (f.id === 'blast' && !st.fuse)
      || (f.id === 'homing' && !st.halo)) continue;
    st.liveFeatures.push(f);
    st.liveMags.push(MAGS[i]);
  }

  // 7. crit sub-style (LOCKED: gold, starburst, x1.22, crackle 1)
  let c = st.crit;
  if (!c || c === st) { c = {}; st.crit = c; }
  resetStyle(c);
  c.crit = c;                                     // crit.crit === crit (idempotent)
  c.coreShape = st.coreShape;
  c.rx = clamp(st.rx * 1.22, RX_MIN, RX_MAX);
  c.ry = clamp(st.ry * 1.22, RY_MIN, RY_MAX);
  c.bandN = st.bandN; c.fins = st.fins; c.fuse = st.fuse;
  c.glints = st.glints; c.glintR = st.glintR;
  c.arcs = st.arcs; c.halo = st.halo; c.spin = st.spin;
  c.status = st.status; c.statusM = st.statusM; c.orbitTrail = st.orbitTrail;
  c.nose = Math.max(0.75, st.nose);
  c.trail = Math.max(0.6, st.trail);
  c.crackle = 1;
  c.glowA = clamp(st.glowA + 0.3, 0.15, 1);
  c.hue = 44;                                     // gold; the clamp is for players'
  c.core = GOLD; c.coreHi = GOLD_HI;              // non-crit fire only
  c.glow = GOLD_GLOW; c.spark = GOLD_HI;
  c.edge = INK;                                   // gold always gets a dark rim
  c.statusRim = st.statusRim ? mixColor(GOLD_GLOW, st.status === 2 ? FROST : EMBER, 0.5) : null;
  for (let i = 0; i < st.liveFeatures.length; i++) {
    c.liveFeatures.push(st.liveFeatures[i]);
    c.liveMags.push(st.liveMags[i]);
  }
  return st;
}

// ---- baking ----------------------------------------------------------------

function bodyMetrics(st, ref) {
  const RX = st.rx * ref, RY = st.ry * ref;
  const isCrit = st.crit === st;
  // pad for: ink edge + fin tips (finReach) + the fuse stub poking past the nose
  const fuseUp = st.fuse > 0 ? orbR(RX, RY) * 0.96 + ref * 0.2 : 0;
  let hw = RX * finReach(st.fins) + ref * 0.45;
  let hh = RY + ref * 0.4 + fuseUp;
  if (isCrit) { hw = Math.max(hw, RX * 2.1); hh = Math.max(hh, RY * 1.75); }
  st.bodyW = Math.ceil(hw * 2);
  st.bodyH = Math.ceil(hh * 2);
  st.bodyCx = st.bodyW * 0.5;
  st.bodyCy = st.bodyH * 0.5;
}

function auraMetrics(st, ref) {
  const RX = st.rx * ref, RY = st.ry * ref;
  const halo = 1.6 * RX + ref * 0.2;
  const pad = 2 + (st.crackle > 0 || st.arcs > 0 ? ref * 0.5 : 0);
  const hw = Math.max(halo, RX * 1.5, st.halo ? RX * 1.7 : 0) + pad;
  const top = Math.max(halo, RY * 1.1) + pad;
  const bottom = Math.max(halo, TRAIL_Y0 * RY + st.trail * 2.6 * RY) + pad;
  st.auraW = Math.ceil(hw * 2);
  st.auraH = Math.ceil(top + bottom);
  st.auraCx = hw;
  st.auraCy = top;
}

// source-over: core -> highlight -> bands -> fins -> fuse -> nose -> ink edge
function bakeBody(st, ref, dpr) {
  const g = ensureCanvas(st, 'body', st.bodyW, st.bodyH, dpr);
  if (!g) return false;
  const RX = st.rx * ref, RY = st.ry * ref;
  const isCrit = st.crit === st;
  g.save();
  g.translate(st.bodyCx, st.bodyCy);

  // crit only: 4-point starburst BEHIND the slug
  if (isCrit) {
    const sx = RX * 1.95, sy = RY * 1.65;
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(sx, sy));
    gr.addColorStop(0, rgba(GOLD_HI, 0.85));
    gr.addColorStop(0.45, rgba(GOLD, 0.4));
    gr.addColorStop(1, rgba(GOLD, 0));
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(0, -sy);
    g.lineTo(RX * 0.24, -RY * 0.22);
    g.lineTo(sx, 0);
    g.lineTo(RX * 0.24, RY * 0.22);
    g.lineTo(0, sy);
    g.lineTo(-RX * 0.24, RY * 0.22);
    g.lineTo(-sx, 0);
    g.lineTo(-RX * 0.24, -RY * 0.22);
    g.closePath();
    g.fill();
  }

  // core
  const lg = g.createLinearGradient(0, -RY, 0, RY);
  lg.addColorStop(0, st.coreHi);
  lg.addColorStop(0.42, st.core);
  lg.addColorStop(1, st.glow);
  g.fillStyle = lg;
  corePath(g, st.coreShape, RX, RY);
  g.fill();

  // specular highlight(s)
  const hr = Math.max(0.6, st.glintR * RX);
  g.fillStyle = st.coreHi;
  for (let i = 0; i < st.glints; i++) {
    g.globalAlpha = i ? 0.35 : 0.75;
    g.beginPath();
    g.ellipse(-RX * 0.3, -RY * (0.42 - i * 0.5), hr * (i ? 0.7 : 1), hr * 1.5, 0, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;

  // feature detail (bands, fins, fuse) — tier-2, gated on ref inside each hook
  for (let i = 0; i < FEATURES.length; i++) {
    const f = FEATURES[i];
    if (f.paintBody) f.paintBody(g, st, MAG_OF(st, f), ref);
  }

  // hot nose last so the tip always wins the read
  if (st.nose > 0) {
    const ny = -RY * 0.8;
    const nr = Math.max(0.8, RX * 0.75);
    const ng = g.createRadialGradient(0, ny, 0, 0, ny, nr);
    ng.addColorStop(0, rgba(st.coreHi, 0.95 * st.nose));
    ng.addColorStop(1, rgba(st.coreHi, 0));
    g.fillStyle = ng;
    g.beginPath();
    g.arc(0, ny, nr, 0, TAU);
    g.fill();
  }

  // status rim (burn / frost), then the ink edge
  if (st.statusRim) {
    // uniform inset of the whole silhouette (shape-agnostic), lineWidth compensated
    g.save();
    g.scale(0.94, 0.96);
    g.strokeStyle = st.statusRim;
    g.globalAlpha = 0.5 + 0.4 * st.statusM;
    g.lineWidth = Math.max(0.8, ref * 0.13) / 0.95;
    corePath(g, st.coreShape, RX, RY);
    g.stroke();
    g.restore();
  }
  if (st.edge) {
    g.strokeStyle = st.edge;
    g.lineWidth = Math.max(0.7, ref * 0.1);
    corePath(g, st.coreShape, RX, RY);
    g.stroke();
  }
  g.restore();
  return true;
}

// Intended for a 'lighter' blit. The canvas content itself is drawn normally.
function bakeAura(st, ref, dpr) {
  const g = ensureCanvas(st, 'aura', st.auraW, st.auraH, dpr);
  if (!g) return false;
  const RX = st.rx * ref, RY = st.ry * ref;
  g.save();
  g.translate(st.auraCx, st.auraCy);

  // Tapered trail behind the slug (bullets fly "up" the screen). Anchored at the
  // TAIL, not the centre: the body sprite is opaque, so a centre-anchored trail
  // shorter than the body would be invisible.
  const ty = TRAIL_Y0 * RY;
  const trailLen = st.trail * 2.6 * RY;
  if (trailLen > 1) {
    const tg = g.createLinearGradient(0, ty, 0, ty + trailLen);
    tg.addColorStop(0, rgba(st.glow, 0.62 * st.glowA));
    tg.addColorStop(0.35, rgba(st.glow, 0.28 * st.glowA));
    tg.addColorStop(1, rgba(st.glow, 0));
    g.fillStyle = tg;
    g.beginPath();
    g.moveTo(-RX * 0.72, ty);
    g.lineTo(RX * 0.72, ty);
    g.lineTo(RX * 0.1, ty + trailLen);
    g.lineTo(-RX * 0.1, ty + trailLen);
    g.closePath();
    g.fill();
  }

  // radial halo
  const haloR = 1.6 * RX + ref * 0.2;
  const hg = g.createRadialGradient(0, 0, 0, 0, 0, haloR);
  hg.addColorStop(0, rgba(st.coreHi, 0.5 * st.glowA));
  hg.addColorStop(0.4, rgba(st.glow, 0.34 * st.glowA));
  hg.addColorStop(1, rgba(st.glow, 0));
  g.fillStyle = hg;
  g.beginPath();
  g.ellipse(0, 0, haloR, Math.max(haloR, RY * 1.05), 0, 0, TAU);
  g.fill();

  // crackle filigree (crit chance on every bullet; arc pushes it higher)
  if (st.crackle > 0.02 && ref >= 7) {
    const n = Math.round(1 + 3 * st.crackle);
    const rng = mulberry32(0x1d0c + Math.round(st.hue * 13) + n * 7);
    g.strokeStyle = rgba(st.spark, (0.2 + 0.4 * st.crackle) * st.glowA);
    g.lineWidth = Math.max(0.5, ref * 0.055);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const r0 = RX * 0.85, r1 = RX * (1.25 + rng() * 0.7);
      jagged(g, Math.cos(a) * r0, Math.sin(a) * RY * 0.35,
        Math.cos(a) * r1, Math.sin(a) * RY * 0.6, 3, ref * 0.16, rng() * 6.283);
    }
  }

  // feature auras (arc filaments, homing reticle)
  for (let i = 0; i < FEATURES.length; i++) {
    const f = FEATURES[i];
    if (f.paintAura) f.paintAura(g, st, MAG_OF(st, f), ref);
  }
  g.restore();
  return true;
}

// Magnitude a feature "sees" at bake time. MAGS is only valid during a recompute,
// so bakes recover the magnitude from the style fields the feature owns.
function MAG_OF(st, f) {
  switch (f.id) {
    case 'damage': return clamp(st.bandN / 3, 0, 1);
    case 'lance': return st.fins;
    case 'arc': return st.arcs ? (st.arcs > 1 ? 0.8 : 0.4) : 0;
    case 'blast': return st.fuse > 0 ? clamp((st.fuse - 0.4) / 0.6, 0, 1) : 0;
    case 'homing': return st.halo ? clamp((st.halo - 0.4) / 0.6, 0, 1) : 0;
    case 'crit': return st.crackle;
    default: return 0;
  }
}

/**
 * Lazily bake style.body / style.aura for this view. Cheap no-op once baked.
 * Blit contract (Stage B): s = dr / style.ref;
 *   aura: ctx.drawImage(style.aura, sx - style.auraCx*s, sy - style.auraCy*s,
 *                       style.auraW*s, style.auraH*s)     // under 'lighter'
 *   body: same with body/bodyCx/bodyCy/bodyW/bodyH        // source-over
 * Returns the style. Headless / frozen BASE_STYLE: returns untouched (body null).
 */
export function ensureBulletSprites(style, view) {
  if (!style || !view) return style;
  if (Object.isFrozen(style)) return style;        // BASE_STYLE stays legacy
  if (!(style.rx > 0)) return style;               // never computed
  if (style.bakedDpr === -1) return style;         // bake unavailable: no retry storm
  if (!canDraw()) return style;

  const dpr = view.dpr > 0 ? view.dpr : 1;
  const uS = view.unitScale > 0 ? view.unitScale : 1;
  const ref = Math.min(REF_MAX, Math.ceil(Math.max(12, 7 * 0.85 * uS * 0.78)));
  style.ref = ref;

  const drift = style.bakedRef > 0 ? Math.abs(ref - style.bakedRef) / style.bakedRef : 1;
  if (!style.body || !style.aura || style.bakedDpr !== dpr || drift > 0.25) {
    bodyMetrics(style, ref);
    auraMetrics(style, ref);
    const ok = bakeBody(style, ref, dpr) && bakeAura(style, ref, dpr);
    style.bakedDpr = ok ? dpr : -1;                // -1: give up, use the fallback
    style.bakedRef = ok ? ref : 0;
  }

  const c = style.crit;
  if (c && c !== style) ensureBulletSprites(c, view);
  return style;
}

// ---- BASE_STYLE: frozen fallback, approximates today's cyan ellipse ---------

function baseTemplate(core, coreHi, glow, spark, hue) {
  return {
    rx: 1, ry: 2.2, coreShape: 0,
    core, coreHi, edge: null, glow, spark, glowA: 0.85,
    bandN: 0, fins: 0, nose: 0.35, trail: 0.25, fuse: 0,
    glints: 1, glintR: 0.3, spin: 0, crackle: 0,
    arcs: 0, halo: 0, status: 0, statusM: 0, statusRim: null, orbitTrail: 0,
    warm: 0, hue,
    body: null, aura: null,
    bodyCx: 0, bodyCy: 0, bodyW: 0, bodyH: 0,
    auraCx: 0, auraCy: 0, auraW: 0, auraH: 0,
    ref: 0, bakedDpr: 0, bakedRef: 0,
    liveFeatures: [], liveMags: [],
    crit: null,
  };
}

const BASE_CRIT = baseTemplate(GOLD, GOLD_HI, GOLD_GLOW, GOLD_HI, 44);
BASE_CRIT.rx = 1.22; BASE_CRIT.ry = 2.684; BASE_CRIT.trail = 0.6;
BASE_CRIT.crackle = 1; BASE_CRIT.glowA = 1; BASE_CRIT.edge = INK;
BASE_CRIT.crit = BASE_CRIT;                        // crit.crit === crit

export const BASE_STYLE = baseTemplate('#8df3ff', '#e8ffff', '#35e0ff', '#9df3ff', HUE_ANCHOR);
BASE_STYLE.crit = BASE_CRIT;

Object.freeze(BASE_CRIT.liveFeatures);
Object.freeze(BASE_CRIT.liveMags);
Object.freeze(BASE_CRIT);
Object.freeze(BASE_STYLE.liveFeatures);
Object.freeze(BASE_STYLE.liveMags);
Object.freeze(BASE_STYLE);
