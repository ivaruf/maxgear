// Camera, perspective projection, background/road, and frame orchestration.
// project() is the ONLY way world coords become screen coords — see DESIGN.md.
//
// Visual layers (FX agent owns everything except project/createView/resizeView/
// updateCamera and the entity draw order in render()):
//   drawBackground  baked sky sprite (gradient + stars + banded sun + haze +
//                   ground) -> live twinkle + sun bloom -> baked parallax ridge
//   drawRoad        body gradient, z-anchored checker bands, sun reflection
//                   streak, lane stripes, pulsing neon edges, streaming pylons
//   drawForeground  runSpeed-scaled speed lines + vignette (after entities)
// Everything expensive is baked once per resize into offscreen canvases / cached
// gradients; the per-frame path only strokes/fills a few dozen primitives.

import { ROAD_HALF, VIEW_DEPTH, FOCAL, CAM_BACK, BASE_RUN_SPEED } from './config.js';
import { drawEnemies } from './enemies.js';
import { drawGates } from './gates.js';
import { drawObstacles } from './obstacles.js';
import { drawPickups } from './pickups.js';
import { drawPlayer } from './player.js';
import { drawProjectiles, drawEnemyShots } from './projectiles.js';

export function createView(canvas) {
  const view = {
    canvas,
    ctx: canvas.getContext('2d'),
    W: 0, H: 0, dpr: 1,
    unitScale: 1,        // world x-units -> pixels at f = 1
    vScale: 1,           // z compression -> pixels
    bottomY: 0,          // screen y of dz = 0
    camZ: 0,
    shakeX: 0, shakeY: 0,
  };
  resizeView(view);
  return view;
}

export function resizeView(view) {
  const { canvas } = view;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.W = canvas.clientWidth;
  view.H = canvas.clientHeight;
  view.dpr = dpr;
  canvas.width = Math.round(view.W * dpr);
  canvas.height = Math.round(view.H * dpr);
  view.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Fit the road: ~90% of width on narrow screens, capped by height on wide ones
  view.unitScale = Math.min(view.W / 380, view.H / 430);
  view.bottomY = view.H * 1.04;
  view.vScale = (view.H * 0.74) / FOCAL; // horizon lands around 30% height
}

export function updateCamera(view, game) {
  view.camZ = game.player.z - CAM_BACK;
}

// World (x, z) -> screen {sx, sy, f}. f is the perspective scale factor.
export function project(view, x, z) {
  const dz = Math.max(z - view.camZ, 0);
  const f = FOCAL / (FOCAL + dz);
  return {
    sx: view.W / 2 + view.shakeX + x * f * view.unitScale,
    sy: view.bottomY + view.shakeY - dz * f * view.vScale,
    f,
  };
}

// ---- visual helpers ----------------------------------------------------------

const TAU = Math.PI * 2;
const SIDES = [-1, 1];
const LANES = [-ROAD_HALF / 3, ROAD_HALF / 3];
const RIDGE_PAD = 56;

// Deterministic noise so the sky/skyline is identical every rebuild.
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSprite(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const cx = c.getContext('2d');
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas: c, ctx: cx };
}

// Everything below is rebuilt only when the viewport changes.
const bg = {
  w: 0, h: 0, dpr: 0,
  sky: null,
  ridge: null, ridgeW: 0, ridgeH: 0, ridgeTop: 0,
  horizonY: 0,
  twinkle: [],
  bloom: null, bloomX: 0, bloomY: 0, bloomR: 0,
  roadGrad: null, reflGrad: null, vignette: null,
  fogGrad: null, roadFarY: 0, fogTop: 0, fogH: 0,
  lines: [],
};

