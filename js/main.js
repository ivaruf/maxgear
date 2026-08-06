// Bootstrap + campaign state machine + fixed update pipeline. LEAD-OWNED.
//
// v1.4 CAMPAIGN: title -> 'slots' (3 saves) -> 'newgame' (difficulty) ->
// startLevel(0) ... boss/foreman dead -> 'levelclear' (autosave) -> next level
// -> final level victory. Build (player.tracks) and score persist across
// levels; HP refills at level start. R restarts the CURRENT level with the
// build it started with.

import { BASE_RUN_SPEED } from './config.js';
import { sweepDead } from './utils.js';
import { createInput } from './input.js';
import { createView, resizeView, updateCamera, render } from './render.js';
import { createPlayer, updatePlayer } from './player.js';
import { updateProjectiles } from './projectiles.js';
import { updateEnemies, spawnEnemy, ENEMY_TYPES } from './enemies.js';
import { bossTargetHp, recomputeStats } from './upgrades.js';
import { updateGates } from './gates.js';
import { updateObstacles } from './obstacles.js';
import { updatePickups } from './pickups.js';
import { createLevel, updateLevel } from './level.js';
import { resolveCollisions } from './collisions.js';
import { fx } from './effects.js';
import { audio } from './audio.js';
import { ui } from './ui.js';
import { DIFFICULTIES, levelDef, isFinalLevel, LEVELS } from './campaign.js';
import { loadSlots, writeSlot, clearSlot, makeSave } from './saves.js';

const canvas = document.getElementById('game');
const input = createInput(canvas);
const view = createView(canvas);

const game = {
  state: 'title', // title | slots | newgame | playing | paused | levelclear | victory | defeat
  time: 0,
  runSpeed: BASE_RUN_SPEED,
  score: 0,
  kills: 0,
  player: createPlayer(),
  enemies: [],
  projectiles: [],
  enemyShots: [],
  mortars: [],        // bomber shells in flight (managed by enemies.js)
  gates: [],
  obstacles: [],
  pickups: [],
  boss: null,
  bossDefeated: false,
  pendingBossAt: null,
  endTimer: 0,        // short delay before showing end screens
  lastUpgrade: null,
  campaign: null,     // { slot, difficulty, levelIndex, introduced:Set, levelStart* }
  levelDef: null,     // LEVELS[levelIndex] while playing
  difficulty: null,   // DIFFICULTIES entry (enemies.js reads enemyHp/enemyDmg)
  level: null,        // director state (created per level)
  view,
  timeScale: 1,       // debug/testing fast-forward
};

let pendingSlot = 0;  // slot chosen on the slots screen, awaiting difficulty

