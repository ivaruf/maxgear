// DOM HUD + screens. UI/AUDIO-AGENT OWNS THIS FILE.
// The only module allowed to touch the DOM besides main.js bootstrap.
// No top-level DOM access: every lookup / node build happens inside ui.init().
//
// v1.2 (level tracks + colored icons):
//   * the gate legend is now icon + text: ui.init() builds two 16px <canvas>
//     and one <b class="gl-txt"> inside each legend span (index.html keeps its
//     two empty spans; we never overwrite them, only their children),
//   * the stats strip and the end-screen build rows read player.tracks (the
//     level map) and render 5-pip chips with <img> glyphs baked by icons.js,
//   * icon bakes are memoized by icons.js; a devicePixelRatio change drops the
//     cache and re-sizes the legend canvases (ui owns that resize listener).
// Every id/class hook that existed before still works.

import { levelProgress } from './level.js';
import { BASE_STATS, PLAYER_DEFAULTS } from './config.js';
import { audio } from './audio.js';
import {
  ENTRIES, TRACKS, TRACK_ORDER, OFFENSE_TRACKS, DEFENCE_TRACKS,
  trackLevel, previewSlot, slotLabel,
} from './upgrades.js';
import { bakeIconSprite, iconDataURL, clearIconCache, hasIcon, drawIcon } from './icons.js';

const $ = (id) => document.getElementById(id);

let els = null;

// --- icon plumbing -----------------------------------------------------------
const GL_PX = 16;        // legend icon box, CSS px (fixed: the bake is cached per size)
const CHIP_BAKE = 20;    // bake size for <img> chips — >=16 keeps the COLOR palette
                         // (icons.js flattens to mono below 13px of glyph), then CSS
                         // scales it down to 12px (strip) / 14px (end screen)
const GREY = '#8a93a8';  // defused / inert wash
const PIPS = 5;          // every track chip shows five boxes (LV5 is the design cap)
const STRIP_CAP = 6;     // max track chips in the HUD strip…
const STRIP_CAP_SM = 5;  // …5 on small phones (design §B6)
const MINUS = '−';  // proper minus sign for the bad-gate copy

// One short label per track for the cramped HUD strip (the end screen uses the
// full name from upgrades.js). Presentation only, so it lives here.
const SHORT = {
  damage: 'HEAVY', fireRate: 'DRAUGHT', multishot: 'SPLIT', homing: 'GYRO',
  lance: 'LANCE', blast: 'BOMB', arc: 'TESLA', burn: 'BURN', frost: 'CRYO',
  crit: 'CRIT', saw: 'SAWS', broadside: 'BROAD', shrapnel: 'BURST',
  squad: 'ESCORT', plating: 'ARMOUR', aegis: 'AEGIS', siphon: 'SIPHON',
  thrust: 'THRUST',
};

const EMPTY = [];

let dpr = 1;
// [{ span, cvs:[canvas,canvas], ctxs:[ctx,ctx], txt }] — built in ui.init()
let legend = [];

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
let prevLegend = '';
let prevLevels = null;   // { key: level } as last RENDERED — drives the .bump pop