function buildSky(view, rng) {
  const { W, H, dpr } = view;
  const hy = bg.horizonY;
  const { canvas, ctx: s } = makeSprite(W, H, dpr);

  // 1. sky gradient (dusk synthwave, warm right above the horizon)
  const sky = s.createLinearGradient(0, 0, 0, H);
  const t = Math.max(0.05, Math.min(0.95, hy / H));
  sky.addColorStop(0, '#080a1c');
  sky.addColorStop(t * 0.35, '#141838');
  sky.addColorStop(t * 0.7, '#2a1c4c');
  sky.addColorStop(t * 0.93, '#5b2455');
  sky.addColorStop(t, '#8c3355');
  sky.addColorStop(Math.min(1, t + 0.001), '#1a1030');
  sky.addColorStop(1, '#07080f');
  s.fillStyle = sky;
  s.fillRect(0, 0, W, H);

  // 2. starfield (baked; a handful are re-drawn live for twinkle)
  const count = Math.max(80, Math.min(220, Math.round((W * H) / 5200)));
  bg.twinkle.length = 0;
  for (let i = 0; i < count; i++) {
    const x = rng() * W;
    const y = rng() * Math.max(4, hy - 6);
    const depth = 1 - y / Math.max(1, hy);       // dimmer toward the horizon haze
    const a = (0.18 + rng() * 0.6) * (0.35 + depth * 0.75);
    const big = rng() < 0.1;
    s.globalAlpha = a;
    s.fillStyle = rng() < 0.22 ? '#bfe6ff' : '#ffffff';
    if (big) {
      const r = 1.1 + rng() * 0.9;
      s.beginPath();
      s.arc(x, y, r, 0, TAU);
      s.fill();
      s.globalAlpha = a * 0.35;
      s.fillRect(x - r * 3, y - 0.4, r * 6, 0.8);
      s.fillRect(x - 0.4, y - r * 3, 0.8, r * 6);
      if (bg.twinkle.length < 16) bg.twinkle.push({ x, y, r, ph: rng() * TAU, rate: 1.1 + rng() * 2.4 });
    } else {
      s.fillRect(x, y, 1, 1);
    }
  }
  s.globalAlpha = 1;

  // 3. ground plane below the horizon (the road is drawn on top of this)
  const gnd = s.createLinearGradient(0, hy, 0, H);
  gnd.addColorStop(0, '#241436');
  gnd.addColorStop(0.35, '#130e26');
  gnd.addColorStop(1, '#07080f');
  s.fillStyle = gnd;
  s.fillRect(0, hy, W, H - hy);

  // 4. banded sun, clipped to the sky side of the horizon
  const R = Math.min(W * 0.17, H * 0.22);
  const sunX = W / 2, sunY = hy - R * 0.34;
  s.save();
  s.beginPath();
  s.rect(0, 0, W, hy);
  s.clip();
  const disc = s.createLinearGradient(0, sunY - R, 0, sunY + R);
  disc.addColorStop(0, '#ffeab0');
  disc.addColorStop(0.42, '#ff9e5e');
  disc.addColorStop(0.78, '#ff5a72');
  disc.addColorStop(1, '#e8397f');
  s.fillStyle = disc;
  s.beginPath();
  s.arc(sunX, sunY, R, 0, TAU);
  s.fill();
  // slits: repaint with the sky gradient so the background shows through
  s.fillStyle = sky;
  let by = sunY - R * 0.1;
  let bh = R * 0.045;
  while (by < sunY + R) {
    s.fillRect(sunX - R - 2, by, R * 2 + 4, bh);
    by += bh + R * 0.135;
    bh *= 1.5;
  }
  // warm bloom over the disc + sky
  const bloom = s.createRadialGradient(sunX, sunY, R * 0.55, sunX, sunY, R * 2.9);
  bloom.addColorStop(0, 'rgba(255,138,90,0.42)');
  bloom.addColorStop(0.45, 'rgba(255,90,110,0.16)');
  bloom.addColorStop(1, 'rgba(255,90,110,0)');
  s.fillStyle = bloom;
  s.fillRect(0, 0, W, hy);
  s.restore();

  // 5. horizon haze band + hot horizon line
  const haze = s.createLinearGradient(0, hy - R * 0.9, 0, hy + R * 0.5);
  haze.addColorStop(0, 'rgba(255,120,120,0)');
  haze.addColorStop(0.55, 'rgba(255,144,120,0.16)');
  haze.addColorStop(0.72, 'rgba(255,190,150,0.22)');
  haze.addColorStop(1, 'rgba(120,60,140,0)');
  s.fillStyle = haze;
  s.fillRect(0, hy - R * 0.9, W, R * 1.4);
  s.fillStyle = 'rgba(255,200,170,0.28)';
  s.fillRect(0, hy - 1, W, 1.6);

  bg.sky = canvas;
  bg.bloomX = sunX; bg.bloomY = sunY; bg.bloomR = R * 3;
}

