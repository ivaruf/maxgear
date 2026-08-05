// Camera, perspective projection, background/road, and frame orchestration.
// project() is the ONLY way world coords become screen coords — see DESIGN.md.
//
// STEAMPUNK dusk re-skin (v1.1). Visual layers (FX agent owns everything except
// project/createView/resizeView/updateCamera and the entity draw order in render()):
//   drawBackground  baked sky sprite (sepia/umber gradient + warm stars + baked
//                   smog + BRASS CLOCK-FACE sun + ground) -> live twinkle and
//                   glow breath -> parallax flying cogs + zeppelins + drifting
//                   smog bands -> baked industrial ridge -> live stack puffs
//   drawRoad        iron plate body, world-anchored riveted plate seams, warm
//                   brass sun-reflection streak, brass edge rails with streaming
//                   rivets, streaming gas-lamp posts / roadside gears on axles
//   drawForeground  runSpeed-scaled steam streaks + warm vignette (after entities)
//
// Two clocks, no Date.now() anywhere:
//   `now` — wall seconds; drives ambience that must keep living on the title and
//           pause screens (star twinkle, glow breath, gas-flame flicker, rail pulse).
//   `mt`  — game.time; freezes with the simulation and drives all MACHINERY
//           (gear rotation, zeppelin drift, smokestack puffs) per DESIGN.md.
// Everything expensive is baked once per resize into offscreen canvases / cached
// gradients; the per-frame path only strokes/fills a few dozen primitives and
// blits a handful of small sprites (alpha/offset/rotation are the only live data).

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

// Steampunk material palette (environment only — gameplay hexes live in their
// own modules and are NOT touched here).
const IRON = '#171310';
const IRON_DARK = '#120f0c';
const COAL = '#0d0a08';
const BRASS = '#c9973b';
const RIVET = '#d8ac63';
const FLAME = '#ffd9a0';

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

// Gear outline (teeth ring) as a closed path in the given context. Baked only.
function gearPath(s, cx, cy, R, teeth, depth) {
  const rIn = R * (1 - depth);
  const step = TAU / teeth;
  s.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const a1 = a + step * 0.13, a2 = a + step * 0.37, a3 = a + step * 0.5;
    const x0 = cx + Math.cos(a) * rIn, y0 = cy + Math.sin(a) * rIn;
    if (i === 0) s.moveTo(x0, y0); else s.lineTo(x0, y0);
    s.lineTo(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R);
    s.lineTo(cx + Math.cos(a2) * R, cy + Math.sin(a2) * R);
    s.lineTo(cx + Math.cos(a3) * rIn, cy + Math.sin(a3) * rIn);
  }
  s.closePath();
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
  // steampunk sky life (baked sprites, live alpha/offset/rotation only)
  cogSprite: null, cogSize: 0, cogs: [],
  zeppSprite: null, zeppW: 0, zeppH: 0, zepps: [],
  smog: null, smogW: 0, smogH: 0, smogBands: [],
  puff: null, stacks: [],
  railGear: null,
};

// ---- baked sprite builders ---------------------------------------------------

// Soft steam/smoke blob, scaled at draw time.
function buildPuffSprite(dpr) {
  const S = 64;
  const { canvas, ctx: s } = makeSprite(S, S, dpr);
  const lobes = [[0.5, 0.55, 0.36], [0.34, 0.44, 0.24], [0.66, 0.46, 0.26], [0.5, 0.36, 0.22]];
  for (let i = 0; i < lobes.length; i++) {
    const [lx, ly, lr] = lobes[i];
    const cx = lx * S, cy = ly * S, r = lr * S;
    const g = s.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(228,221,208,0.62)');
    g.addColorStop(0.45, 'rgba(196,186,170,0.30)');
    g.addColorStop(1, 'rgba(150,138,122,0)');
    s.fillStyle = g;
    s.beginPath();
    s.arc(cx, cy, r, 0, TAU);
    s.fill();
  }
  return canvas;
}

// Big translucent parallax cog: toothed brass ring, hollow centre, spokes, hub.
function buildCogSprite(size, dpr) {
  const { canvas, ctx: s } = makeSprite(size, size, dpr);
  const c = size / 2, R = c - 2;
  gearPath(s, c, c, R, 14, 0.15);
  s.fillStyle = 'rgba(138,102,54,0.55)';
  s.fill();
  s.strokeStyle = 'rgba(240,180,64,0.85)';
  s.lineWidth = Math.max(1.5, size * 0.014);
  s.stroke();
  // punch the middle out so the sky reads through the ring
  s.globalCompositeOperation = 'destination-out';
  s.beginPath();
  s.arc(c, c, R * 0.68, 0, TAU);
  s.fill();
  s.globalCompositeOperation = 'source-over';
  s.beginPath();
  s.arc(c, c, R * 0.68, 0, TAU);
  s.lineWidth = Math.max(1, size * 0.009);
  s.strokeStyle = 'rgba(240,180,64,0.55)';
  s.stroke();
  // spokes + hub
  s.lineWidth = Math.max(2, R * 0.085);
  s.strokeStyle = 'rgba(176,101,47,0.6)';
  for (let i = 0; i < 5; i++) {
    const a = i * TAU / 5;
    s.beginPath();
    s.moveTo(c + Math.cos(a) * R * 0.16, c + Math.sin(a) * R * 0.16);
    s.lineTo(c + Math.cos(a) * R * 0.7, c + Math.sin(a) * R * 0.7);
    s.stroke();
  }
  s.beginPath();
  s.arc(c, c, R * 0.2, 0, TAU);
  s.fillStyle = 'rgba(150,110,60,0.7)';
  s.fill();
  s.lineWidth = Math.max(1.2, size * 0.011);
  s.strokeStyle = 'rgba(240,180,64,0.75)';
  s.stroke();
  s.beginPath();
  s.arc(c, c, R * 0.07, 0, TAU);
  s.fillStyle = 'rgba(20,15,10,0.7)';
  s.fill();
  return canvas;
}

