// DOM HUD + screens. UI/AUDIO-AGENT OWNS THIS FILE.
// The only module allowed to touch the DOM besides main.js bootstrap.
// No top-level DOM access: every lookup happens inside ui.init().
// Presentation is brass/iron (see css/style.css) but every id, class hook and
// game field read here is unchanged — this module is pure plumbing.

import { levelProgress } from './level.js';
import { BASE_STATS, PLAYER_DEFAULTS } from './config.js';
import { audio } from './audio.js';

const $ = (id) => document.getElementById(id);

let els = null;

// --- toast queue (one visible slot, drained in order, never overlapping text) --
const toastQueue = [];
let toastTimer = null;
let toastActive = false;
let toastShownAt = 0;
const TOAST_HOLD = 1250;   // ms a lone toast stays up
const TOAST_RUSH = 620;    // ms per toast when more are waiting
const TOAST_MIN = 260;     // never flash a label shorter than this

// One-shot steer hint: shown at the start of the FIRST run this page load
// (replaces the old title-screen how-to panel; the game teaches the rest itself)
let steerHintShown = false;

// --- change trackers for the little "pop" animations -------------------------
let prevScore = 0;
let scoreFlip = false;
let prevAct = null;
let prevStrip = '';

function esc(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function nextToast() {
  clearTimeout(toastTimer);
  const t = els.toast;
  const item = toastQueue.shift();
  if (!item) {
    toastActive = false;
    t.classList.add('hidden');
    return;
  }
  toastActive = true;
  toastShownAt = Date.now();
  t.textContent = item.label;
  // className assignment also clears .hidden -> element becomes visible
  t.className = item.kind && item.kind !== 'good' ? item.kind : '';
  // retrigger the CSS entry animation
  t.style.animation = 'none';
  void t.offsetHeight;
  t.style.animation = '';
  toastTimer = setTimeout(nextToast, toastQueue.length ? TOAST_RUSH : TOAST_HOLD);
}

function clearToasts() {
  toastQueue.length = 0;
  toastActive = false;
  clearTimeout(toastTimer);
  if (els) els.toast.classList.add('hidden');
}

// "Final build" chip row for the end screens. Chips flagged .up read as gains.
function buildChips(p) {
  const s = p.stats;
  const b = BASE_STATS;
  const rows = [
    ['DMG', Math.round(s.damage), s.damage > b.damage],
    ['ROF', `${(1 / s.fireInterval).toFixed(1)}/s`, s.fireInterval < b.fireInterval],
    ['SHOTS', s.projectiles, s.projectiles > b.projectiles],
  ];
  if (s.squad > 0) rows.push(['ALLIES', s.squad, true]);
  if (s.pierce > 0) rows.push(['PIERCE', s.pierce, true]);
  if (s.ricochet > 0) rows.push(['RICOCHET', s.ricochet, true]);
  if (s.critChance > 0) rows.push(['CRIT', `${Math.round(s.critChance * 100)}%`, true]);
  if (s.explosive > 0) rows.push(['EXPLOSIVE', `LV${Math.round(s.explosive)}`, true]);
  if (s.magnet > 0) rows.push(['MAGNET', Math.round(s.magnet), true]);
  if (s.moveSpeed !== b.moveSpeed) rows.push(['SPEED', Math.round(s.moveSpeed), s.moveSpeed > b.moveSpeed]);
  if (s.spreadDeg !== b.spreadDeg) rows.push(['SPREAD', `${Math.round(s.spreadDeg)}°`, s.spreadDeg < b.spreadDeg]);
  if (p.maxHp !== PLAYER_DEFAULTS.maxHp) {
    rows.push(['MAX HP', Math.round(p.maxHp), p.maxHp > PLAYER_DEFAULTS.maxHp]);
  }
  return rows
    .map(([k, v, up]) => `<i class="${up ? 'up' : ''}"><em>${esc(k)}</em>${esc(v)}</i>`)
    .join('');
}

export const ui = {
  init(game, actions) {
    els = {
      hud: $('hud'),
      hpWrap: $('hp-wrap'), hpBar: $('hp-bar'), hpGhost: $('hp-ghost'), hpText: $('hp-text'),
      progressBar: $('progress-bar'), progressMarker: $('progress-marker'), progressGoal: $('progress-goal'),
      score: $('score'),
      actLabel: $('act-label'),
      bossWrap: $('boss-wrap'), bossBar: $('boss-bar'), bossName: $('boss-name'),
      toast: $('upgrade-toast'),
      statsStrip: $('stats-strip'),
      screens: {
        title: $('screen-title'),
        pause: $('screen-pause'),
        defeat: $('screen-defeat'),
        victory: $('screen-victory'),
      },
      defeatStats: $('defeat-stats'),
      victoryStats: $('victory-stats'),
      defeatBuild: $('defeat-build'),
      victoryBuild: $('victory-build'),
      muteBtn: $('mute-btn'),
    };

    const tap = (el, fn) => el && el.addEventListener('click', () => { fn(); audio.click(); });
    tap($('btn-start'), actions.start);
    tap($('btn-retry'), actions.restart);
    tap($('btn-again'), actions.restart);
    tap($('btn-resume'), actions.resume);
    tap($('btn-quit'), actions.quit);
    tap($('pause-btn'), actions.pause);
    tap(els.muteBtn, actions.mute);

    // Tap anywhere on the title screen starts the run (the overlay covers the
    // canvas, so input.js' 'tap' never fires here). actions.start is guarded by
    // main.js (`state === 'title'`), so the extra bubbled click is a no-op.
    els.screens.title.addEventListener('click', actions.start);
  },

  showScreen(state) {
    for (const [name, el] of Object.entries(els.screens)) {
      el.classList.toggle('hidden', name !== state);
    }
    els.hud.classList.toggle('hidden', !(state === null || state === 'pause'));
    if (state === null) clearToasts(); // fresh run: drop any queued toast from the last one
    if (state === null && !steerHintShown) {
      steerHintShown = true;
      const h = $('steer-hint');
      if (h) {
        h.classList.remove('hidden');
        setTimeout(() => h.classList.add('hidden'), 4700); // matches the CSS timeline
      }
    }
    if (state !== null && state !== 'pause') {
      clearToasts();
      audio.setBossMode(false);
      els.bossWrap.classList.add('hidden');
    }
    if (state === 'title') {
      prevScore = 0;
      prevAct = null;
      prevStrip = '';
      els.score.textContent = '0';
      els.actLabel.classList.add('hidden');
    }
  },

  setMuted(m) {
    els.muteBtn.textContent = m ? '🔇' : '🔊';
    els.muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
  },

  // Queued, never overlapping: one slot, the visible label's hold is cut short
  // (but never below TOAST_MIN) as soon as another upgrade lands behind it.
  toast(label, kind) {
    toastQueue.push({ label, kind });
    if (toastQueue.length > 3) toastQueue.splice(0, toastQueue.length - 3);
    if (!toastActive) { nextToast(); return; }
    const elapsed = Date.now() - toastShownAt;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(nextToast, Math.max(TOAST_MIN, TOAST_RUSH - elapsed));
  },

  showEnd(game, victory) {
    const p = game.player;
    const stats = [
      ['SCORE', game.score],
      ['KILLS', game.kills],
      ['DISTANCE', `${Math.round(p.z / 10)}m`],
    ].map(([k, v]) => `<div><b>${esc(v)}</b><span>${k}</span></div>`).join('');
    const chips = buildChips(p);
    if (victory) {
      els.victoryStats.innerHTML = stats;
      els.victoryBuild.innerHTML = chips;
    } else {
      els.defeatStats.innerHTML = stats;
      els.defeatBuild.innerHTML = chips;
    }
  },

  update(game) {
    const p = game.player;

    // --- HP: fast bar + lagging ghost (smooth drain) + low-hp pulse ---
    const hpFrac = Math.max(p.hp / p.maxHp, 0);
    const pct = `${hpFrac * 100}%`;
    els.hpBar.style.width = pct;
    els.hpGhost.style.width = pct;
    const low = hpFrac < 0.3;
    els.hpBar.classList.toggle('low', low);
    els.hpWrap.classList.toggle('danger', low && !p.dead);
    els.hpText.textContent = Math.ceil(p.hp);

    // --- Score with a pop on increase ---
    if (game.score !== prevScore) {
      els.score.textContent = game.score;
      if (game.score > prevScore) {
        scoreFlip = !scoreFlip;
        els.score.classList.toggle('pop-a', scoreFlip);
        els.score.classList.toggle('pop-b', !scoreFlip);
      }
      prevScore = game.score;
    }

    // --- Progress toward the boss ---
    const prog = levelProgress(game) * 100;
    els.progressBar.style.width = `${prog}%`;
    els.progressMarker.style.left = `${prog}%`;
    els.progressGoal.classList.toggle('near', prog > 88);

    // --- Act / wave label (optional: game.level.actLabel may be undefined) ---
    const act = game.level && game.level.actLabel;
    if (act) {
      if (act !== prevAct) {
        prevAct = act;
        els.actLabel.textContent = act;
        els.actLabel.classList.remove('hidden');
        els.actLabel.style.animation = 'none';
        void els.actLabel.offsetHeight;
        els.actLabel.style.animation = '';
      }
    } else if (prevAct !== null || !els.actLabel.classList.contains('hidden')) {
      prevAct = null;
      els.actLabel.classList.add('hidden');
    }

    // --- Boss bar with phase tinting at the 66% / 33% markers ---
    const boss = game.boss;
    if (boss && !boss.dead) {
      const frac = Math.max(boss.hp / boss.maxHp, 0);
      els.bossWrap.classList.remove('hidden');
      // display name is data-driven (enemies.js owns boss.def.name = IRONCLAD)
      els.bossName.textContent = (boss.def && boss.def.name) || 'IRONCLAD';
      els.bossBar.style.width = `${frac * 100}%`;
      // phase thresholds are the 66% / 33% ticks drawn on the bar; enemies.js
      // owns boss.bossPhase (monotonic) — fall back to the raw fraction.
      const phase = boss.bossPhase || (frac <= 0.33 ? 3 : frac <= 0.66 ? 2 : 1);
      els.bossWrap.classList.toggle('p2', phase === 2);
      els.bossWrap.classList.toggle('p3', phase >= 3);
      audio.setBossMode(true);
    } else {
      els.bossWrap.classList.add('hidden');
      audio.setBossMode(false);
    }

    // --- Build strip ---
    const s = p.stats;
    const parts = [
      ['DMG', Math.round(s.damage), s.damage > BASE_STATS.damage],
      ['ROF', `${(1 / s.fireInterval).toFixed(1)}/s`, s.fireInterval < BASE_STATS.fireInterval],
      ['SHOTS', s.projectiles, s.projectiles > BASE_STATS.projectiles],
    ];
    if (s.squad > 0) parts.push(['ALLIES', s.squad, true]);
    if (s.pierce > 0) parts.push(['PIERCE', s.pierce, true]);
    if (s.ricochet > 0) parts.push(['RICO', s.ricochet, true]);
    if (s.critChance > 0) parts.push(['CRIT', `${Math.round(s.critChance * 100)}%`, true]);
    if (s.explosive > 0) parts.push(['BOOM', '💥', true]);
    const strip = parts.map(([k, v, up]) => `<i class="${up ? 'up' : ''}">${esc(k)} ${esc(v)}</i>`).join('');
    if (strip !== prevStrip) {
      prevStrip = strip;
      els.statsStrip.innerHTML = strip;
    }

    if (game.lastUpgrade) {
      this.toast(game.lastUpgrade.label, game.lastUpgrade.kind);
      game.lastUpgrade = null;
    }
  },
};