// Jagged silhouette across the sprite; returns nothing, fills + rims in place.
function ridgeBand(s, rng, w, baseY, minH, maxH, segs, fill, rim) {
  const step = w / segs;
  s.beginPath();
  s.moveTo(-4, baseY);
  for (let i = 0; i <= segs; i++) {
    const x = i * step;
    const h = minH + rng() * (maxH - minH);
    s.lineTo(x - step * 0.5, baseY - h * (0.45 + rng() * 0.2));
    s.lineTo(x, baseY - h);
  }
  s.lineTo(w + 4, baseY);
  s.closePath();
  s.fillStyle = fill;
  s.fill();
  s.strokeStyle = rim;
  s.lineWidth = 1.4;
  s.stroke();
}

function skylineCluster(s, rng, x0, w, baseY, maxH, neon) {
  let x = x0;
  while (x < x0 + w) {
    const bw = 9 + rng() * 26;
    const bh = maxH * (0.25 + rng() * 0.75);
    s.fillStyle = '#0c0a1c';
    s.fillRect(x, baseY - bh, bw, bh);
    s.fillStyle = neon;
    s.globalAlpha = 0.55;
    s.fillRect(x, baseY - bh, bw, 1.5);
    s.globalAlpha = 0.4;
    s.fillRect(x, baseY - bh, 1, bh);
    s.globalAlpha = 1;
    // window lights
    s.fillStyle = 'rgba(255,214,150,0.42)';
    for (let wy = baseY - bh + 5; wy < baseY - 3; wy += 5) {
      for (let wx = x + 2; wx < x + bw - 2; wx += 4) {
        if (rng() < 0.32) s.fillRect(wx, wy, 1.6, 2);
      }
    }
    if (rng() < 0.3) {                       // antenna + beacon
      s.strokeStyle = 'rgba(180,200,255,0.35)';
      s.lineWidth = 1;
      s.beginPath();
      s.moveTo(x + bw * 0.5, baseY - bh);
      s.lineTo(x + bw * 0.5, baseY - bh - 8 - rng() * 14);
      s.stroke();
      s.fillStyle = 'rgba(255,80,90,0.8)';
      s.fillRect(x + bw * 0.5 - 1, baseY - bh - 10 - rng() * 8, 2, 2);
    }
    x += bw + 2 + rng() * 7;
  }
}

function buildRidge(view, rng) {
  const { H, dpr } = view;
  bg.ridgeH = Math.min(H * 0.28, 220);
  bg.ridgeW = view.W + RIDGE_PAD * 2;
  bg.ridgeTop = bg.horizonY - bg.ridgeH + 2;
  const { canvas, ctx: s } = makeSprite(bg.ridgeW, bg.ridgeH, dpr);
  const baseY = bg.ridgeH - 2;

  // far mountains
  s.globalAlpha = 0.9;
  ridgeBand(s, rng, bg.ridgeW, baseY, bg.ridgeH * 0.22, bg.ridgeH * 0.62, 13,
    '#2b2050', 'rgba(255,116,180,0.30)');
  s.globalAlpha = 1;
  // city clusters sit between the two ridges
  skylineCluster(s, rng, bg.ridgeW * 0.06, bg.ridgeW * 0.2, baseY, bg.ridgeH * 0.5, '#35e0ff');
  skylineCluster(s, rng, bg.ridgeW * 0.68, bg.ridgeW * 0.26, baseY, bg.ridgeH * 0.44, '#ff5fd2');
  // near mountains
  ridgeBand(s, rng, bg.ridgeW, baseY, bg.ridgeH * 0.12, bg.ridgeH * 0.34, 19,
    '#120d26', 'rgba(53,224,255,0.22)');

  bg.ridge = canvas;
}

function buildSpeedLines(view, rng) {
  bg.lines.length = 0;
  for (let i = 0; i < 18; i++) {
    // two fans (left / right) so streaks never cross the play area
    const side = i % 2 === 0 ? 0 : Math.PI;
    const a = side + (rng() - 0.5) * 1.9;
    bg.lines.push({
      cos: Math.cos(a), sin: Math.sin(a),
      off: rng(), len: 40 + rng() * 90, a: 0.05 + rng() * 0.09,
    });
  }
}