// Solid roadside gear on an axle (reads as a machined part, not a ghost).
function buildRailGearSprite(dpr) {
  const S = 80;
  const { canvas, ctx: s } = makeSprite(S, S, dpr);
  const c = S / 2, R = c - 2;
  gearPath(s, c, c, R, 9, 0.24);
  const g = s.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#e0ab55');
  g.addColorStop(0.5, '#b9852f');
  g.addColorStop(1, '#6d4a1c');
  s.fillStyle = g;
  s.fill();
  s.strokeStyle = 'rgba(28,20,12,0.85)';
  s.lineWidth = 2;
  s.stroke();
  // web + lightening holes
  s.beginPath();
  s.arc(c, c, R * 0.6, 0, TAU);
  s.strokeStyle = 'rgba(60,40,18,0.7)';
  s.lineWidth = 2.5;
  s.stroke();
  s.fillStyle = 'rgba(30,22,14,0.8)';
  for (let i = 0; i < 5; i++) {
    const a = i * TAU / 5 + 0.3;
    s.beginPath();
    s.arc(c + Math.cos(a) * R * 0.42, c + Math.sin(a) * R * 0.42, R * 0.13, 0, TAU);
    s.fill();
  }
  s.beginPath();
  s.arc(c, c, R * 0.18, 0, TAU);
  s.fillStyle = '#2a1e12';
  s.fill();
  s.strokeStyle = 'rgba(240,180,64,0.7)';
  s.lineWidth = 1.6;
  s.stroke();
  return canvas;
}

const ZEPP_W = 168, ZEPP_H = 62;
function buildZeppSprite(dpr) {
  const { canvas, ctx: s } = makeSprite(ZEPP_W, ZEPP_H, dpr);
  const cx = ZEPP_W * 0.52, cy = ZEPP_H * 0.42;
  const rx = ZEPP_W * 0.42, ry = ZEPP_H * 0.28;
  // tail fins first (behind the envelope)
  s.fillStyle = '#241a12';
  s.beginPath();
  s.moveTo(cx - rx * 0.92, cy);
  s.lineTo(cx - rx * 1.14, cy - ry * 1.35);
  s.lineTo(cx - rx * 0.62, cy - ry * 0.3);
  s.closePath();
  s.fill();
  s.beginPath();
  s.moveTo(cx - rx * 0.92, cy);
  s.lineTo(cx - rx * 1.14, cy + ry * 1.3);
  s.lineTo(cx - rx * 0.62, cy + ry * 0.3);
  s.closePath();
  s.fill();
  // envelope
  const g = s.createLinearGradient(0, cy - ry, 0, cy + ry);
  g.addColorStop(0, '#5c4630');
  g.addColorStop(0.45, '#37281b');
  g.addColorStop(1, '#1c140e');
  s.fillStyle = g;
  s.beginPath();
  s.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  s.fill();
  s.strokeStyle = 'rgba(201,151,59,0.5)';
  s.lineWidth = 1.1;
  s.stroke();
  // ribs
  s.strokeStyle = 'rgba(201,151,59,0.22)';
  s.lineWidth = 0.9;
  for (let i = -2; i <= 2; i++) {
    const t = i / 2.6;
    s.beginPath();
    s.ellipse(cx + rx * t, cy, rx * 0.12, ry * Math.sqrt(Math.max(0.04, 1 - t * t)), 0, 0, TAU);
    s.stroke();
  }
  // gondola + struts
  s.fillStyle = '#2a1e14';
  s.fillRect(cx - rx * 0.14, cy + ry * 0.94, rx * 0.34, ry * 0.34);
  s.strokeStyle = 'rgba(201,151,59,0.35)';
  s.lineWidth = 0.8;
  s.beginPath();
  s.moveTo(cx - rx * 0.1, cy + ry * 0.94);
  s.lineTo(cx - rx * 0.1, cy + ry * 0.7);
  s.moveTo(cx + rx * 0.16, cy + ry * 0.94);
  s.lineTo(cx + rx * 0.16, cy + ry * 0.7);
  s.stroke();
  // propeller nacelle + warm running light at the nose
  s.fillStyle = 'rgba(201,151,59,0.45)';
  s.fillRect(cx + rx * 0.42, cy + ry * 0.5, rx * 0.14, ry * 0.16);
  s.fillStyle = 'rgba(255,196,120,0.85)';
  s.beginPath();
  s.arc(cx + rx * 0.98, cy - ry * 0.1, 1.6, 0, TAU);
  s.fill();
  return canvas;
}

// Drifting smog strip: soft flattened blobs, inset so the strip has no hard
// edges (it slides fully off-screen at both ends, so no wrap fade is needed).
function buildSmogSprite(w, h, dpr, rng) {
  const { canvas, ctx: s } = makeSprite(w, h, dpr);
  const blobs = 5;
  const pad = w * 0.24;
  for (let i = 0; i < blobs; i++) {
    const t = Math.min(1, Math.max(0, (i + 0.5) / blobs + (rng() - 0.5) * 0.1));
    const bx = pad + (w - pad * 2) * t;
    const by = h * (0.35 + rng() * 0.3);
    const r = Math.min(h * 0.55, pad * 0.34) * (0.75 + rng() * 0.25);
    s.save();
    s.translate(bx, by);
    s.scale(1.9 + rng() * 0.8, 0.5);
    const g = s.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, 'rgba(126,102,78,0.5)');
    g.addColorStop(0.5, 'rgba(104,84,64,0.24)');
    g.addColorStop(1, 'rgba(88,70,52,0)');
    s.fillStyle = g;
    s.beginPath();
    s.arc(0, 0, r, 0, TAU);
    s.fill();
    s.restore();
  }
  return canvas;
}

// ---- sky ---------------------------------------------------------------------

// Ornate frozen clock hand: tapered blade with a lozenge and a counterweight.
function clockHand(s, cx, cy, ang, len, w, tail) {
  s.save();
  s.translate(cx, cy);
  s.rotate(ang);
  s.beginPath();
  s.moveTo(-tail, 0);
  s.lineTo(-tail * 0.35, -w * 0.55);
  s.lineTo(len * 0.5, -w * 0.4);
  s.lineTo(len * 0.68, -w * 1.05);
  s.lineTo(len, 0);
  s.lineTo(len * 0.68, w * 1.05);
  s.lineTo(len * 0.5, w * 0.4);
  s.lineTo(-tail * 0.35, w * 0.55);
  s.closePath();
  s.fillStyle = '#33200f';
  s.fill();
  s.strokeStyle = 'rgba(255,226,164,0.42)';
  s.lineWidth = Math.max(0.7, w * 0.16);
  s.stroke();
  s.beginPath();
  s.arc(-tail * 0.72, 0, w * 0.8, 0, TAU);
  s.fill();
  s.stroke();
  s.restore();
}