function esc(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// window in the browser, the global object anywhere else (harnesses stub it).
function win() {
  if (typeof window !== 'undefined' && window) return window;
  return typeof globalThis !== 'undefined' ? globalThis : null;
}

function readDpr() {
  const w = win();
  const d = w && w.devicePixelRatio;
  return Number.isFinite(d) && d > 0 ? Math.min(d, 2) : 1;
}

function smallScreen() {
  const w = win();
  const px = w && w.innerWidth;
  return Number.isFinite(px) && px > 0 && px <= 380;
}

// The legend drops to 10.5px / two padded spans at this width (see style.css);
// below it a two-slot row has ~24 characters per span, so the copy goes compact.
function narrowLegend() {
  const w = win();
  const px = w && w.innerWidth;
  return Number.isFinite(px) && px > 0 && px <= 600;
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
  // className assignment also clears .hidden -> element becomes visible.
  // Only bad/mixed have their own skin; 'good'/'utility'/anything else = default.
  t.className = item.kind === 'bad' || item.kind === 'mixed' ? item.kind : '';
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

// ============================================================================
// Level tracks -> chips
// ============================================================================

// Owned tracks (level !== 0), strongest first. Sorted by |level| so a NEGATIVE
// ARMOUR PLATE (glass cannon / rust) stays visible instead of sinking last —
// it is the most dangerous number on the strip. Ties keep TRACK_ORDER.
function ownedTracks(p) {
  const out = [];
  for (let i = 0; i < TRACK_ORDER.length; i++) {
    const key = TRACK_ORDER[i];
    const lv = trackLevel(p, key);
    if (lv) out.push({ key, lv, i, w: Math.abs(lv) });
  }
  out.sort((a, b) => (b.w - a.w) || (a.i - b.i));
  return out;
}

// One allocation-light string per frame: the strip only rebuilds when this
// changes (levels + the two numeric readouts + the responsive chip cap).
function stripSig(p) {
  const s = p.stats || BASE_STATS;
  let sig = `${Math.round(s.damage)}|${(1 / s.fireInterval).toFixed(1)}|${smallScreen() ? 5 : 6}|`;
  for (let i = 0; i < TRACK_ORDER.length; i++) {
    const key = TRACK_ORDER[i];
    const lv = trackLevel(p, key);
    if (lv) sig += `${key}${lv},`;
  }
  return sig;
}

function levelMap(list) {
  const out = {};
  for (const t of list) out[t.key] = t.lv;
  return out;
}

// Five CSS boxes. Negative levels (ARMOUR PLATE only) fill red, not brass.
function pipsHTML(lv) {
  const n = Math.min(PIPS, Math.abs(Math.round(lv)));
  const neg = lv < 0;
  let out = '<b class="pips">';
  for (let i = 0; i < PIPS; i++) {
    out += i < n ? `<span class="pip on${neg ? ' neg' : ''}"></span>` : '<span class="pip off"></span>';
  }
  return `${out}</b>`;
}

// <img> glyph from the memoized data-URL bake. Empty string when there is no
// DOM/2d context (headless) or no painter for that key — the chip still reads.
function chipIcon(icon, lv, px) {
  if (!icon) return '';
  const url = iconDataURL(icon, CHIP_BAKE, dpr, lv < 0 ? { negative: true } : null);
  return url ? `<img class="chip-ico" src="${url}" alt="" width="${px}" height="${px}">` : '';
}

function trackChip(key, lv, px, full, bumped) {
  const def = TRACKS[key];
  if (!def) return '';
  const cls = [lv < 0 ? 'down' : 'up'];
  if (bumped) cls.push('bump');
  const label = full ? def.name : (SHORT[key] || def.name);
  return `<i class="${cls.join(' ')}">${chipIcon(def.icon, lv, px)}<em>${esc(label)}</em>${pipsHTML(lv)}</i>`;
}

const numChip = (k, v, up) => `<i class="num${up ? ' up' : ''}"><em>${esc(k)}</em>${esc(v)}</i>`;

// HUD strip: DMG + ROF numerics, then the strongest track chips (design §B6).
function stripHTML(p, list, bump) {
  const s = p.stats || BASE_STATS;
  let html = numChip('DMG', Math.round(s.damage), s.damage > BASE_STATS.damage)
    + numChip('ROF', `${(1 / s.fireInterval).toFixed(1)}/s`, s.fireInterval < BASE_STATS.fireInterval);
  const cap = smallScreen() ? STRIP_CAP_SM : STRIP_CAP;
  const shown = Math.min(list.length, cap);
  for (let i = 0; i < shown; i++) {
    const t = list[i];
    html += trackChip(t.key, t.lv, 12, false, !!bump && bump[t.key] !== t.lv);
  }
  if (list.length > shown) html += `<i class="more">+${list.length - shown}</i>`;
  return html;
}

// End-screen "FINAL BUILD": a numeric CORE line, then OFFENSE / DEFENCE rows.
function groupHTML(cap, inner) {
  return inner ? `<div class="build-grp"><span class="grp-cap">${cap}</span>${inner}</div>` : '';
}

function trackGroup(p, cap, keys, px) {
  let inner = '';
  for (const key of keys) {
    const lv = trackLevel(p, key);
    if (lv) inner += trackChip(key, lv, px, true, false);
  }
  return groupHTML(cap, inner);
}

function buildChips(p) {
  const s = p.stats || BASE_STATS;
  const hull = Math.round(Number.isFinite(p.maxHp) ? p.maxHp : (s.maxHp || PLAYER_DEFAULTS.maxHp));
  const core = numChip('DMG', Math.round(s.damage), s.damage > BASE_STATS.damage)
    + numChip('ROF', `${(1 / s.fireInterval).toFixed(1)}/s`, s.fireInterval < BASE_STATS.fireInterval)
    + numChip('SHOTS', s.projectiles, s.projectiles > BASE_STATS.projectiles)
    + numChip('HULL', hull, hull > PLAYER_DEFAULTS.maxHp);
  return groupHTML('CORE', core)
    + trackGroup(p, 'OFFENSE', OFFENSE_TRACKS, 14)
    + trackGroup(p, 'DEFENCE', DEFENCE_TRACKS, 14);
}

// ============================================================================
// Gate legend (icons + text for the icon-only panels out in the field)
// ============================================================================

// Cheap per-frame identity of what the legend is showing. MUST cover the icon
// (slot.key / previewKey), the level numerals (levels + preview from/to) and
// the ⌖ prefix (chargeable), or a charged-up slot would keep a stale label.
function legendKey(slots) {
  let key = '';
  for (let i = 0; i < 2; i++) {
    const s = slots[i];
    if (!s) { key += '-|'; continue; }
    key += `${s.key}|${s.levels}|${s.levelCap}|${s.previewKey || ''}|`
      + `${s.previewFrom == null ? '' : s.previewFrom}|${s.previewTo == null ? '' : s.previewTo}|`
      + `${s.chargeable ? 1 : 0}|`;
  }
  return key;
}

// Everything the legend needs about one slot, resolved defensively: gates.js
// refreshes previewKey/previewName/previewFrom/previewTo every frame, but they
// may briefly be null (first frame after a row spawns) — fall back to the pure
// previewSlot() from upgrades.js, which reads player.tracks directly.
function slotView(p, slot, tight) {
  const up = slot.up || ENTRIES[slot.key] || null;
  const raw = up && up.kind;
  const kind = raw === 'bad' || raw === 'mixed' ? raw : 'good';
  const levels = Number.isFinite(slot.levels) ? slot.levels : 0;
  const cap = Number.isFinite(slot.levelCap) ? slot.levelCap : levels;
  const chargeable = slot.chargeable == null ? levels < cap : !!slot.chargeable;
  const defused = kind === 'bad' && levels === 0;

  let name = slot.previewName || null;
  let from = Number.isFinite(slot.previewFrom) ? slot.previewFrom : null;
  let to = Number.isFinite(slot.previewTo) ? slot.previewTo : null;
  if (from === null || to === null || !name) {
    const pv = previewSlot(p, slot.key, levels);
    if (from === null) from = pv.from;
    if (to === null) to = pv.to;
    if (!name) name = pv.name;
  }

  // Icons: tracks/instants/bad = one glyph; mixed = gain + loss (two canvases).
  const track = up && up.track ? up : null;
  const gainKey = slot.previewKey || (track ? track.key : null);
  const gainDef = gainKey ? TRACKS[gainKey] : null;
  const iconA = kind === 'mixed' ? (up && up.iconGain) : (up && up.icon) || (gainDef && gainDef.icon);
  const iconB = kind === 'mixed' ? (up && up.iconLoss) : null;
  // Level numeral on the gain glyph = where this gate LEAVES the track.
  const levelA = kind === 'bad' ? 0 : Math.max(0, to || 0);
  const maxA = (track && track.maxLv) || (gainDef && gainDef.maxLv) || 5;

  return { up, key: slot.key, kind, levels, chargeable, defused, name, from, to, iconA, iconB, levelA, maxA, tight };
}

// Trade copy for a cramped row: SHORT names instead of the full display names
// ('+2 HEAVY / -2 ARMOUR' instead of '+2 HEAVY SHOT / -2 ARMOUR PLATE').
function shortTrade(up, levels) {
  const t = up.trade;
  const nm = (k) => SHORT[k] || (TRACKS[k] && TRACKS[k].name) || k;
  const gain = `+${Math.max(1, levels || t.gainLv)} ${nm(t.gainKey)}`;
  const loss = t.loseKey
    ? `${t.loseLv} ${nm(t.loseKey)}`
    : `${MINUS}${Math.round((t.instantDamageFrac || 0) * 100)}% HP`;
  return `${gain} / ${loss}`;
}

function slotText(p, v) {
  if (v.defused) return 'DEFUSED';
  const up = v.up;
  const tight = v.tight;
  let body;
  if (up && up.track) {
    body = `${up.name} LV${v.from} → LV${v.to}`;
  } else if (up && up.key === 'rust') {
    // RUST eats your best offensive track — previewName is that live victim.
    const victim = !tight && v.name && v.name !== up.name ? ` · ${v.name}` : '';
    body = `RUST ${MINUS}${Math.abs(v.levels)} LV${victim}`;
  } else if (up && up.trade && tight) {
    body = shortTrade(up, v.levels);
  } else if (up) {
    body = slotLabel(p, up.key, v.levels);  // 'REPAIR · HEAL 40%' / full trade copy
  } else {
    body = v.name || String(v.key);
  }
  if (!v.chargeable) return body;
  if (v.kind === 'bad') return `${tight ? '⌖ DEFUSE · ' : '⌖ SHOOT TO DEFUSE · '}${body}`;
  return `${tight ? '⌖ ' : '⌖ SHOOT: '}${body}`;
}

function sizeLegendCanvas(node, i) {
  const c = node.cvs[i];
  if (!c) return;
  const px = Math.max(1, Math.round(GL_PX * dpr));
  if (c.width !== px) { c.width = px; c.height = px; }
  const g = node.ctxs[i];
  if (g && typeof g.setTransform === 'function') g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// One drawImage from the shared bake cache (design §B). Returns false when the
// glyph is unknown / there is no context, so the caller can hide the canvas.
function paintLegendIcon(node, i, name, level, maxLevel, grey, negative) {
  const g = node.ctxs[i];
  const c = node.cvs[i];
  if (!g || !c) return false;
  if (typeof g.clearRect === 'function') g.clearRect(0, 0, GL_PX, GL_PX);
  if (!name || (!hasIcon(name) && !negative)) return false;
  const opts = grey ? { mono: GREY } : (negative ? { negative: true } : (level > 0 ? { level, maxLevel } : null));
  const sprite = bakeIconSprite(name, GL_PX, dpr, opts);
  if (sprite && typeof g.drawImage === 'function') {
    g.drawImage(sprite, 0, 0, GL_PX, GL_PX);
    return true;
  }
  // No offscreen canvas available: paint straight onto the legend canvas.
  return drawIcon(g, name, GL_PX / 2, GL_PX / 2, GL_PX * 0.875, grey ? GREY : null, opts);
}

// The power-up rail lives on the LEFT edge now (v1.2.1), so the legend owns
// the bottom and needs no measured lift anymore.
function liftLegend() {}

// The span carries the kind classes, so it is rewritten wholesale (its canvases
// and .gl-txt are CHILDREN and survive) — never touch its innerHTML.
function setSpanClass(span, kind, defused, hidden) {
  let cls = kind || '';
  if (defused) cls += ' defused';
  if (hidden) cls += ' hidden';
  span.className = cls.trim();
}

function paintLegend(p, slots) {
  // two spans on a phone = ~24 characters each, so the copy goes compact there
  const tight = slots.length > 1 && narrowLegend();
  for (let i = 0; i < legend.length; i++) {
    const node = legend[i];
    if (!node) continue;
    const slot = slots[i];
    if (!slot) { setSpanClass(node.span, '', false, true); continue; }
    const v = slotView(p, slot, tight);
    node.txt.textContent = slotText(p, v);
    setSpanClass(node.span, v.kind, v.defused, false);
    const okA = paintLegendIcon(node, 0, v.iconA, v.levelA, v.maxA, v.defused, false);
    node.cvs[0].classList.toggle('hidden', !okA);
    const okB = v.iconB ? paintLegendIcon(node, 1, v.iconB, 0, v.maxA, v.defused, true) : false;
    node.cvs[1].classList.toggle('hidden', !okB);
  }
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
      gateLegend: $('gate-legend'), glLeft: $('gl-left'), glRight: $('gl-right'),
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

    // --- legend nodes: 2 icon canvases + one text slab per span --------------
    dpr = readDpr();
    legend = [els.glLeft, els.glRight].map((span) => {
      if (!span || typeof document.createElement !== 'function') return null;
      const node = { span, cvs: [], ctxs: [], txt: null };
      for (let i = 0; i < 2; i++) {
        const c = document.createElement('canvas');
        c.className = i ? 'gl-ico hidden' : 'gl-ico';   // slot 1 only shows for mixed rows
        node.cvs.push(c);
        node.ctxs.push((c.getContext && c.getContext('2d')) || null);
        sizeLegendCanvas(node, i);
        if (span.appendChild) span.appendChild(c);
      }
      const txt = document.createElement('b');
      txt.className = 'gl-txt';
      node.txt = txt;
      if (span.appendChild) span.appendChild(txt);
      return node;
    });

    // A devicePixelRatio change invalidates every bake (they are baked at dpr).
    // Any resize also re-evaluates the responsive chip cap, so drop the caches.
    const w = win();
    if (w && typeof w.addEventListener === 'function') {
      w.addEventListener('resize', () => {
        const d = readDpr();
        if (d !== dpr) {
          dpr = d;
          clearIconCache();
          for (const node of legend) {
            if (!node) continue;
            sizeLegendCanvas(node, 0);
            sizeLegendCanvas(node, 1);
          }
        }
        prevLegend = '';
        prevStrip = '';
        prevLevels = null;
      });
    }

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
    if (state === null || state === 'title') {
      // fresh run (or back to title): the build is wiped, so re-render the strip
      // from scratch and never .bump against the previous run's levels
      prevStrip = '';
      prevLegend = '';
      prevLevels = null;
    }
    if (state === 'title') {
      prevScore = 0;
      prevAct = null;
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

    // --- Approaching-gate legend: icons + text for the panels in the field ---
    let gate = null;
    for (const g of (game.gates || EMPTY)) {
      if (!g.used && !g.dead && g.z > p.z && g.z - p.z < 1200 && (!gate || g.z < gate.z)) gate = g;
    }
    if (gate && gate.slots && gate.slots.length) {
      const slots = gate.slots.length > 1
        ? [...gate.slots].sort((a, b) => a.x - b.x)
        : gate.slots;
      const key = legendKey(slots);
      if (key !== prevLegend) {
        prevLegend = key;
        paintLegend(p, slots);
      }
      els.gateLegend.classList.remove('hidden');
    } else if (prevLegend !== '') {
      prevLegend = '';
      els.gateLegend.classList.add('hidden');
    }

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

    // --- Build strip: DMG/ROF + pip chips straight off player.tracks ---
    // The signature deliberately EXCLUDES the .bump flag: rebuilding only on a
    // real change is what lets the pop animation play out on the new node.
    const sig = stripSig(p);
    if (sig !== prevStrip) {
      prevStrip = sig;
      const list = ownedTracks(p);
      els.statsStrip.innerHTML = stripHTML(p, list, prevLevels);
      prevLevels = levelMap(list);
      liftLegend();
    }

    if (game.lastUpgrade) {
      this.toast(game.lastUpgrade.label, game.lastUpgrade.kind);
      game.lastUpgrade = null;
    }
  },
};