function clearWorld() {
  game.enemies.length = 0;
  game.projectiles.length = 0;
  game.enemyShots.length = 0;
  game.mortars.length = 0;
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

// Types already showcased this campaign (resume pre-fills from earlier levels'
// pools so a resumed run never re-teaches old machines).
function introducedUpTo(levelIndex) {
  const set = new Set();
  for (let i = 0; i < levelIndex; i++) {
    const pool = levelDef(i).enemyPool;
    const keys = pool === 'all'
      ? Object.keys(ENEMY_TYPES).filter((k) => !ENEMY_TYPES[k].isBoss)
      : pool;
    for (const k of keys) set.add(k);
  }
  return set;
}

function startLevel(i, tracks = null) {
  const c = game.campaign;
  c.levelIndex = i;
  game.levelDef = levelDef(i);
  game.difficulty = c.difficulty;
  game.time = 0;
  game.runSpeed = BASE_RUN_SPEED;
  game.endTimer = 0;
  // The build PERSISTS across levels: default to whatever the player has right
  // now (continue path); explicit tracks win (resume / R-restart snapshots).
  const carry = tracks ?? (game.player ? game.player.tracks : null);
  game.player = createPlayer();
  if (carry) game.player.tracks = { ...carry };
  recomputeStats(game.player);
  game.player.hp = game.player.maxHp; // fresh boiler every level
  // R-restart snapshot: the build/score this level STARTED with
  c.levelStartTracks = { ...game.player.tracks };
  c.levelStartScore = game.score;
  c.levelStartKills = game.kills;
  clearWorld();
  game.level = createLevel(game.levelDef, c.difficulty, c.introduced);
  input.clear();
  setState('playing');
}

function newGame(slot, diffKey) {
  game.campaign = {
    slot,
    difficulty: DIFFICULTIES[diffKey] || DIFFICULTIES.medium,
    levelIndex: 0,
    introduced: new Set(),
  };
  game.score = 0;
  game.kills = 0;
  startLevel(0);
}

function resumeGame(slot, save) {
  game.campaign = {
    slot,
    difficulty: DIFFICULTIES[save.difficulty] || DIFFICULTIES.medium,
    levelIndex: save.levelIndex,
    introduced: introducedUpTo(save.levelIndex),
  };
  game.score = save.score || 0;
  game.kills = save.kills || 0;
  // A cleared campaign resumes at the final level for a victory lap
  startLevel(Math.min(save.levelIndex, LEVELS.length - 1), save.tracks);
}

// v1.5 KEEP-2: the balance valve. Every non-kept track resets to LV0 (rusted
// plating resets too — for free), THEN we autosave and roll into the next level.
function confirmKeep(keys) {
  if (game.state !== 'levelclear' || !game.campaign) return;
  const keep = new Set(keys || []);
  const p = game.player;
  for (const key of Object.keys(p.tracks)) {
    if (!keep.has(key)) delete p.tracks[key];
  }
  recomputeStats(p);
  const c = game.campaign;
  writeSlot(c.slot, makeSave(game, c.levelIndex + 1));
  startLevel(c.levelIndex + 1);
}

function restartLevel() {
  const c = game.campaign;
  if (!c) return;
  game.score = c.levelStartScore;
  game.kills = c.levelStartKills;
  startLevel(c.levelIndex, c.levelStartTracks);
}

function setState(s) {
  game.state = s;
  if (s === 'playing') input.clear(); // drops drag accumulated while paused
  ui.showScreen(s === 'playing' ? null : s === 'paused' ? 'pause' : s);
  if (s === 'slots') ui.showSlots(loadSlots());
  if (s === 'levelclear') {
    const c = game.campaign;
    ui.showLevelClear(game, {
      levelIndex: c.levelIndex,
      name: game.levelDef.name,
      next: levelDef(c.levelIndex + 1).name,
      score: game.score,
    });
    audio.win();
  }
  if (s === 'victory') {
    ui.showEnd(game, true, {
      campaignDone: true,
      difficulty: game.campaign ? game.campaign.difficulty.label : '',
    });
    audio.win();
  }
  if (s === 'defeat') { ui.showEnd(game, false); audio.lose(); }
}

// ---- one simulation step (dt already clamped) -------------------------------
function step(dt) {
  game.time += dt;

  updateLevel(game, dt);

  // End-fight arena: stop forward motion just before it, spawn the level's boss
  if (game.pendingBossAt !== null && game.player.z >= game.pendingBossAt - 250) {
    game.runSpeed = 0;
    if (!game.boss && !game.bossDefeated) {
      // HP scales with the player's actual landed DPS (upgrades.js) so the
      // fight lasts ~bossSec for any build; foremen are ~55% fights.
      const end = game.levelDef && game.levelDef.end === 'foreman' && ENEMY_TYPES.foreman
        ? 'foreman' : 'boss';
      const diffMul = (game.difficulty ? game.difficulty.bossSec : 24) / 24;
      // Foremen are shorter fights than the ironclad; the LEVEL 1 foreman is
      // gentler still — it's the campaign's on-ramp, not a wall.
      const endMul = end === 'foreman' ? (game.levelDef && game.levelDef.id === 1 ? 0.4 : 0.55) : 1;
      const target = bossTargetHp(game.player) * diffMul * endMul;
      spawnEnemy(game, end, 0, game.player.z + 700, { hpScale: target / ENEMY_TYPES[end].hp });
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
  sweepDead(game.mortars);
  sweepDead(game.gates);
  sweepDead(game.obstacles);
  sweepDead(game.pickups);

  // Win / loss transitions (with a short beat for the death/victory fx)
  if (game.player.dead) {
    game.endTimer += dt;
    if (game.endTimer > 1.0) setState('defeat');
  } else if (game.bossDefeated) {
    game.endTimer += dt;
    if (game.endTimer > 1.4) {
      const c = game.campaign;
      if (isFinalLevel(c.levelIndex)) {
        writeSlot(c.slot, makeSave(game, c.levelIndex, true));
        setState('victory');
      } else {
        setState('levelclear'); // autosave happens in confirmKeep (after the pick)
      }
    }
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
      if (startPress) { audio.unlock(); audio.click(); setState('slots'); }
      break;
    case 'slots':
    case 'newgame':
    case 'powers':
      if (pausePress) { audio.click(); setState('title'); } // Esc backs out
      break;
    case 'playing':
      if (pausePress) { audio.click(); setState('paused'); }
      else if (restartPress) restartLevel();
      break;
    case 'paused':
      if (pausePress || startPress) { audio.click(); setState('playing'); ui.showScreen(null); }
      else if (restartPress) restartLevel();
      break;
    case 'levelclear':
      if (startPress) {
        const keys = ui.levelClearSelection();
        if (keys) { audio.click(); confirmKeep(keys); }
      }
      break;
    case 'defeat':
      if (startPress || restartPress) { audio.unlock(); restartLevel(); }
      break;
    case 'victory':
      if (startPress || restartPress) { audio.unlock(); clearWorld(); setState('slots'); }
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
  start: () => { if (game.state === 'title') { audio.unlock(); setState('slots'); } },
  restart: () => { audio.unlock(); restartLevel(); },
  resume: () => { if (game.state === 'paused') { setState('playing'); ui.showScreen(null); } },
  quit: () => { clearWorld(); setState('title'); }, // autosaves happen at level clear only
  pause: () => {
    if (game.state === 'playing') setState('paused');
    else if (game.state === 'paused') { setState('playing'); ui.showScreen(null); }
  },
  mute: () => ui.setMuted(audio.toggleMute()),
  pickSlot: (i) => {
    audio.unlock();
    const save = loadSlots()[i];
    if (save && !save.cleared) resumeGame(i, save);
    else if (save && save.cleared) resumeGame(i, save); // victory-lap replay of the finale
    else { pendingSlot = i; setState('newgame'); }
  },
  deleteSlot: (i) => { clearSlot(i); ui.showSlots(loadSlots()); },
  pickDifficulty: (key) => { audio.unlock(); newGame(pendingSlot, key); },
  confirmKeep: (keys) => confirmKeep(keys),
  backToSlots: () => setState('slots'),
  showPowers: () => { if (game.state === 'title') { audio.unlock(); setState('powers'); ui.showPowers(); } },
  backToTitle: () => setState('title'),
});
ui.showScreen('title');

window.addEventListener('resize', () => resizeView(view));

// Debug/test hooks (used by automated Playwright tests).
// quickStart bypasses the menus: fresh medium campaign in slot 2 (test slot).
window.MG = {
  game, setState, view, startLevel,
  quickStart: (diff = 'medium', slot = 2) => { audio.unlock(); newGame(slot, diff); },
  newRun: () => { // legacy hook kept for older test scripts
    if (!game.campaign) window.MG.quickStart();
    else restartLevel();
  },
};

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