function ensureBackground(ctx, view) {
  if (bg.sky && bg.w === view.W && bg.h === view.H && bg.dpr === view.dpr) return;
  bg.w = view.W; bg.h = view.H; bg.dpr = view.dpr;

  // Horizon is camera-independent (dz is measured from camZ); strip shake out.
  bg.horizonY = project(view, 0, view.camZ + VIEW_DEPTH * 4).sy - view.shakeY;

  const rng = mulberry32(0x5eed1a);
  buildSky(view, rng);
  buildRidge(view, rng);
  buildSpeedLines(view, rng);

  // cached gradients (main-context user space, CSS px)
  const road = ctx.createLinearGradient(0, bg.horizonY, 0, view.bottomY);
  road.addColorStop(0, '#0e1122');
  road.addColorStop(0.35, '#171c30');
  road.addColorStop(1, '#20263f');
  bg.roadGrad = road;

  // The road ribbon ends at VIEW_DEPTH, well short of the horizon; both the
  // reflection streak and the distance haze are keyed to that screen row.
  bg.roadFarY = project(view, 0, view.camZ + VIEW_DEPTH).sy - view.shakeY;

  const refl = ctx.createLinearGradient(0, bg.roadFarY, 0, view.bottomY);
  refl.addColorStop(0, 'rgba(255,170,110,0.34)');
  refl.addColorStop(0.4, 'rgba(255,120,120,0.13)');
  refl.addColorStop(1, 'rgba(255,110,120,0)');
  bg.reflGrad = refl;

  const vig = ctx.createRadialGradient(view.W / 2, view.H * 0.56, Math.min(view.W, view.H) * 0.34,
    view.W / 2, view.H * 0.56, Math.hypot(view.W, view.H) * 0.62);
  vig.addColorStop(0, 'rgba(3,4,12,0)');
  vig.addColorStop(0.6, 'rgba(3,4,12,0.18)');
  vig.addColorStop(1, 'rgba(3,4,12,0.62)');
  bg.vignette = vig;

  // Distance haze: hides the hard cut where the road ribbon ends at VIEW_DEPTH.
  // Tinted to match the baked ground gradient, so it is invisible off-road.
  bg.fogTop = bg.roadFarY - 24;
  bg.fogH = Math.max(60, (view.bottomY - bg.roadFarY) * 0.38);
  const fog = ctx.createLinearGradient(0, bg.fogTop, 0, bg.fogTop + bg.fogH);
  fog.addColorStop(0, 'rgba(28,17,46,0.96)');
  fog.addColorStop(0.45, 'rgba(28,17,46,0.45)');
  fog.addColorStop(1, 'rgba(28,17,46,0)');
  bg.fogGrad = fog;

  const bloom = ctx.createRadialGradient(bg.bloomX, bg.bloomY, 0, bg.bloomX, bg.bloomY, bg.bloomR);
  bloom.addColorStop(0, 'rgba(255,150,96,0.55)');
  bloom.addColorStop(0.4, 'rgba(255,96,120,0.18)');
  bloom.addColorStop(1, 'rgba(255,96,120,0)');
  bg.bloom = bloom;
}

function drawBackground(ctx, view, game, now) {
  const { W, H } = view;
  ensureBackground(ctx, view);

  ctx.drawImage(bg.sky, 0, 0, W, H);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // live star twinkle (16 sprites max)
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < bg.twinkle.length; i++) {
    const s = bg.twinkle[i];
    const a = 0.25 + 0.55 * Math.abs(Math.sin(now * s.rate + s.ph));
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (0.75 + a * 0.5), 0, TAU);
    ctx.fill();
  }
  // breathing sun bloom
  ctx.globalAlpha = 0.1 + 0.05 * Math.sin(now * 1.3);
  ctx.fillStyle = bg.bloom;
  ctx.fillRect(bg.bloomX - bg.bloomR, bg.bloomY - bg.bloomR, bg.bloomR * 2, bg.bloomR * 2);
  ctx.restore();

  // parallax silhouettes: distant layers barely react to camera shake
  ctx.drawImage(bg.ridge,
    -RIDGE_PAD - view.shakeX * 0.35, bg.ridgeTop - view.shakeY * 0.25,
    bg.ridgeW, bg.ridgeH);
}

// Reusable road sampling buffers (no per-frame allocation).
const STEPS = 24;
const rLX = new Float64Array(STEPS + 1);
const rLY = new Float64Array(STEPS + 1);
const rRX = new Float64Array(STEPS + 1);
const rRY = new Float64Array(STEPS + 1);

