// DOM HUD + screens. UI/AUDIO-AGENT OWNS THIS FILE.
// The only module allowed to touch the DOM besides main.js bootstrap.

import { levelProgress } from './level.js';
import { audio } from './audio.js';

const $ = (id) => document.getElementById(id);

let els = null;
let toastTimer = null;

export const ui = {
  init(game, actions) {
    els = {
      hud: $('hud'),
      hpBar: $('hp-bar'), hpText: $('hp-text'),
      progressBar: $('progress-bar'), progressMarker: $('progress-marker'),
      score: $('score'),
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
      muteBtn: $('mute-btn'),
    };
    $('btn-start').addEventListener('click', actions.start);
    $('btn-retry').addEventListener('click', actions.restart);
    $('btn-again').addEventListener('click', actions.restart);
    $('btn-resume').addEventListener('click', actions.resume);
    $('btn-quit').addEventListener('click', actions.quit);
    els.muteBtn.addEventListener('click', actions.mute);
    $('pause-btn').addEventListener('click', actions.pause);
  },

  showScreen(state) {
    for (const [name, el] of Object.entries(els.screens)) {
      el.classList.toggle('hidden', name !== state);
    }
    els.hud.classList.toggle('hidden', !(state === null || state === 'pause'));
  },

  setMuted(m) { els.muteBtn.textContent = m ? '🔇' : '🔊'; },

  toast(label, kind) {
    const t = els.toast;
    t.textContent = label;
    t.className = kind === 'good' ? '' : kind;
    t.classList.remove('hidden');
    // retrigger CSS animation
    t.style.animation = 'none';
    void t.offsetHeight;
    t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1400);
  },

  showEnd(game, victory) {
    const lines = [
      `Score: <b>${game.score}</b>`,
      `Kills: <b>${game.kills}</b>`,
      `Distance: <b>${Math.round(game.player.z / 10)}m</b>`,
    ].join('<br>');
    if (victory) els.victoryStats.innerHTML = lines;
    else els.defeatStats.innerHTML = lines;
  },

  update(game) {
    const p = game.player;
    const hpFrac = Math.max(p.hp / p.maxHp, 0);
    els.hpBar.style.width = `${hpFrac * 100}%`;
    els.hpBar.classList.toggle('low', hpFrac < 0.3);
    els.hpText.textContent = Math.ceil(p.hp);
    els.score.textContent = game.score;

    const prog = levelProgress(game) * 100;
    els.progressBar.style.width = `${prog}%`;
    els.progressMarker.style.left = `${prog}%`;

    if (game.boss && !game.boss.dead) {
      els.bossWrap.classList.remove('hidden');
      els.bossName.textContent = game.boss.def.name || 'BOSS';
      els.bossBar.style.width = `${(game.boss.hp / game.boss.maxHp) * 100}%`;
    } else {
      els.bossWrap.classList.add('hidden');
    }

    const s = p.stats;
    const parts = [
      `DMG ${Math.round(s.damage)}`,
      `ROF ${(1 / s.fireInterval).toFixed(1)}/s`,
      `SHOTS ${s.projectiles}`,
    ];
    if (s.squad > 0) parts.push(`ALLIES ${s.squad}`);
    if (s.pierce > 0) parts.push(`PIERCE ${s.pierce}`);
    if (s.explosive > 0) parts.push(`💥`);
    if (s.critChance > 0) parts.push(`CRIT ${Math.round(s.critChance * 100)}%`);
    els.statsStrip.textContent = parts.join('  ·  ');

    if (game.lastUpgrade) {
      this.toast(game.lastUpgrade.label, game.lastUpgrade.kind);
      game.lastUpgrade = null;
    }
  },
};
