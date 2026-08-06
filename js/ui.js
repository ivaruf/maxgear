// DOM HUD + screens. UI/AUDIO-AGENT OWNS THIS FILE.
// The only module allowed to touch the DOM besides main.js bootstrap.
// No top-level DOM access: every lookup / node build happens inside ui.init().
//
// v1.2 (level tracks + colored icons):
//   * the gate legend is now icon + text: ui.init() builds two 16px <canvas>
//     and one <b class="gl-txt"> inside each legend span (index.html keeps its
//     empty spans; we never overwrite them, only their children),
//   * the stats strip and the end-screen build rows read player.tracks (the
//     level map) and render 5-pip chips with <img> glyphs baked by icons.js,
//   * icon bakes are memoized by icons.js; a devicePixelRatio change drops the
//     cache and re-sizes the legend canvases (ui owns that resize listener).
// v1.3: gate rows can hold THREE slots, so the legend has three spans
//   (#gl-left / #gl-mid / #gl-right). Slots arrive sorted by x and map onto the
//   spans so every chip sits under the panel it describes: 3 -> all three,
//   2 -> the outer two, 1 -> the middle one. Unused spans are hidden AND reset.
// Every id/class hook that existed before still works.

import { levelProgress } from './level.js';
import { BASE_STATS, PLAYER_DEFAULTS } from './config.js';
import { audio } from './audio.js';
import {
  ENTRIES, TRACKS, TRACK_ORDER, OFFENSE_TRACKS, DEFENCE_TRACKS,
  trackLevel, previewSlot, slotLabel,
} from './upgrades.js';
import { bakeIconSprite, iconDataURL, clearIconCache, hasIcon, drawIcon } from './icons.js';
import { startPreview } from './previews.js';

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
// [{ span, cvs:[canvas,canvas], ctxs:[ctx,ctx], txt }] — built in ui.init(),
// in DOM order: left, mid, right.
let legend = [];
const GL_SPAN_COUNT = 3;
// slot index (sorted by x) -> legend span index, by how many slots the row has.
const SPAN_FOR = { 1: [1], 2: [0, 2], 3: [0, 1, 2] };

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
let armedDelete = -1;    // slot index with an armed two-tap delete
let armedTimer = null;
// v1.5 level-clear KEEP screen state
let lcSelection = new Set();
let lcNeed = 0;
let lcOwned = [];        // [{key, lv}]
let lcBrowse = null;     // key shown in the detail pane
let lcStop = null;       // running preview's stop()
// v1.5.1 armoury (view-all-powers) state
let pwBrowse = null;
let pwLevel = 3;         // preview level, 1..5 (clickable pips)
let pwStop = null;
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

// The legend drops to 10.5px / padded spans at this width (see style.css);
// below it a two-slot row has ~24 characters per span, so the copy goes compact.
function narrowLegend() {
  const w = win();
  const px = w && w.innerWidth;
  return Number.isFinite(px) && px > 0 && px <= 600;
}

