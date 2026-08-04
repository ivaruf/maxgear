// Bootstrap + game state machine + fixed update pipeline. LEAD-OWNED.

import { BASE_RUN_SPEED } from './config.js';
import { sweepDead } from './utils.js';
import { createInput } from './input.js';
import { createView, resizeView, updateCamera, render } from './render.js';
import { createPlayer, updatePlayer } from './player.js';
import { updateProjectiles } from './projectiles.js';
import { updateEnemies, spawnEnemy, ENEMY_TYPES } from './enemies.js';
import { updateGates } from './gates.js';
import { updateObstacles } from './obstacles.js';
import { updatePickups } from './pickups.js';
import { createLevel, updateLevel } from './level.js';
import { resolveCollisions } from './collisions.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { ui } from './ui.js';

const canvas = document.getElementById('game');
const input = createInput(canvas);
const view = createView(canvas);

const game = {
  state: 'title', // title | playing | paused | victory | defeat
  time: 0,
  runSpeed: BASE_RUN_SPEED,
  score: 0,
  kills: 0,
  player: createPlayer(),
  enemies: [],
  projectiles: [],
  enemyShots: [],
  gates: [],
  obstacles: [],
  pickups: [],
  boss: null,
  bossDefeated: false,
  pendingBossAt: null,
  endTimer: 0,        // short delay before showing end screens
  lastUpgrade: null,
  level: createLevel(),
  view,
  timeScale: 1,       // debug/testing fast-forward
};

function clearWorld() {
  game.enemies.length = 0;
  game.projectiles.length = 0;
  game.enemyShots.length = 0;
  game.gates.length = 0;
  game.obstacles.length = 0;
  game.pickups.length = 0;
  game.boss = null;
  game.bossDefeated = false;
  game.pendingBossAt = null;
  game.projCursor = 0;
  game.lastUpgrade = null;
  fx.reset();
}

function newRun() {
  game.time = 0;
  game.runSpeed = BASE_RUN_SPEED;
  game.score = 0;
  game.kills = 0;
  game.player = createPlayer();
  game.endTimer = 0;
  game.level = createLevel();
  clearWorld();
  input.clear();
  setState('playing');
}

function setState(s) {
  game.state = s;
  if (s === 'playing') input.clear(); // drops drag accumulated while paused
  ui.showScreen(s === 'playing' ? null : s === 'paused' ? 'pause' : s);
  if (s === 'victory') { ui.showEnd(game, true); audio.win(); }
  if (s === 'defeat') { ui.showEnd(game, false); audio.lose(); }
}

// ---- one simulation step (dt already clamped) -------------------------------
function step(dt) {
  game.time += dt;

  updateLevel(game, dt);

  // Boss arena: stop forward motion just before the arena, spawn the boss
  if (game.pendingBossAt !== null && game.player.z >= game.pendingBossAt - 250) {
    game.runSpeed = 0;
    if (!game.boss && !game.bossDefeated) {
      // Boss HP scales with the player's actual firepower so the fight lasts
      // ~30s whether the build is weak or maxed (pure distance-scaling made
      // strong builds melt it in seconds and weak builds hopeless).
      const s = game.player.stats;
      // ~0.35 of theoretical DPS actually lands on a strafing boss (spread,
      // squad offsets, phase shields) -> hp = dps * 0.35 * ~28s target fight
      const dps = (s.damage * s.projectiles * (1 + s.squad) * (1 + s.critChance)) / s.fireInterval;
      const targetHp = Math.min(Math.max(dps * 10, 4000), 45000);
      spawnEnemy(game, 'boss', 0, game.player.z + 700, { hpScale: targetHp / ENEMY_TYPES.boss.hp });
    }
  }

  updatePlayer(game, dt, input);
  updateProjectiles(game, dt);
  updateEnemies(game, dt);
  updateObstacles(game, dt);
  updatePickups(game, dt);
  updateGates(game, dt);
  resolveCollisions(game, dt);

  sweepDead(game.enemies);
  sweepDead(game.projectiles);
  sweepDead(game.enemyShots);
  sweepDead(game.gates);
  sweepDead(game.obstacles);
  sweepDead(game.pickups);

  // Win / loss transitions (with a short beat for the death/victory fx)
  if (game.player.dead) {
    game.endTimer += dt;
    if (game.endTimer > 1.0) setState('defeat');
  } else if (game.bossDefeated) {
    game.endTimer += dt;
    if (game.endTimer > 1.4) setState('victory');
  }
}

function handleInput() {
  if (input.took('mute')) {
    ui.setMuted(audio.toggleMute());
  }
  const startPress = input.took('start') || input.took('tap');
  const pausePress = input.took('pause');
  const restartPress = input.took('restart');

  switch (game.state) {
    case 'title':
      if (startPress) { audio.unlock(); audio.click(); newRun(); }
      break;
    case 'playing':
      if (pausePress) { audio.click(); setState('paused'); }
      else if (restartPress) newRun();
      break;
    case 'paused':
      if (pausePress || startPress) { audio.click(); setState('playing'); ui.showScreen(null); }
      else if (restartPress) newRun();
      break;
    case 'defeat':
    case 'victory':
      if (startPress || restartPress) { audio.unlock(); newRun(); }
      break;
  }
}

// ---- main loop ---------------------------------------------------------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  handleInput();

  if (game.state === 'playing') {
    // timeScale > 1 (debug) runs multiple clamped substeps to stay stable
    let remaining = dt * game.timeScale;
    while (remaining > 0) {
      const sub = Math.min(remaining, 1 / 50);
      step(sub);
      remaining -= sub;
      if (game.state !== 'playing') break;
    }
    // re-check: step() may have just ended the run, and ui.update would
    // re-show the boss bar / re-enable boss music on the end screen
    if (game.state === 'playing') ui.update(game);
  }

  updateCamera(view, game);
  fx.update(game.state === 'playing' ? dt : 0);
  render(view.ctx, view, game, fx);
}

// ---- boot ---------------------------------------------------------------------
ui.init(game, {
  start: () => { if (game.state === 'title') { audio.unlock(); newRun(); } },
  restart: () => { audio.unlock(); newRun(); },
  resume: () => { if (game.state === 'paused') { setState('playing'); ui.showScreen(null); } },
  quit: () => { clearWorld(); setState('title'); }, // no frozen run bleeding through the title
  pause: () => {
    if (game.state === 'playing') setState('paused');
    else if (game.state === 'paused') { setState('playing'); ui.showScreen(null); }
  },
  mute: () => ui.setMuted(audio.toggleMute()),
});
ui.showScreen('title');

window.addEventListener('resize', () => resizeView(view));

// Debug/test hooks (used by automated Playwright tests)
window.MG = { game, newRun, setState, view };

// ---- PWA: install + update-on-launch -------------------------------------------
// sw.js precaches everything under a versioned cache. updateViaCache:'none' +
// reg.update() make a bumped sw.js VERSION get picked up at launch; when the
// new worker takes control we reload to run the fresh version — but only from
// the title screen, never in the middle of a run.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update())
      .catch(() => { /* offline or unsupported: the game runs fine without it */ });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && game.state === 'title') location.reload();
  });
}

requestAnimationFrame(frame);