function buildSky(view, rng) {
  const { W, H, dpr } = view;
  const hy = bg.horizonY;
  const { canvas, ctx: s } = makeSprite(W, H, dpr);

  // 1. sepia / umber dusk gradient, hot brass right above the horizon
  const sky = s.createLinearGradient(0, 0, 0, H);
  const t = Math.max(0.05, Math.min(0.95, hy / H));
  sky.addColorStop(0, '#0b0907');
  sky.addColorStop(t * 0.35, '#1b140f');
  sky.addColorStop(t * 0.7, '#3d2716');
  sky.addColorStop(t * 0.93, '#7a4419');
  sky.addColorStop(t, '#b4732c');
  sky.addColorStop(Math.min(1, t + 0.001), '#2a1d13');
  sky.addColorStop(1, '#0a0806');
  s.fillStyle = sky;
  s.fillRect(0, 0, W, H);

  // 2. starfield — fewer and warmer than the neon sky (a few twinkle live)
  const count = Math.max(34, Math.min(96, Math.round((W * H) / 12500)));
  bg.twinkle.length = 0;
  for (let i = 0; i < count; i++) {
    const x = rng() * W;
    const y = rng() * Math.max(4, hy - 6);
    const depth = 1 - y / Math.max(1, hy);       // dimmer toward the smog haze
    const a = (0.14 + rng() * 0.5) * (0.3 + depth * 0.8);
    const big = rng() < 0.12;
    s.globalAlpha = a;
    s.fillStyle = rng() < 0.3 ? '#fff0cf' : '#ffd9a4';
    if (big) {
      const r = 1 + rng() * 0.85;
      s.beginPath();
      s.arc(x, y, r, 0, TAU);
      s.fill();
      s.globalAlpha = a * 0.3;
      s.fillRect(x - r * 2.6, y - 0.4, r * 5.2, 0.8);
      if (bg.twinkle.length < 9) bg.twinkle.push({ x, y, r, ph: rng() * TAU, rate: 0.9 + rng() * 2 });
    } else {
      s.fillRect(x, y, 1, 1);
    }
  }
  s.globalAlpha = 1;

  // 3. baked smog haze bands (the live ones drift on top of these)
  for (let i = 0; i < 3; i++) {
    const by = hy * (0.3 + i * 0.24);
    const bh = Math.max(10, hy * 0.1);
    const g = s.createLinearGradient(0, by - bh, 0, by + bh);
    g.addColorStop(0, 'rgba(110,88,66,0)');
    g.addColorStop(0.5, `rgba(110,88,66,${(0.1 + i * 0.05).toFixed(3)})`);
    g.addColorStop(1, 'rgba(110,88,66,0)');
    s.fillStyle = g;
    s.fillRect(0, by - bh, W, bh * 2);
  }

  // 4. ground plane below the horizon (the road is drawn on top of this)
  const gnd = s.createLinearGradient(0, hy, 0, H);
  gnd.addColorStop(0, '#33241a');
  gnd.addColorStop(0.35, '#1a1512');
  gnd.addColorStop(1, '#0d0a08');
  s.fillStyle = gnd;
  s.fillRect(0, hy, W, H - hy);

  // 5. BRASS CLOCK-FACE SUN, clipped to the sky side of the horizon
  const R = Math.min(W * 0.17, H * 0.22);
  const sunX = W / 2, sunY = hy - R * 0.34;
  s.save();
  s.beginPath();
  s.rect(0, 0, W, hy);
  s.clip();

  // warm glow behind the dial
  const halo = s.createRadialGradient(sunX, sunY, R * 0.4, sunX, sunY, R * 2.6);
  halo.addColorStop(0, 'rgba(255,168,84,0.34)');
  halo.addColorStop(0.45, 'rgba(226,124,52,0.14)');
  halo.addColorStop(1, 'rgba(200,100,50,0)');
  s.fillStyle = halo;
  s.fillRect(0, 0, W, hy);

  // gear-toothed bezel
  gearPath(s, sunX, sunY, R * 1.11, 26, 0.085);
  const bez = s.createLinearGradient(0, sunY - R, 0, sunY + R);
  bez.addColorStop(0, '#dcae5f');
  bez.addColorStop(0.5, '#a9762c');
  bez.addColorStop(1, '#6a4517');
  s.fillStyle = bez;
  s.fill();
  s.strokeStyle = 'rgba(52,32,14,0.8)';
  s.lineWidth = 1.6;
  s.stroke();

  // dial ring + face
  s.beginPath();
  s.arc(sunX, sunY, R * 0.97, 0, TAU);
  s.fillStyle = '#4c3316';
  s.fill();
  const disc = s.createLinearGradient(0, sunY - R, 0, sunY + R);
  disc.addColorStop(0, '#ffeec6');
  disc.addColorStop(0.4, '#f5bc4c');
  disc.addColorStop(0.75, '#c9973b');
  disc.addColorStop(1, '#8a5a24');
  s.fillStyle = disc;
  s.beginPath();
  s.arc(sunX, sunY, R * 0.86, 0, TAU);
  s.fill();

  // hour ticks (quarters heavier) + minute pips
  s.save();
  s.translate(sunX, sunY);
  s.strokeStyle = 'rgba(58,36,15,0.78)';
  for (let i = 0; i < 12; i++) {
    const a = i * TAU / 12;
    const ca = Math.cos(a), sa = Math.sin(a);
    const q = i % 3 === 0;
    const r0 = R * (q ? 0.64 : 0.72), r1 = R * 0.81;
    s.lineWidth = Math.max(1, R * (q ? 0.05 : 0.024));
    s.beginPath();
    s.moveTo(ca * r0, sa * r0);
    s.lineTo(ca * r1, sa * r1);
    s.stroke();
  }
  s.fillStyle = 'rgba(58,36,15,0.5)';
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) continue;
    const a = i * TAU / 60;
    s.beginPath();
    s.arc(Math.cos(a) * R * 0.79, Math.sin(a) * R * 0.79, Math.max(0.5, R * 0.011), 0, TAU);
    s.fill();
  }
  s.restore();

  // banding slits: repaint with the sky gradient so the background shows through
  s.fillStyle = sky;
  let by = sunY - R * 0.1;
  let bh = R * 0.04;
  while (by < sunY + R) {
    s.fillRect(sunX - R * 1.2, by, R * 2.4, bh);
    by += bh + R * 0.135;
    bh *= 1.5;
  }

  // hands frozen near "gear o'clock" (hour ~X, minute ~II) + hub cog
  clockHand(s, sunX, sunY, -Math.PI / 2 + TAU * (10 / 12), R * 0.52, R * 0.075, R * 0.14);
  clockHand(s, sunX, sunY, -Math.PI / 2 + TAU * (2 / 12), R * 0.76, R * 0.055, R * 0.12);
  gearPath(s, sunX, sunY, R * 0.1, 8, 0.3);
  s.fillStyle = '#33200f';
  s.fill();
  s.beginPath();
  s.arc(sunX, sunY, R * 0.03, 0, TAU);
  s.fillStyle = 'rgba(255,226,164,0.6)';
  s.fill();

  // warm bloom over dial + sky (re-lights the slits, ties the disc to the haze)
  const bloom = s.createRadialGradient(sunX, sunY, R * 0.55, sunX, sunY, R * 2.9);
  bloom.addColorStop(0, 'rgba(255,150,70,0.3)');
  bloom.addColorStop(0.45, 'rgba(226,124,52,0.13)');
  bloom.addColorStop(1, 'rgba(200,100,50,0)');
  s.fillStyle = bloom;
  s.fillRect(0, 0, W, hy);
  s.restore();

  // 6. horizon smog band + hot horizon line
  const haze = s.createLinearGradient(0, hy - R * 0.9, 0, hy + R * 0.5);
  haze.addColorStop(0, 'rgba(150,96,52,0)');
  haze.addColorStop(0.55, 'rgba(178,112,56,0.18)');
  haze.addColorStop(0.72, 'rgba(226,164,96,0.22)');
  haze.addColorStop(1, 'rgba(70,46,28,0)');
  s.fillStyle = haze;
  s.fillRect(0, hy - R * 0.9, W, R * 1.4);
  s.fillStyle = 'rgba(255,204,138,0.26)';
  s.fillRect(0, hy - 1, W, 1.6);

  bg.sky = canvas;
  bg.bloomX = sunX; bg.bloomY = sunY; bg.bloomR = R * 3;
}

