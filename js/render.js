// Camera, perspective projection, background/road, and frame orchestration.
// project() is the ONLY way world coords become screen coords — see DESIGN.md.

import { ROAD_HALF, VIEW_DEPTH, FOCAL, CAM_BACK } from './config.js';
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

function drawBackground(ctx, view, game) {
  const { W, H } = view;
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#131734');
  sky.addColorStop(0.45, '#251b47');
  sky.addColorStop(0.72, '#3d1e55');
  sky.addColorStop(1, '#0b0e1a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Distant sun
  const horizon = project(view, 0, view.camZ + VIEW_DEPTH * 4);
  ctx.save();
  const sunG = ctx.createRadialGradient(W / 2, horizon.sy - 10, 4, W / 2, horizon.sy - 10, W * 0.22);
  sunG.addColorStop(0, 'rgba(255,140,90,0.75)');
  sunG.addColorStop(1, 'rgba(255,140,90,0)');
  ctx.fillStyle = sunG;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawRoad(ctx, view, game) {
  // Road body as a ribbon of quads sampled along dz
  const STEPS = 24;
  const pts = [];
  for (let i = 0; i <= STEPS; i++) {
    const dz = (i / STEPS) * VIEW_DEPTH;
    const z = view.camZ + dz;
    pts.push({ L: project(view, -ROAD_HALF, z), R: project(view, ROAD_HALF, z), z });
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].L.sx, pts[0].L.sy);
  for (const p of pts) ctx.lineTo(p.L.sx, p.L.sy);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].R.sx, pts[i].R.sy);
  ctx.closePath();
  ctx.fillStyle = '#181c2e';
  ctx.fill();

  // Neon edges
  for (const side of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const p = side < 0 ? pts[i].L : pts[i].R;
      i === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy);
    }
    ctx.strokeStyle = 'rgba(53,224,255,0.65)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Scrolling lane stripes (world-anchored so they stream past)
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  const STRIPE_GAP = 140, STRIPE_LEN = 60;
  for (const laneX of [-ROAD_HALF / 3, ROAD_HALF / 3]) {
    const first = Math.floor(view.camZ / STRIPE_GAP) * STRIPE_GAP;
    for (let z = first; z < view.camZ + VIEW_DEPTH; z += STRIPE_GAP) {
      const a = project(view, laneX, z);
      const b = project(view, laneX, z + STRIPE_LEN);
      ctx.lineWidth = 4 * a.f;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
  }
}

export function render(ctx, view, game, fx) {
  view.shakeX = fx.getShakeX();
  view.shakeY = fx.getShakeY();

  drawBackground(ctx, view, game);
  drawRoad(ctx, view, game);

  // Painter's algorithm: farthest entities first
  drawGates(ctx, view, game);
  drawObstacles(ctx, view, game);
  drawPickups(ctx, view, game);
  drawEnemies(ctx, view, game);
  drawEnemyShots(ctx, view, game);
  drawPlayer(ctx, view, game);
  drawProjectiles(ctx, view, game);

  fx.draw(ctx, view);
}