function drawRoad(ctx, view, game, now) {
  const uS = view.unitScale;
  ctx.save();                            // never leak road state into entities

  for (let i = 0; i <= STEPS; i++) {
    const z = view.camZ + (i / STEPS) * VIEW_DEPTH;
    const L = project(view, -ROAD_HALF, z);
    const R = project(view, ROAD_HALF, z);
    rLX[i] = L.sx; rLY[i] = L.sy;
    rRX[i] = R.sx; rRY[i] = R.sy;
  }

  // ---- body ---------------------------------------------------------------
  const body = new Path2D();
  body.moveTo(rLX[0], rLY[0]);
  for (let i = 0; i <= STEPS; i++) body.lineTo(rLX[i], rLY[i]);
  for (let i = STEPS; i >= 0; i--) body.lineTo(rRX[i], rRY[i]);
  body.closePath();
  ctx.fillStyle = bg.roadGrad;
  ctx.fill(body);

  ctx.save();
  ctx.clip(body);

  // ---- z-anchored checker bands (start-line texture, deliberately faint) ---
  const BAND_GAP = 520, BAND_DEPTH = 30, CELLS = 8, CELL_W = (ROAD_HALF * 2) / CELLS;
  const firstBand = Math.floor(view.camZ / BAND_GAP) * BAND_GAP;
  for (let z = firstBand; z < view.camZ + VIEW_DEPTH * 0.8; z += BAND_GAP) {
    const n = project(view, 0, z);
    const fr = project(view, 0, z + BAND_DEPTH);
    if (n.f < 0.05) continue;
    const kn = n.f * uS, kf = fr.f * uS;
    const parity = Math.round(z / BAND_GAP) & 1;
    ctx.fillStyle = '#9fe9ff';
    for (let c = 0; c < CELLS; c++) {
      if (((c + parity) & 1) === 0) continue;
      const x0 = -ROAD_HALF + c * CELL_W, x1 = x0 + CELL_W;
      ctx.globalAlpha = 0.05 + 0.03 * n.f;
      ctx.beginPath();
      ctx.moveTo(n.sx + x0 * kn, n.sy);
      ctx.lineTo(n.sx + x1 * kn, n.sy);
      ctx.lineTo(fr.sx + x1 * kf, fr.sy);
      ctx.lineTo(fr.sx + x0 * kf, fr.sy);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // ---- sun reflection streak (world-space band, so it tapers naturally) ---
  {
    const REFL_HALF = 54;
    const near = project(view, 0, view.camZ + 40);
    const far = project(view, 0, view.camZ + VIEW_DEPTH * 0.92);
    const kn = near.f * uS, kf = far.f * uS;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = bg.reflGrad;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(near.sx - REFL_HALF * kn, near.sy);
    ctx.lineTo(near.sx + REFL_HALF * kn, near.sy);
    ctx.lineTo(far.sx + REFL_HALF * kf, far.sy);
    ctx.lineTo(far.sx - REFL_HALF * kf, far.sy);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // ---- scrolling lane stripes (world-anchored so they stream past) --------
  const STRIPE_GAP = 140, STRIPE_LEN = 60;
  ctx.lineCap = 'butt';
  for (const laneX of LANES) {
    const first = Math.floor(view.camZ / STRIPE_GAP) * STRIPE_GAP;
    for (let z = first; z < view.camZ + VIEW_DEPTH; z += STRIPE_GAP) {
      const a = project(view, laneX, z);
      const b = project(view, laneX, z + STRIPE_LEN);
      if (a.f < 0.04) continue;
      ctx.strokeStyle = 'rgba(214,240,255,0.20)';
      ctx.globalAlpha = 0.35 + a.f * 0.65;
      ctx.lineWidth = 4 * a.f;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // ---- neon edges with a slow glow pulse ---------------------------------
  const pulse = 0.62 + 0.22 * Math.sin(now * 2.2);
  ctx.lineCap = 'round';
  for (const side of SIDES) {
    const xs = side < 0 ? rLX : rRX;
    const ys = side < 0 ? rLY : rRY;
    const edge = new Path2D();
    edge.moveTo(xs[0], ys[0]);
    for (let i = 1; i <= STEPS; i++) edge.lineTo(xs[i], ys[i]);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(53,224,255,0.16)';
    ctx.lineWidth = 11;
    ctx.stroke(edge);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(120,240,255,${pulse.toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.stroke(edge);
  }

  drawPylons(ctx, view, now);

  // distance haze over the far end of the ribbon (entities stay crisp)
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg.fogGrad;
  ctx.fillRect(0, bg.fogTop, view.W, bg.fogH);

  ctx.restore();
}

// Light posts just outside the road, world-anchored so they read as speed.
const PYLON_GAP = 260, PYLON_X = ROAD_HALF + 24, PYLON_H = 82, PYLON_ARM = 22;
function drawPylons(ctx, view, now) {
  const uS = view.unitScale;
  const first = Math.floor(view.camZ / PYLON_GAP) * PYLON_GAP;
  const last = view.camZ + VIEW_DEPTH;
  // far -> near so nearby posts overlap distant ones correctly
  for (let z = Math.floor(last / PYLON_GAP) * PYLON_GAP; z >= first; z -= PYLON_GAP) {
    const idx = Math.round(z / PYLON_GAP);
    const warm = (idx & 1) === 1;
    const lamp = warm ? '#ff6ad5' : '#5cf0ff';
    for (const side of SIDES) {
      const b = project(view, side * PYLON_X, z);
      if (b.f < 0.045) continue;
      const k = b.f * uS;
      const topY = b.sy - PYLON_H * k;
      const w = Math.max(1, 5 * k);
      const armX = b.sx - side * PYLON_ARM * k;

      // pool of light spilling onto the road edge
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.1 + 0.05 * Math.sin(now * 1.7 + idx);
      ctx.fillStyle = lamp;
      ctx.beginPath();
      ctx.ellipse(armX, b.sy, 52 * k, 13 * k, 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      // post + arm
      ctx.fillStyle = '#191233';
      ctx.fillRect(b.sx - w / 2, topY, w, PYLON_H * k);
      ctx.fillStyle = 'rgba(120,240,255,0.22)';
      ctx.fillRect(b.sx - w / 2, topY, Math.max(0.6, w * 0.3), PYLON_H * k);
      ctx.strokeStyle = '#191233';
      ctx.lineWidth = Math.max(1, 3 * k);
      ctx.beginPath();
      ctx.moveTo(b.sx, topY + w);
      ctx.lineTo(armX, topY + w);
      ctx.stroke();

      // lamp head + halo
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = lamp;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(armX, topY + w, Math.max(1, 4.5 * k), 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.arc(armX, topY + w, Math.max(2, 14 * k), 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
}

// Speed streaks radiating from the vanishing point + framing vignette.
function drawForeground(ctx, view, game, now) {
  const { W, H } = view;
  ctx.save();
  const moving = game.state === 'playing' ? (game.runSpeed || 0) : 0;
  const intensity = Math.min(1.15, moving / BASE_RUN_SPEED);

  if (intensity > 0.03) {
    const cx = W / 2 + view.shakeX * 0.5;
    const cy = bg.horizonY + view.shakeY * 0.5;
    const diag = Math.hypot(W, H);
    const r0 = diag * 0.33, span = diag * 0.72;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#cfefff';
    for (let i = 0; i < bg.lines.length; i++) {
      const l = bg.lines[i];
      const u = (((view.camZ * 0.00135 + l.off) % 1) + 1) % 1;
      const r = r0 + u * span;
      const len = l.len * (0.35 + intensity * 0.95);
      ctx.globalAlpha = l.a * intensity * Math.sin(u * Math.PI);
      ctx.lineWidth = 1 + intensity * 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + l.cos * r, cy + l.sin * r);
      ctx.lineTo(cx + l.cos * (r + len), cy + l.sin * (r + len));
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.fillStyle = bg.vignette;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

export function render(ctx, view, game, fx) {
  view.shakeX = fx.getShakeX();
  view.shakeY = fx.getShakeY();
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;

  drawBackground(ctx, view, game, now);
  drawRoad(ctx, view, game, now);

  // Painter's algorithm: farthest entities first
  drawGates(ctx, view, game);
  drawObstacles(ctx, view, game);
  drawPickups(ctx, view, game);
  drawEnemies(ctx, view, game);
  drawEnemyShots(ctx, view, game);
  drawPlayer(ctx, view, game);
  drawProjectiles(ctx, view, game);

  drawForeground(ctx, view, game, now);
  fx.draw(ctx, view);
}