// ---- industrial skyline ------------------------------------------------------

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

// Tapered chimney with brass bands; registers its mouth for live smoke puffs.
function smokestack(s, rng, x, baseY, h, w, stacks, limit) {
  h = Math.min(h, baseY - 10);
  const topW = w * 0.7;
  const cx = x + w / 2;
  s.beginPath();
  s.moveTo(x, baseY);
  s.lineTo(x + (w - topW) / 2, baseY - h);
  s.lineTo(x + (w + topW) / 2, baseY - h);
  s.lineTo(x + w, baseY);
  s.closePath();
  s.fillStyle = IRON_DARK;
  s.fill();
  s.strokeStyle = 'rgba(201,151,59,0.28)';
  s.lineWidth = 1.1;
  s.stroke();
  s.strokeStyle = 'rgba(201,151,59,0.2)';
  s.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const k = i / 4;
    const yy = baseY - h * k;
    const halfW = (w * (1 - k) + topW * k) / 2;
    s.beginPath();
    s.moveTo(cx - halfW, yy);
    s.lineTo(cx + halfW, yy);
    s.stroke();
  }
  s.fillStyle = 'rgba(201,151,59,0.34)';
  s.fillRect(cx - topW / 2 - 1.5, baseY - h - 2.5, topW + 3, 2.5);
  if (stacks.length < limit) {
    stacks.push({
      x: cx, y: baseY - h - 4,
      r: Math.max(4.5, w * 0.55),
      rise: h * 0.7 + 30,
      drift: (rng() < 0.5 ? -1 : 1) * (10 + rng() * 16),
      rate: 0.15 + rng() * 0.1,
      ph: rng(),
      a: 0.8 + rng() * 0.4,
    });
  }
}

function gasometer(s, rng, x, baseY, h, w) {
  const cx = x + w / 2, top = baseY - h;
  s.beginPath();
  s.moveTo(x, baseY);
  s.lineTo(x, top + h * 0.2);
  s.quadraticCurveTo(cx, top - h * 0.12, x + w, top + h * 0.2);
  s.lineTo(x + w, baseY);
  s.closePath();
  s.fillStyle = IRON_DARK;
  s.fill();
  s.strokeStyle = 'rgba(201,151,59,0.26)';
  s.lineWidth = 1;
  s.stroke();
  // guide-frame lattice
  s.strokeStyle = 'rgba(201,151,59,0.15)';
  s.lineWidth = 0.9;
  s.beginPath();
  for (let i = 1; i < 4; i++) {
    const xx = x + (w * i) / 4;
    s.moveTo(xx, baseY);
    s.lineTo(xx, top + h * 0.12);
  }
  for (let i = 1; i < 3; i++) {
    const yy = baseY - (h * i) / 3;
    s.moveTo(x, yy);
    s.lineTo(x + w, yy);
  }
  s.stroke();
}

function crane(s, rng, x, baseY, h, dir) {
  const top = baseY - h, wd = 6;
  s.strokeStyle = 'rgba(201,151,59,0.3)';
  s.lineWidth = 1.2;
  s.beginPath();
  s.moveTo(x, baseY); s.lineTo(x, top);
  s.moveTo(x + wd * dir, baseY); s.lineTo(x + wd * dir, top);
  s.stroke();
  s.strokeStyle = 'rgba(201,151,59,0.16)';
  s.lineWidth = 0.8;
  s.beginPath();
  for (let yy = baseY - 5; yy > top + 8; yy -= 10) {
    s.moveTo(x, yy); s.lineTo(x + wd * dir, yy - 10);
    s.moveTo(x + wd * dir, yy); s.lineTo(x, yy - 10);
  }
  s.stroke();
  const jib = 24 + rng() * 20;
  s.strokeStyle = 'rgba(201,151,59,0.3)';
  s.lineWidth = 1.4;
  s.beginPath();
  s.moveTo(x - 9 * dir, top + 3);
  s.lineTo(x + jib * dir, top - 7);
  s.stroke();
  const hookX = x + jib * dir * 0.82;
  s.strokeStyle = 'rgba(201,151,59,0.2)';
  s.lineWidth = 0.8;
  s.beginPath();
  s.moveTo(hookX, top - 4);
  s.lineTo(hookX, top + h * 0.34);
  s.stroke();
  s.fillStyle = 'rgba(201,151,59,0.3)';
  s.fillRect(hookX - 2, top + h * 0.34, 4, 4.5);
}