// A THREE-chip legend cannot carry the full copy anywhere near a phone: at 12px
// display type '⌖ SHOOT: TESLA COIL LV1 → LV3' is ~220px, and a chip adds ~44px
// of icon + padding, so three of them want ~830px of viewport. Below that the
// chips would ellipsise away the '→ LV5' that matters, so the copy drops to the
// NAME only — the destination level is already drawn on the legend glyph.
const LEGEND_FULL_PX = 860;
function roomForThree() {
  const w = win();
  const px = w && w.innerWidth;
  return !Number.isFinite(px) || px <= 0 || px > LEGEND_FULL_PX;
}
// Copy tier for a row of n slots: 0 = full, 1 = tight (SHORT trade copy),
// 2 = cram (name only). CSS-independent on purpose: the breakpoint is about how
// many characters fit, which no media query can express.
function copyTier(n) {
  if (n >= 3 && !roomForThree()) return 2;
  if (n > 1 && narrowLegend()) return 1;
  return 0;
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

// Numeric chips carry a glyph too (DMG = shell, ROF = shell-stream…), so the
// whole rail is iconized; on phones the em label hides and icon+number remain.
const NUM_ICON = { DMG: 'shell', ROF: 'rof', SHOTS: 'fan', HULL: 'plate' };
const numChip = (k, v, up) =>
  `<i class="num${up ? ' up' : ''}">${chipIcon(NUM_ICON[k], 1, 12)}<em>${esc(k)}</em>${esc(v)}</i>`;

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
  for (let i = 0; i < GL_SPAN_COUNT; i++) {
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
function slotView(p, slot, tier) {
  const tight = tier >= 1;
  const cram = tier >= 2;
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

  return {
    up, key: slot.key, kind, levels, chargeable, defused, name,
    from, to, iconA, iconB, levelA, maxA, tight, cram,
  };
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
  if (v.cram) {
    // Three chips on anything short of a laptop: the NAME alone, because the
    // level numeral is already painted on the glyph beside it and a wrapped
    // 'LV1 → LV3' would be clipped by the two-line cap in style.css.
    body = (up && up.name) || v.name || String(v.key);
  } else if (up && up.track) {
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
  // ⌖ = "you can shoot this". In cram the bare crosshair has to carry it for bad
  // slots too: '⌖ DEFUSE · HULL BREACH' needs a third line no phone chip has.
  if (v.kind === 'bad' && !v.cram) return `${tight ? '⌖ DEFUSE · ' : '⌖ SHOOT TO DEFUSE · '}${body}`;
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

// Blank a span nothing is using: hidden AND emptied, so a stale label can never
// reappear when the next row happens to light that span up again.
function clearLegendSpan(node) {
  if (!node) return;
  setSpanClass(node.span, '', false, true);
  node.txt.textContent = '';
  for (let i = 0; i < node.cvs.length; i++) {
    if (node.cvs[i]) node.cvs[i].classList.add('hidden');
  }
}

// Legend off: hide the rail and blank every span (all three).
function hideLegend() {
  if (!els) return;
  els.gateLegend.classList.add('hidden');
  for (let i = 0; i < legend.length; i++) clearLegendSpan(legend[i]);
}

// Which spans a row of n slots lights up. Normally straight out of SPAN_FOR, but
// a browser holding a STALE cached index.html may have no #gl-mid (sw.js caches
// the HTML), and a lone slot must never render as an empty chip — so fall back to
// whatever spans were actually built, in DOM order.
function legendTargets(n) {
  const want = SPAN_FOR[n] || SPAN_FOR[3];
  let okAll = true;
  for (let i = 0; i < want.length; i++) if (!legend[want[i]]) okAll = false;
  if (okAll) return want;
  const have = [];
  for (let i = 0; i < legend.length; i++) if (legend[i]) have.push(i);
  return have.slice(0, n);
}

function paintLegend(p, slots) {
  // slots arrive sorted by x; 1 -> middle span, 2 -> outer spans, 3 -> all three
  const n = Math.min(slots.length, GL_SPAN_COUNT);
  const map = legendTargets(n);
  const tier = copyTier(n);
  const used = [];
  for (let i = 0; i < map.length; i++) {
    const node = legend[map[i]];
    if (!node) continue;
    used.push(map[i]);
    const v = slotView(p, slots[i], tier);
    node.txt.textContent = slotText(p, v);
    setSpanClass(node.span, v.kind, v.defused, false);
    const okA = paintLegendIcon(node, 0, v.iconA, v.levelA, v.maxA, v.defused, false);
    node.cvs[0].classList.toggle('hidden', !okA);
    const okB = v.iconB ? paintLegendIcon(node, 1, v.iconB, 0, v.maxA, v.defused, true) : false;
    node.cvs[1].classList.toggle('hidden', !okB);
  }
  for (let i = 0; i < legend.length; i++) {
    if (used.indexOf(i) < 0) clearLegendSpan(legend[i]);
  }
}

// ---- v1.5.1 armoury internals -------------------------------------------------
const TIER_NOTE = {
  1: 'AVAILABLE FROM THE OUTSKIRTS (LEVEL 1)',
  2: 'UNLOCKS IN THE FOUNDRY (LEVEL 2)',
  3: 'UNLOCKS IN THE SHIPYARDS (LEVEL 3)',
};

function stopPowerPreview() {
  if (pwStop) { try { pwStop(); } catch (e) { /* noop */ } pwStop = null; }
}

function browsePower(key, force = false) {
  if (!key || (!force && key === pwBrowse)) pwBrowse = key || pwBrowse;
  pwBrowse = key || pwBrowse;
  const def = TRACKS[pwBrowse];
  if (!els || !def) return;
  els.pwDname.textContent = `${def.name} \u00b7 LV${pwLevel}`;
  els.pwDblurb.textContent = def.blurb || '';
  els.pwDtier.textContent = TIER_NOTE[def.tier ?? 1] || '';
  els.pwLvls.innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" data-lv="${n}" class="${n <= pwLevel ? 'on' : ''}" aria-label="Level ${n}"></button>`).join('');
  for (const card of els.pwGrid.querySelectorAll('[data-pw]')) {
    card.classList.toggle('browse', card.dataset.pw === pwBrowse);
  }
  stopPowerPreview();
  pwStop = startPreview(els.pwPreview, pwBrowse, pwLevel);
}

// ---- v1.5 KEEP screen internals ---------------------------------------------
function stopKeepPreview() {
  if (lcStop) { try { lcStop(); } catch (e) { /* noop */ } lcStop = null; }
}

function browseKeep(key) {
  lcBrowse = key;
  const def = TRACKS[key];
  const own = lcOwned.find((o) => o.key === key);
  if (!els || !def || !own) return;
  els.lcDname.textContent = `${def.name} · LV${own.lv}`;
  els.lcDblurb.textContent = def.blurb || '';
  stopKeepPreview();
  lcStop = startPreview(els.lcPreview, key, own.lv);
}

function paintKeepGrid() {
  if (!els) return;
  for (const card of els.lcGrid.querySelectorAll('[data-keep]')) {
    card.classList.toggle('keep', lcSelection.has(card.dataset.keep));
    card.classList.toggle('browse', card.dataset.keep === lcBrowse);
  }
  const ready = lcSelection.size === lcNeed;
  els.btnContinue.disabled = !ready;
  els.btnContinue.classList.toggle('pulse', ready);
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
      gateLegend: $('gate-legend'),
      glLeft: $('gl-left'), glMid: $('gl-mid'), glRight: $('gl-right'),
      toast: $('upgrade-toast'),
      statsStrip: $('stats-strip'),
      screens: {
        title: $('screen-title'),
        pause: $('screen-pause'),
        defeat: $('screen-defeat'),
        victory: $('screen-victory'),
        powers: $('screen-powers'),
        slots: $('screen-slots'),
        newgame: $('screen-newgame'),
        levelclear: $('screen-levelclear'),
      },
      slotList: $('slot-list'),
      diffList: $('diff-list'),
      lcHeading: $('lc-heading'), lcSub: $('lc-sub'),
      lcStats: $('lc-stats'), lcNote: $('lc-note'),
      lcGrid: $('lc-grid'), lcPreview: $('lc-preview'),
      lcDname: $('lc-dname'), lcDblurb: $('lc-dblurb'),
      btnContinue: $('btn-continue'),
      pwGrid: $('pw-grid'), pwPreview: $('pw-preview'),
      pwDname: $('pw-dname'), pwDblurb: $('pw-dblurb'),
      pwDtier: $('pw-dtier'), pwLvls: $('pw-lvls'),
      victorySub: $('victory-sub'),
      defeatStats: $('defeat-stats'),
      victoryStats: $('victory-stats'),
      defeatBuild: $('defeat-build'),
      victoryBuild: $('victory-build'),
      muteBtn: $('mute-btn'),
      btnUpdate: $('btn-update'), versionTag: $('game-version'),
    };

    // --- legend nodes: 2 icon canvases + one text slab per span --------------
    // Three spans in DOM order (left, mid, right) = up to three gate slots.
    dpr = readDpr();
    legend = [els.glLeft, els.glMid, els.glRight].map((span) => {
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

    // ---- campaign screens (v1.4) -------------------------------------------
    tap($('btn-continue'), () => {
      const keys = ui.levelClearSelection();
      if (keys) actions.confirmKeep(keys);
    });
    if (els.lcGrid) {
      els.lcGrid.addEventListener('click', (ev) => {
        const card = ev.target.closest('[data-keep]');
        if (!card) return;
        const key = card.dataset.keep;
        if (lcSelection.has(key)) lcSelection.delete(key);
        else if (lcSelection.size < lcNeed) lcSelection.add(key);
        else { card.classList.remove('deny'); void card.offsetWidth; card.classList.add('deny'); }
        audio.click();
        browseKeep(key);
        paintKeepGrid();
      });
      els.lcGrid.addEventListener('mouseover', (ev) => {
        const card = ev.target.closest('[data-keep]');
        if (card && card.dataset.keep !== lcBrowse) browseKeep(card.dataset.keep);
      });
    }
    tap($('btn-slots-back'), actions.backToTitle);
    tap($('btn-powers'), actions.showPowers);
    tap($('btn-powers-back'), actions.backToTitle);
    if (els.pwGrid) {
      const browse = (ev) => {
        const card = ev.target.closest('[data-pw]');
        if (card && card.dataset.pw !== pwBrowse) { browsePower(card.dataset.pw); }
      };
      els.pwGrid.addEventListener('click', (ev) => { browse(ev); audio.click(); });
      els.pwGrid.addEventListener('mouseover', browse);
      els.pwLvls.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-lv]');
        if (!b) return;
        pwLevel = +b.dataset.lv;
        audio.click();
        browsePower(pwBrowse, true);
      });
    }
    tap($('btn-newgame-back'), actions.backToSlots);

    // Difficulty cards are static: build once.
    if (els.diffList) {
      const DIFFS = [
        ['easy', 'EASY', 'A Sunday drive. Gentler machines.'],
        ['medium', 'MEDIUM', 'The intended experience.'],
        ['hard', 'HARD', 'Boilers screaming. Bring armour.'],
      ];
      els.diffList.innerHTML = DIFFS.map(([k, label, blurb]) =>
        `<button class="pick-card diff-${k}" data-diff="${k}" type="button">
           <b>${label}</b><span>${blurb}</span></button>`).join('');
      els.diffList.addEventListener('click', (ev) => {
        const card = ev.target.closest('[data-diff]');
        if (card) { audio.click(); actions.pickDifficulty(card.dataset.diff); }
      });
    }

    // Slot cards are rebuilt by showSlots(); one delegated listener handles
    // resume / new-game / two-tap delete.
    if (els.slotList) {
      els.slotList.addEventListener('click', (ev) => {
        const del = ev.target.closest('[data-del]');
        if (del) {
          const i = +del.dataset.del;
          if (armedDelete === i) { armedDelete = -1; audio.click(); actions.deleteSlot(i); }
          else {
            armedDelete = i;
            del.textContent = '\u2715 SURE?';
            del.classList.add('armed');
            clearTimeout(armedTimer);
            armedTimer = setTimeout(() => {
              armedDelete = -1;
              del.textContent = '\u2715';
              del.classList.remove('armed');
            }, 3000);
          }
          ev.stopPropagation();
          return;
        }
        const card = ev.target.closest('[data-slot]');
        if (card) { audio.click(); actions.pickSlot(+card.dataset.slot); }
      });
    }

    // v1.5.2 opt-in update: stopPropagation so the tap doesn't bubble into the
    // title screen's click-anywhere-to-start handler below and launch a run
    // right as the page is about to reload.
    if (els.btnUpdate) {
      els.btnUpdate.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (els.btnUpdate.disabled) return;
        els.btnUpdate.disabled = true;
        els.btnUpdate.textContent = '⚙  UPDATING…';
        audio.click();
        actions.applyUpdate();
      });
    }

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
    if (state !== 'levelclear') stopKeepPreview(); // never leak a preview rAF loop
    if (state !== 'powers') stopPowerPreview();
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
      hideLegend();   // and no chip from the last run's gate row survives
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

  // v1.5.2: the version that is actually serving this session (from the SW).
  setVersion(v) {
    if (els && els.versionTag && v) els.versionTag.textContent = v;
  },

  // v1.5.2: a new worker is precached and waiting — surface the opt-in pill.
  offerUpdate(version) {
    if (!els || !els.btnUpdate) return;
    els.btnUpdate.disabled = false;
    els.btnUpdate.textContent = `⚙  ${version ? version + ' ' : ''}READY — TAP TO UPDATE`;
    els.btnUpdate.classList.remove('hidden');
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

  // v1.4: slots screen — cards are rebuilt on every show (the delegated click
  // listener in init() survives; two-tap delete state resets with the rebuild).
  showSlots(slots) {
    if (!els || !els.slotList) return;
    armedDelete = -1;
    const ago = (t) => {
      if (!t) return '';
      const m = Math.max(1, Math.round((Date.now() - t) / 60000));
      if (m < 60) return `${m}m ago`;
      const h = Math.round(m / 60);
      return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
    };
    els.slotList.innerHTML = slots.map((s, i) => {
      if (!s) {
        return `<button class="pick-card slot-card empty" data-slot="${i}" type="button">
          <b>SLOT ${i + 1}</b><span>EMPTY — NEW GAME</span></button>`;
      }
      const prog = s.cleared
        ? 'CAMPAIGN CLEARED ★'
        : `LEVEL ${Math.min(s.levelIndex + 1, 4)} / 4`;
      const diff = esc(String(s.difficulty || 'medium').toUpperCase());
      return `<div class="pick-card slot-card" data-slot="${i}" role="button" tabindex="0">
        <b>SLOT ${i + 1} · ${prog}</b>
        <span>${diff} · SCORE ${esc(s.score ?? 0)} · ${ago(s.updatedAt)}</span>
        <em class="slot-resume">${s.cleared ? 'REPLAY FINALE →' : 'RESUME →'}</em>
        <button class="slot-del" data-del="${i}" type="button" aria-label="Delete save">\u2715</button>
      </div>`;
    }).join('');
  },

  // v1.5: the KEEP screen — pick exactly `need` upgrades to carry forward.
  showLevelClear(game, info) {
    if (!els || !els.lcHeading) return;
    els.lcHeading.textContent = `LEVEL ${info.levelIndex + 1} CLEAR`;
    els.lcSub.textContent = `${info.name} secured \u00b7 next: ${info.next}`;
    els.lcStats.innerHTML = [
      ['SCORE', game.score],
      ['KILLS', game.kills],
    ].map(([k, v]) => `<div><b>${esc(v)}</b><span>${k}</span></div>`).join('');

    // Owned positive tracks only (rusted plating resets for free — no card).
    lcOwned = ownedTracks(game.player).filter((o) => o.lv > 0);
    lcNeed = Math.min(2, lcOwned.length);
    lcSelection = new Set(lcNeed < 2 ? lcOwned.map((o) => o.key) : []);
    if (lcOwned.length === 2) lcSelection = new Set(lcOwned.map((o) => o.key));

    els.lcNote.innerHTML = lcOwned.length > 2
      ? `CHOOSE <b>2</b> UPGRADES TO KEEP \u2014 THE REST IS SCRAPPED`
      : lcOwned.length
        ? 'FEWER THAN THREE UPGRADES \u2014 EVERYTHING SURVIVES THE CROSSING'
        : 'NO UPGRADES TO CARRY \u2014 FRESH BOILER AHEAD';

    els.lcGrid.innerHTML = lcOwned.map(({ key, lv }) => {
      const def = TRACKS[key];
      const icon = chipIcon(def.icon, lv, 20);
      return `<button class="keep-card" data-keep="${key}" type="button">
        ${icon}<em>${esc(def.name)}</em>${pipsHTML(lv)}</button>`;
    }).join('');

    if (lcOwned.length) browseKeep((lcOwned[0] || {}).key);
    else { stopKeepPreview(); els.lcDname.textContent = ''; els.lcDblurb.textContent = ''; }
    paintKeepGrid();
  },

  // v1.5.1: the armoury — every track, browsable, with live previews.
  showPowers() {
    if (!els || !els.pwGrid) return;
    els.pwGrid.innerHTML = TRACK_ORDER.map((key) => {
      const def = TRACKS[key];
      const tier = def.tier ?? 1;
      return `<button class="keep-card" data-pw="${key}" type="button">
        ${tier > 1 ? `<span class="tier-tag">${tier === 2 ? 'II' : 'III'}</span>` : ''}
        ${chipIcon(def.icon, pwLevel, 20)}<em>${esc(def.name)}</em></button>`;
    }).join('');
    browsePower(pwBrowse || TRACK_ORDER[0], true);
  },

  // Selection when complete, else null (main.js gates Space/continue on this).
  levelClearSelection() {
    return lcSelection.size === lcNeed ? [...lcSelection] : null;
  },

  showEnd(game, victory, extra = {}) {
    const p = game.player;
    if (els.victorySub) {
      if (victory && extra.campaignDone) {
        els.victorySub.textContent = `THE CAMPAIGN IS COMPLETE · ${extra.difficulty || ''}`.trim();
        els.victorySub.classList.remove('hidden');
      } else {
        els.victorySub.classList.add('hidden');
      }
    }
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
      hideLegend();
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