function truss(s, rng, x, baseY, w, h) {
  const deckY = baseY - h;
  s.fillStyle = IRON_DARK;
  s.fillRect(x, deckY, w, 3);
  s.fillRect(x + 3, deckY, 4, h);
  s.fillRect(x + w - 7, deckY, 4, h);
  const top2 = deckY - h * 0.5;
  s.strokeStyle = 'rgba(201,151,59,0.24)';
  s.lineWidth = 1;
  s.beginPath();
  s.moveTo(x, deckY);
  s.lineTo(x + w * 0.18, top2);
  s.lineTo(x + w * 0.82, top2);
  s.lineTo(x + w, deckY);
  s.stroke();
  s.strokeStyle = 'rgba(201,151,59,0.15)';
  s.lineWidth = 0.8;
  s.beginPath();
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const xa = x + w * (0.18 + 0.64 * i / segs);
    const xb = x + w * (0.18 + 0.64 * (i + 1) / segs);
    s.moveTo(xa, deckY); s.lineTo(xb, top2);
    s.moveTo(xb, deckY); s.lineTo(xa, top2);
  }
  s.stroke();
}

function shed(s, rng, x, baseY, w, h) {
  const roofY = baseY - h;
  s.fillStyle = '#100d0b';
  s.fillRect(x, roofY, w, h);
  const n = Math.max(2, Math.round(w / 15));
  s.beginPath();
  s.moveTo(x, roofY);
  for (let i = 0; i < n; i++) {
    s.lineTo(x + (w * i) / n, roofY - 7);
    s.lineTo(x + (w * (i + 1)) / n, roofY);
  }
  s.closePath();
  s.fillStyle = '#151110';
  s.fill();
  s.strokeStyle = 'rgba(201,151,59,0.22)';
  s.lineWidth = 1;
  s.stroke();
  // warm gaslit windows
  s.fillStyle = 'rgba(255,186,104,0.34)';
  for (let wy = roofY + 5; wy < baseY - 4; wy += 6) {
    for (let wx = x + 3; wx < x + w - 3; wx += 5) {
      if (rng() < 0.28) s.fillRect(wx, wy, 1.8, 2.2);
    }
  }
}

function industrialCluster(s, rng, x0, w, baseY, maxH, stacks, limit) {
  let x = x0;
  while (x < x0 + w) {
    const r = rng();
    if (r < 0.36) {
      const bw = 7 + rng() * 8;
      smokestack(s, rng, x, baseY, maxH * (0.6 + rng() * 0.8), bw, stacks, limit);
      x += bw + 6 + rng() * 12;
    } else if (r < 0.56) {
      const bw = 20 + rng() * 18;
      gasometer(s, rng, x, baseY, maxH * (0.3 + rng() * 0.28), bw);
      x += bw + 7 + rng() * 9;
    } else if (r < 0.73) {
      crane(s, rng, x + 8, baseY, maxH * (0.45 + rng() * 0.42), rng() < 0.5 ? -1 : 1);
      x += 36 + rng() * 18;
    } else if (r < 0.87) {
      const bw = 46 + rng() * 42;
      truss(s, rng, x, baseY, bw, maxH * (0.2 + rng() * 0.16));
      x += bw + 7;
    } else {
      const bw = 22 + rng() * 30;
      shed(s, rng, x, baseY, bw, maxH * (0.2 + rng() * 0.22));
      x += bw + 6 + rng() * 9;
    }
  }
}

function buildRidge(view, rng) {
  const { H, dpr } = view;
  bg.ridgeH = Math.min(H * 0.28, 220);
  bg.ridgeW = view.W + RIDGE_PAD * 2;
  bg.ridgeTop = bg.horizonY - bg.ridgeH + 2;
  const { canvas, ctx: s } = makeSprite(bg.ridgeW, bg.ridgeH, dpr);
  const baseY = bg.ridgeH - 2;
  bg.stacks.length = 0;

  // far slag heaps
  s.globalAlpha = 0.9;
  ridgeBand(s, rng, bg.ridgeW, baseY, bg.ridgeH * 0.16, bg.ridgeH * 0.44, 9,
    '#2b2018', 'rgba(201,151,59,0.22)');
  s.globalAlpha = 1;
  // works, gasometers, cranes and bridges — left and right, dial stays clear
  industrialCluster(s, rng, bg.ridgeW * 0.02, bg.ridgeW * 0.34, baseY, bg.ridgeH * 0.52, bg.stacks, 2);
  industrialCluster(s, rng, bg.ridgeW * 0.61, bg.ridgeW * 0.37, baseY, bg.ridgeH * 0.48, bg.stacks, 3);
  // grimy smog settling at the base of the works
  const seat = s.createLinearGradient(0, baseY - bg.ridgeH * 0.4, 0, baseY);
  seat.addColorStop(0, 'rgba(36,26,18,0)');
  seat.addColorStop(1, 'rgba(28,20,14,0.9)');
  s.fillStyle = seat;
  s.fillRect(0, baseY - bg.ridgeH * 0.4, bg.ridgeW, bg.ridgeH * 0.4 + 2);
  // near embankment
  ridgeBand(s, rng, bg.ridgeW, baseY, bg.ridgeH * 0.08, bg.ridgeH * 0.2, 22,
    '#100d0b', 'rgba(201,151,59,0.16)');

  bg.ridge = canvas;
}

// Flying cogs, zeppelins and drifting smog: all baked, all animated by offset.
function buildSkyLife(view, rng) {
  const { W, H, dpr } = view;
  const hy = bg.horizonY;

  bg.cogSize = Math.round(Math.max(110, Math.min(W, H) * 0.42));
  bg.cogSprite = buildCogSprite(bg.cogSize, dpr);
  bg.cogs.length = 0;
  bg.cogs.push({ x: W * 0.17, y: hy * 0.36, s: 0.95, a: 0.22, spin: 0.075, par: 0.5, rot0: rng() * TAU });
  bg.cogs.push({ x: W * 0.83, y: hy * 0.2, s: 0.62, a: 0.18, spin: -0.1, par: 0.4, rot0: rng() * TAU });
  bg.cogs.push({ x: W * 0.55, y: hy * 0.08, s: 0.4, a: 0.15, spin: 0.14, par: 0.3, rot0: rng() * TAU });

  bg.zeppSprite = buildZeppSprite(dpr);
  bg.zeppW = ZEPP_W; bg.zeppH = ZEPP_H;
  bg.zepps.length = 0;
  bg.zepps.push({ y: hy * 0.44, s: 1, a: 0.92, speed: 7, off: rng(), par: 0.25 });
  bg.zepps.push({ y: hy * 0.19, s: 0.55, a: 0.5, speed: 4.4, off: rng(), par: 0.18 });

  bg.smogW = Math.round(W * 0.8);
  bg.smogH = Math.max(22, Math.round(hy * 0.2));
  bg.smog = buildSmogSprite(bg.smogW, bg.smogH, dpr, rng);
  bg.smogBands.length = 0;
  bg.smogBands.push({ y: hy - bg.smogH * 0.8, s: 1.2, a: 0.55, speed: 5.5, off: rng() });
  bg.smogBands.push({ y: hy * 0.6, s: 0.85, a: 0.32, speed: 3.2, off: rng() });

  bg.puff = buildPuffSprite(dpr);
  bg.railGear = buildRailGearSprite(dpr);
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
  buildSkyLife(view, rng);
  buildSpeedLines(view, rng);

  // cached gradients (main-context user space, CSS px)
  const road = ctx.createLinearGradient(0, bg.horizonY, 0, view.bottomY);
  road.addColorStop(0, '#131110');
  road.addColorStop(0.35, '#1d1917');
  road.addColorStop(1, '#292320');
  bg.roadGrad = road;

  // The road ribbon ends at VIEW_DEPTH, well short of the horizon; both the
  // reflection streak and the distance haze are keyed to that screen row.
  bg.roadFarY = project(view, 0, view.camZ + VIEW_DEPTH).sy - view.shakeY;

  const refl = ctx.createLinearGradient(0, bg.roadFarY, 0, view.bottomY);
  refl.addColorStop(0, 'rgba(255,196,112,0.32)');
  refl.addColorStop(0.4, 'rgba(226,148,68,0.12)');
  refl.addColorStop(1, 'rgba(200,120,60,0)');
  bg.reflGrad = refl;

  const vig = ctx.createRadialGradient(view.W / 2, view.H * 0.56, Math.min(view.W, view.H) * 0.34,
    view.W / 2, view.H * 0.56, Math.hypot(view.W, view.H) * 0.62);
  vig.addColorStop(0, 'rgba(9,6,4,0)');
  vig.addColorStop(0.6, 'rgba(9,6,4,0.18)');
  vig.addColorStop(1, 'rgba(9,6,4,0.62)');
  bg.vignette = vig;

  // Distance haze: hides the hard cut where the road ribbon ends at VIEW_DEPTH.
  // Tinted to match the baked ground gradient, so it is invisible off-road.
  bg.fogTop = bg.roadFarY - 24;
  bg.fogH = Math.max(60, (view.bottomY - bg.roadFarY) * 0.38);
  const fog = ctx.createLinearGradient(0, bg.fogTop, 0, bg.fogTop + bg.fogH);
  fog.addColorStop(0, 'rgba(38,28,21,0.96)');
  fog.addColorStop(0.45, 'rgba(38,28,21,0.45)');
  fog.addColorStop(1, 'rgba(38,28,21,0)');
  bg.fogGrad = fog;

  const bloom = ctx.createRadialGradient(bg.bloomX, bg.bloomY, 0, bg.bloomX, bg.bloomY, bg.bloomR);
  bloom.addColorStop(0, 'rgba(255,166,80,0.5)');
  bloom.addColorStop(0.4, 'rgba(226,120,52,0.16)');
  bloom.addColorStop(1, 'rgba(200,100,50,0)');
  bg.bloom = bloom;
}

// Smoke rising from the baked stacks: 2 blits per stack, phase from sim time.
const STACK_PUFFS = 2;
function drawStackPuffs(ctx, view, mt, ox, oy) {
  if (!bg.stacks.length) return;
  ctx.save();
  for (let i = 0; i < bg.stacks.length; i++) {
    const st = bg.stacks[i];
    const bx = st.x - RIDGE_PAD + ox;
    const byy = st.y + bg.ridgeTop + oy;
    for (let p = 0; p < STACK_PUFFS; p++) {
      const u = (mt * st.rate + st.ph + p / STACK_PUFFS) % 1;
      const r = st.r * (0.6 + u * 2.3);
      ctx.globalAlpha = 0.3 * st.a * Math.sin(u * Math.PI);
      ctx.drawImage(bg.puff, bx + u * st.drift - r, byy - u * st.rise - r, r * 2, r * 2);
    }
  }
  ctx.restore();
}

function drawBackground(ctx, view, game, now, mt) {
  const { W, H } = view;
  ensureBackground(ctx, view);

  ctx.drawImage(bg.sky, 0, 0, W, H);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // live star twinkle (9 sprites max)
  ctx.fillStyle = '#ffe9c4';
  for (let i = 0; i < bg.twinkle.length; i++) {
    const s = bg.twinkle[i];
    const a = 0.22 + 0.5 * Math.abs(Math.sin(now * s.rate + s.ph));
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (0.75 + a * 0.5), 0, TAU);
    ctx.fill();
  }
  // breathing furnace glow behind the dial
  ctx.globalAlpha = 0.09 + 0.045 * Math.sin(now * 1.3);
  ctx.fillStyle = bg.bloom;
  ctx.fillRect(bg.bloomX - bg.bloomR, bg.bloomY - bg.bloomR, bg.bloomR * 2, bg.bloomR * 2);
  ctx.restore();

  // ---- sky life: flying cogs, zeppelins, drifting smog (clipped to the sky) --
  const ox = -view.shakeX * 0.35, oy = -view.shakeY * 0.25;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, bg.horizonY + 1);
  ctx.clip();

  const cs = bg.cogSize;
  for (let i = 0; i < bg.cogs.length; i++) {
    const c = bg.cogs[i];
    const d = cs * c.s;
    ctx.globalAlpha = c.a;
    ctx.save();
    ctx.translate(c.x + ox * c.par, c.y + oy * c.par);
    ctx.rotate(c.rot0 + mt * c.spin);
    ctx.drawImage(bg.cogSprite, -d / 2, -d / 2, d, d);
    ctx.restore();
  }

  for (let i = 0; i < bg.smogBands.length; i++) {
    const b = bg.smogBands[i];
    const sw = bg.smogW * b.s, sh = bg.smogH * b.s;
    const span = W + sw * 2;
    const x = -sw + ((mt * b.speed / span + b.off) % 1) * span;
    ctx.globalAlpha = b.a;
    ctx.drawImage(bg.smog, x, b.y + oy * 0.3, sw, sh);
  }

  for (let i = 0; i < bg.zepps.length; i++) {
    const zp = bg.zepps[i];
    const zw = bg.zeppW * zp.s, zh = bg.zeppH * zp.s;
    const span = W + zw * 2;
    const x = -zw + ((mt * zp.speed / span + zp.off) % 1) * span;
    ctx.globalAlpha = zp.a;
    ctx.drawImage(bg.zeppSprite, x + ox * zp.par, zp.y + oy * zp.par, zw, zh);
  }
  ctx.restore();

  // parallax silhouettes: distant layers barely react to camera shake
  ctx.drawImage(bg.ridge, -RIDGE_PAD + ox, bg.ridgeTop + oy, bg.ridgeW, bg.ridgeH);

  drawStackPuffs(ctx, view, mt, ox, oy);
}

// Reusable road sampling buffers (no per-frame allocation).
const STEPS = 24;
const rLX = new Float64Array(STEPS + 1);
const rLY = new Float64Array(STEPS + 1);
const rRX = new Float64Array(STEPS + 1);
const rRY = new Float64Array(STEPS + 1);

function drawRoad(ctx, view, game, now, mt) {
  const uS = view.unitScale;
  ctx.save();                            // never leak road state into entities

  for (let i = 0; i <= STEPS; i++) {
    const z = view.camZ + (i / STEPS) * VIEW_DEPTH;
    const L = project(view, -ROAD_HALF, z);
    const R = project(view, ROAD_HALF, z);
    rLX[i] = L.sx; rLY[i] = L.sy;
    rRX[i] = R.sx; rRY[i] = R.sy;
  }

  // ---- iron deck ----------------------------------------------------------
  const body = new Path2D();
  body.moveTo(rLX[0], rLY[0]);
  for (let i = 0; i <= STEPS; i++) body.lineTo(rLX[i], rLY[i]);
  for (let i = STEPS; i >= 0; i--) body.lineTo(rRX[i], rRY[i]);
  body.closePath();
  ctx.fillStyle = bg.roadGrad;
  ctx.fill(body);

  ctx.save();
  ctx.clip(body);

  // ---- z-anchored heavy plate patches (deliberately faint) ----------------
  const BAND_GAP = 520, BAND_DEPTH = 30, CELLS = 4, CELL_W = (ROAD_HALF * 2) / CELLS;
  const firstBand = Math.floor(view.camZ / BAND_GAP) * BAND_GAP;
  for (let z = firstBand; z < view.camZ + VIEW_DEPTH * 0.8; z += BAND_GAP) {
    const n = project(view, 0, z);
    const fr = project(view, 0, z + BAND_DEPTH);
    if (n.f < 0.05) continue;
    const kn = n.f * uS, kf = fr.f * uS;
    const parity = Math.round(z / BAND_GAP) & 1;
    ctx.fillStyle = '#e0b273';
    for (let c = 0; c < CELLS; c++) {
      if (((c + parity) & 1) === 0) continue;
      const x0 = -ROAD_HALF + c * CELL_W, x1 = x0 + CELL_W;
      ctx.globalAlpha = 0.035 + 0.025 * n.f;
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

  // ---- dial reflection streak (world-space band, so it tapers naturally) --
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

  // ---- riveted plate seams (world-anchored, same gap as the old stripes) --
  const SEAM_GAP = 140;
  ctx.lineCap = 'butt';
  const firstSeam = Math.floor(view.camZ / SEAM_GAP) * SEAM_GAP;
  for (let z = firstSeam; z < view.camZ + VIEW_DEPTH; z += SEAM_GAP) {
    const p = project(view, 0, z);
    if (p.f < 0.045) continue;
    const k = p.f * uS;
    const half = ROAD_HALF * k;
    const lw = Math.max(0.7, 2.4 * p.f);
    // dark joint
    ctx.globalAlpha = 0.3 + p.f * 0.4;
    ctx.strokeStyle = COAL;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(p.sx - half, p.sy);
    ctx.lineTo(p.sx + half, p.sy);
    ctx.stroke();
    if (p.f < 0.22) continue;
    // lip of the next plate catching the dial light
    ctx.globalAlpha = 0.1 + p.f * 0.22;
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = Math.max(0.6, lw * 0.6);
    ctx.beginPath();
    ctx.moveTo(p.sx - half, p.sy + lw);
    ctx.lineTo(p.sx + half, p.sy + lw);
    ctx.stroke();
    if (p.f < 0.6) continue;
    // near plates: longitudinal joints + rivet rows
    ctx.globalAlpha = 0.16 * p.f;
    ctx.lineWidth = Math.max(0.6, 1.6 * p.f);
    ctx.strokeStyle = COAL;
    for (let l = 0; l < LANES.length; l++) {
      const a = project(view, LANES[l], z);
      const b = project(view, LANES[l], z + SEAM_GAP);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.22 + p.f * 0.3;
    ctx.fillStyle = RIVET;
    const rr = Math.max(0.7, 2.1 * p.f);
    for (let c = -2; c <= 2; c++) {
      ctx.beginPath();
      ctx.arc(p.sx + c * ROAD_HALF * 0.42 * k, p.sy + lw * 1.6, rr, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // ---- brass edge rails with a slow warm pulse ---------------------------
  const pulse = 0.6 + 0.18 * Math.sin(now * 2.2);
  ctx.lineCap = 'round';
  for (const side of SIDES) {
    const xs = side < 0 ? rLX : rRX;
    const ys = side < 0 ? rLY : rRY;
    const edge = new Path2D();
    edge.moveTo(xs[0], ys[0]);
    for (let i = 1; i <= STEPS; i++) edge.lineTo(xs[i], ys[i]);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(201,151,59,0.12)';
    ctx.lineWidth = 11;
    ctx.stroke(edge);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(16,12,9,0.9)';
    ctx.lineWidth = 6;
    ctx.stroke(edge);
    ctx.strokeStyle = `rgba(226,170,86,${pulse.toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.stroke(edge);
  }

  // rail rivets, world-anchored so they stream past on the near half
  const RIVET_GAP = 70;
  ctx.fillStyle = '#f2cf8e';
  for (let z = Math.floor(view.camZ / RIVET_GAP) * RIVET_GAP; z < view.camZ + VIEW_DEPTH * 0.32; z += RIVET_GAP) {
    const p = project(view, 0, z);
    if (p.f < 0.5) continue;
    const k = p.f * uS;
    const r = Math.max(0.7, 1.7 * p.f);
    ctx.globalAlpha = 0.3 + p.f * 0.4;
    for (const side of SIDES) {
      ctx.beginPath();
      ctx.arc(p.sx + side * ROAD_HALF * k, p.sy - r * 0.4, r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  drawPosts(ctx, view, now, mt);

  // distance haze over the far end of the ribbon (entities stay crisp)
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg.fogGrad;
  ctx.fillRect(0, bg.fogTop, view.W, bg.fogH);

  ctx.restore();
}

// Roadside furniture just outside the deck, world-anchored so it reads as speed:
// gas lamps and gears on axles alternate every POST_GAP, far -> near.
const POST_GAP = 260, POST_X = ROAD_HALF + 24, POST_H = 82, POST_ARM = 22;
const GEAR_R = 18, GEAR_Y = 30;

function gasLamp(ctx, b, k, side, idx, now) {
  const topY = b.sy - POST_H * k;
  const w = Math.max(1, 5 * k);
  const armX = b.sx - side * POST_ARM * k;
  const headY = topY + w;
  const flick = 0.72 + 0.28 * Math.sin(now * 6.1 + idx * 2.1);

  // pool of gaslight spilling onto the deck edge
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = (0.09 + 0.04 * Math.sin(now * 1.7 + idx)) * flick;
  ctx.fillStyle = '#ffab48';
  ctx.beginPath();
  ctx.ellipse(armX, b.sy, 52 * k, 13 * k, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  // iron post with a brass fillet + collar
  ctx.fillStyle = IRON;
  ctx.fillRect(b.sx - w / 2, topY, w, POST_H * k);
  ctx.fillStyle = 'rgba(201,151,59,0.4)';
  ctx.fillRect(b.sx - w / 2, topY, Math.max(0.6, w * 0.34), POST_H * k);
  ctx.fillStyle = 'rgba(201,151,59,0.5)';
  ctx.fillRect(b.sx - w * 0.85, topY + POST_H * k * 0.34, w * 1.7, Math.max(0.8, 2.2 * k));

  // scrolled arm
  ctx.strokeStyle = IRON;
  ctx.lineWidth = Math.max(1, 3 * k);
  ctx.beginPath();
  ctx.moveTo(b.sx, headY + 9 * k);
  ctx.quadraticCurveTo(b.sx - side * POST_ARM * 0.7 * k, headY + 7 * k, armX, headY);
  ctx.stroke();

  // lantern cage
  const lw = Math.max(1.1, 6 * k);
  ctx.fillStyle = IRON_DARK;
  ctx.beginPath();
  ctx.moveTo(armX - lw, headY + lw * 0.9);
  ctx.lineTo(armX - lw * 0.7, headY - lw * 0.9);
  ctx.lineTo(armX + lw * 0.7, headY - lw * 0.9);
  ctx.lineTo(armX + lw, headY + lw * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(201,151,59,0.7)';
  ctx.lineWidth = Math.max(0.5, 1.1 * k);
  ctx.stroke();

  // flame + halo
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.85 * flick;
  ctx.fillStyle = FLAME;
  ctx.beginPath();
  ctx.arc(armX, headY, Math.max(0.9, 3 * k), 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.22 * flick;
  ctx.fillStyle = '#ff9d3c';
  ctx.beginPath();
  ctx.arc(armX, headY, Math.max(2, 13 * k), 0, TAU);
  ctx.fill();
  ctx.restore();
}

function roadGear(ctx, b, k, side, mt) {
  const axleY = b.sy - GEAR_Y * k;
  const w = Math.max(1, 4 * k);
  ctx.fillStyle = IRON;
  ctx.fillRect(b.sx - w / 2, axleY, w, GEAR_Y * k);
  const d = GEAR_R * 2 * k;
  if (d < 2.5) return;
  ctx.save();
  ctx.translate(b.sx, axleY);
  ctx.rotate(side * mt * 0.5);           // opposite sides turn like a meshed pair
  ctx.drawImage(bg.railGear, -d / 2, -d / 2, d, d);
  ctx.restore();
}

function drawPosts(ctx, view, now, mt) {
  const uS = view.unitScale;
  const first = Math.floor(view.camZ / POST_GAP) * POST_GAP;
  const last = view.camZ + VIEW_DEPTH;
  // far -> near so nearby furniture overlaps distant pieces correctly
  for (let z = Math.floor(last / POST_GAP) * POST_GAP; z >= first; z -= POST_GAP) {
    const idx = Math.round(z / POST_GAP);
    const gear = (idx & 1) === 1;
    for (const side of SIDES) {
      const b = project(view, side * POST_X, z);
      if (b.f < 0.045) continue;
      const k = b.f * uS;
      if (gear) roadGear(ctx, b, k, side, mt);
      else gasLamp(ctx, b, k, side, idx, now);
    }
  }
}

// Steam streaks radiating from the vanishing point + framing vignette.
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
    ctx.strokeStyle = '#efe4d0';
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
  // `now`: wall seconds for ambience that must live outside the simulation.
  // `mt`: machine time — sim seconds, freezes with the world (never Date.now()).
  const now = typeof performance !== 'undefined' ? performance.now() * 0.001 : (game.time || 0);
  const mt = game.time || 0;

  drawBackground(ctx, view, game, now, mt);
  drawRoad(ctx, view, game, now, mt);

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
