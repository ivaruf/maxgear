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
// v1.10: TWO LANGUAGES. Every word this file writes comes from i18n.js as
//   tr(key) — `t` is taken by too many locals here (the toast node, a trade, a
//   track) to be the translator's name. Whatever this file builds at runtime it
//   can also rebuild: ui.relang() repaints every screen, label and readout in
//   place when the player switches language from the menu — no reload, no
//   restart, no unpause, the menu stays open — and main.js calls it on the
//   hub's `arcade:lang` event. The static markup is i18n.js's paintStatic().

import { levelProgress } from './level.js';
import { BASE_STATS, PLAYER_DEFAULTS } from './config.js';
import { audio } from './audio.js';
import {
  ENTRIES, TRACKS, TRACK_ORDER, OFFENSE_TRACKS, DEFENCE_TRACKS,
  trackLevel, previewSlot, slotLabel,
} from './upgrades.js';
import { bakeIconSprite, iconDataURL, clearIconCache, hasIcon, drawIcon } from './icons.js';
import { startPreview } from './previews.js';
import { t as tr, setLang } from './i18n.js';
import { levelDef } from './campaign.js';

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
// full name from upgrades.js). Presentation only; the words are i18n.js's
// 'short.<key>', falling back to the full name.
const shortName = (key) => (TRACKS[key] ? tr(`short.${key}`) : key);

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
let toastItem = null;      // the label on screen now, so relang() can say it again
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
let previewResize = 0;   // debounce for restarting a preview after a resize
let prevLevels = null;   // { key: level } as last RENDERED — drives the .bump pop
// v1.10: what each runtime-built screen was last painted FROM, so a language
// switch can paint it again in place rather than rebuilding it from the game.
let lastSlots = null;    // showSlots() argument
let lastLc = null;       // { game, info } for showLevelClear()
let lastEnd = null;      // { game, victory, extra } for showEnd()
let lastInRun = true;    // paintMenu() argument
let updateState = null;  // null | { version } | 'busy'
let exitRefused = false; // the browser would not close this tab
let exitLabel = null;    // () => the way-out words for this window

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
    toastItem = null;
    t.classList.add('hidden');
    return;
  }
  toastActive = true;
  toastItem = item;
  toastShownAt = Date.now();
  t.textContent = words(item.label);
  // className assignment also clears .hidden -> element becomes visible.
  // Only bad/mixed have their own skin; 'good'/'utility'/anything else = default.
  t.className = item.kind === 'bad' || item.kind === 'mixed' ? item.kind : '';
  // retrigger the CSS entry animation
  t.style.animation = 'none';
  void t.offsetHeight;
  t.style.animation = '';
  toastTimer = setTimeout(nextToast, toastQueue.length ? TOAST_RUSH : TOAST_HOLD);
}

// Upgrade labels arrive as functions (upgrades.js header) so they can be said
// again in another language; anything else is already words.
const words = (label) => (typeof label === 'function' ? label() : String(label ?? ''));

function clearToasts() {
  toastQueue.length = 0;
  toastActive = false;
  toastItem = null;
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
  const label = full ? def.name : shortName(key);
  return `<i class="${cls.join(' ')}">${chipIcon(def.icon, lv, px)}<em>${esc(label)}</em>${pipsHTML(lv)}</i>`;
}

// Numeric chips carry a glyph too (DMG = shell, ROF = shell-stream…), so the
// whole rail is iconized; on phones the em label hides and icon+number remain.
const NUM_ICON = { DMG: 'shell', ROF: 'rof', SHOTS: 'fan', HULL: 'plate' };
const numChip = (k, v, up) =>
  `<i class="num${up ? ' up' : ''}">${chipIcon(NUM_ICON[k], 1, 12)}<em>${esc(tr(`num.${k}`))}</em>${esc(v)}</i>`;

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
// The chips get a wrapper of their own so the three groups can share two
// columns — every caption right-aligned in the first, every run of chips
// starting at the same x in the second. Without it the caption and the chips
// are siblings, and `display: contents` on the group would hand each chip
// separately to the grid instead of the run as one cell.
function groupHTML(cap, inner) {
  return inner
    ? `<div class="build-grp"><span class="grp-cap">${cap}</span>` +
      `<div class="grp-chips">${inner}</div></div>`
    : '';
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
  return groupHTML(esc(tr('grp.core')), core)
    + trackGroup(p, esc(tr('grp.offense')), OFFENSE_TRACKS, 14)
    + trackGroup(p, esc(tr('grp.defence')), DEFENCE_TRACKS, 14);
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
  const nm = (k) => shortName(k);
  const gain = `+${Math.max(1, levels || t.gainLv)} ${nm(t.gainKey)}`;
  const loss = t.loseKey
    ? `${t.loseLv} ${nm(t.loseKey)}`
    : `${MINUS}${Math.round((t.instantDamageFrac || 0) * 100)}% ${tr('unit.hp')}`;
  return `${gain} / ${loss}`;
}

function slotText(p, v) {
  if (v.defused) return tr('desc.defused');
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
    body = `${up.name} ${MINUS}${Math.abs(v.levels)} LV${victim}`;
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
  if (v.kind === 'bad' && !v.cram) return `${tr(tight ? 'legend.defuseTight' : 'legend.shootDefuse')}${body}`;
  return `${tight ? '⌖ ' : tr('legend.shoot')}${body}`;
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
const tierNote = (tier) => (tier >= 1 && tier <= 3 ? tr(`tier.${tier}`) : '');

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
  els.pwDtier.textContent = tierNote(def.tier ?? 1);
  els.pwLvls.innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" data-lv="${n}" class="${n <= pwLevel ? 'on' : ''}" aria-label="${esc(tr('up.levelN', n))}"></button>`).join('');
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

// v1.6: pull the sound board's controls back into line with the audio module,
// which owns the values and remembers them. Called when the screen opens and
// after every move, so the fill, the readout and the lever never drift from
// what is actually playing. --fill is what paints brass into the channel; see
// the range rules in style.css.
function paintSoundBoard() {
  if (!els) return;
  const dial = (input, out, value) => {
    if (!input) return;
    const pct = Math.round(value * 100);
    if (+input.value !== pct) input.value = pct;
    input.style.setProperty('--fill', `${pct}%`);
    if (out) out.textContent = `${pct}%`;
  };
  dial(els.volMusic, els.volMusicVal, audio.musicVolume());
  dial(els.volSfx, els.volSfxVal, audio.sfxVolume());
  if (els.btnCutoff) {
    const m = audio.isMuted();
    els.btnCutoff.textContent = tr(m ? 'sound.off' : 'sound.on');
    els.btnCutoff.setAttribute('aria-pressed', m ? 'true' : 'false');
  }
}

function paintDifficulties() {
  if (!els || !els.diffList) return;
  els.diffList.innerHTML = ['easy', 'medium', 'hard'].map((k) =>
    `<button class="pick-card diff-${k}" data-diff="${k}" type="button">
       <b>${esc(tr(`diff.${k}`))}</b><span>${esc(tr(`diff.${k}.blurb`))}</span></button>`).join('');
}

// The corner's menu and mute plates: art carries the meaning, so these words
// are the whole of what a screen reader hears.
function paintCorner() {
  if (!els) return;
  if (els.btnMenu) {
    els.btnMenu.setAttribute('aria-label', tr('corner.menu'));
    els.btnMenu.title = tr('corner.menuTitle');
  }
  if (els.muteBtn) {
    const m = els.muteBtn.getAttribute('aria-pressed') === 'true';
    const label = tr(m ? 'corner.unmute' : 'corner.mute');
    els.muteBtn.setAttribute('aria-label', label);
    els.muteBtn.title = `${label} (M)`;
  }
}

// The level-clear screen's words, separate from its state: relang() calls this
// without touching the KEEP selection or restarting the preview.
function paintLevelClearText() {
  if (!els || !lastLc) return;
  const { game, info } = lastLc;
  els.lcHeading.textContent = tr('lc.heading', info.levelIndex + 1);
  els.lcSub.textContent = tr('lc.sub', levelDef(info.levelIndex).name, levelDef(info.levelIndex + 1).name);
  els.lcStats.innerHTML = [
    [tr('stat.score'), game.score],
    [tr('stat.kills'), game.kills],
  ].map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  els.lcNote.innerHTML = tr(lcOwned.length > 2 ? 'lc.notePick' : lcOwned.length ? 'lc.noteAll' : 'lc.noteNone');
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
      muteBtn: $('btn-mute'),
      btnUpdate: $('btn-update'), versionTag: $('game-version'),
      soundBoard: $('sound-board'),
      volMusic: $('vol-music'), volMusicVal: $('vol-music-val'),
      volSfx: $('vol-sfx'), volSfxVal: $('vol-sfx-val'),
      btnCutoff: $('btn-cutoff'),
      cornerTools: $('corner-tools'), btnMenu: $('btn-menu'),
      menuTitle: $('menu-title'), btnMenuClose: $('btn-menu-close'),
      btnResume: $('btn-resume'), btnQuit: $('btn-quit'),
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
        // A preview canvas keeps the pixel size it was started at, and turning
        // a phone on its side changes its CSS size (style.css lays the armoury
        // and the KEEP screen out differently in landscape) — the old bitmap
        // would just be stretched into the new box. Restart whichever preview
        // is showing, once the resize has settled rather than on every event.
        clearTimeout(previewResize);
        previewResize = setTimeout(() => {
          const showing = (s) => s && !s.classList.contains('hidden');
          if (showing(els.screens.powers) && pwBrowse) browsePower(pwBrowse, true);
          if (showing(els.screens.levelclear) && lcBrowse) browseKeep(lcBrowse);
        }, 120);
      });
    }

    const tap = (el, fn) => el && el.addEventListener('click', () => { fn(); audio.click(); });
    tap($('btn-start'), actions.start);
    tap($('btn-retry'), actions.restart);
    tap($('btn-again'), actions.restart);
    tap($('btn-resume'), actions.resume);
    tap($('btn-quit'), actions.quit);
    tap(els.muteBtn, actions.mute);

    /* Leaving the GAME, as opposed to quitting to the title.
     *
     * Only wired when the arcade's exit.js is actually there: it is another
     * repository's file and is allowed to be missing, and a quit button that
     * cannot quit is worse than none. Its words are exit.js's answer too —
     * inside the arcade this goes back to the floor, installed it closes the
     * window, and in an ordinary tab nothing may close anything, so it must
     * not pretend otherwise.
     *
     * NOT via `tap`: the title screen starts a run on a click anywhere, which
     * is why the sound board stops its clicks too. Leaving the game must not
     * launch one on the way out. */
    const exit = window.ArcadeExit;
    /* `offers()` and not merely `exit` — the object turning up only means the
     * arcade's file loaded, which it does for anyone who opened this game at
     * its own address. A person who typed that address, or followed a link,
     * did not come from the arcade and should not be handed a door "back" to
     * somewhere they have never been; their browser's own back button already
     * knows where they came from. So the plate appears when a launcher is
     * behind us, or when we are an installed window that can genuinely close,
     * and in a plain tab there is simply no plate. See ../arcade/exit.js. */
    /* Whether to draw the plate at all, which is NOT the same question as
     * whether quit() could do something. In a plain tab it could — the arcade
     * is a URL and a navigation always works — but somebody who typed this
     * game's address, or followed a link, did not come from the arcade and may
     * never have heard of it. So: a launcher behind us, or an installed window
     * that can genuinely close.
     *
     * ASKED THROUGH framed()/standalone() AND NOT THROUGH offers(), even
     * though offers() exists and says exactly this. exit.js is another repo's
     * file and the copy that answers may be OLDER than this one: it is fetched
     * from /arcade/, and a service worker on this origin can hand back a
     * version cached long before offers() was written. A guard built on the
     * new name fails CLOSED when that happens — the way out simply disappears,
     * inside the arcade, where it is the one control that matters. These two
     * predicates have been in exit.js since it existed. */
    const offers = exit && (exit.framed() || exit.standalone());
    if (exit && offers) {
      /* Plain words, not MAXGEAR's. A way out is the one control on the menu
       * that must mean the same thing in every game in the hub, so it says
       * where it goes and nothing more — the case and the ◂ / ✕ are typography
       * and stay. `tab` is not passed: verb() reads it only when there is no
       * arcade to go back to, and in that case `app` is already the honest
       * answer. Framed or in a tab this goes back to the arcade; installed it
       * closes the window.
       *
       * verb() is handed the words in the CURRENT language, and asked again
       * by relang() on a switch — it chooses between them and says nothing of
       * its own, so the label is always ours to translate. */
      exitLabel = () => exit.verb({ arcade: tr('exit.arcade'), app: tr('exit.app') });
      const label = exitLabel();
      for (const id of ['btn-exit-title', 'btn-exit-pause']) {
        const button = $(id);
        if (!button) continue;
        button.textContent = label;
        button.classList.remove('hidden');
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.click();
          exit.quit().then((how) => {
            // Refused: the browser will not close a window it did not open.
            if (how !== 'refused') return;
            exitRefused = true;
            button.textContent = tr('exit.refused');
            button.disabled = true;
          });
        });
      }
    }

    // ---- sound board (v1.6; behind a door since v1.8) -----------------------
    // The board has one home: the menu panel, which is also the pause menu.
    // It used to be lent between that and a screen of its own; those are one
    // screen now, so nothing moves it and there is nothing to keep in step.
    // It carries no stopPropagation — the screen it sits on does not start a
    // run on a click anywhere, unlike the title screen it was bolted into
    // before v1.8. The corner cluster still stops its own clicks, because the
    // corner is the one thing left sitting over a screen that does.
    tap(els.btnCutoff, () => { audio.unlock(); actions.mute(); });

    // ---- the language row (v1.10) -------------------------------------------
    // setLang() stores the choice under the hub's key, repaints the static
    // markup and fires `arcade:lang`, which main.js turns into ui.relang().
    // Nothing else happens: the menu stays open, a paused run stays paused.
    for (const b of document.querySelectorAll('#sound-board [data-lang]')) {
      tap(b, () => setLang(b.dataset.lang));
    }

    // ---- corner plates (v1.7) -----------------------------------------------
    // The title screen's own top-right pair: a speaker that opens the sound
    // board, and js/screen.js's fullscreen plate. index.html says why they live
    // on this screen and nowhere else.
    //
    // THE CLICK MUST DIE HERE. The title screen starts a run on a click
    // anywhere, so a tap on either plate must not launch the game on its way
    // past — this is the stop the sound board used to carry for the same
    // reason, now that the corner is what sits on that screen instead. One
    // listener on the cluster covers both plates, which is what keeps screen.js
    // able to know nothing about this screen. It also gives the fullscreen
    // plate the same iron click every other control in MAXGEAR answers with —
    // screen.js does the actual work and never touches the audio graph.
    if (els.cornerTools) {
      els.cornerTools.addEventListener('click', (ev) => {
        ev.stopPropagation();
        audio.unlock();
        audio.click();
      });
    }

    // The menu plate. Mid-run main.js stops the game before raising it;
    // anywhere else there is nothing to stop and it simply opens.
    //
    // Not via `tap`: the cluster's own listener above already answers with the
    // click, and two clanks for one press is one clank too many.
    if (els.btnMenu) els.btnMenu.addEventListener('click', actions.showMenu);
    // CLOSE is the way out when the menu is not a pause — there is no RESUME
    // to serve as one. Same door Esc uses; main.js remembers which.
    tap(els.btnMenuClose, actions.closeMenu);

    // Sliders move on 'input' (every step, so the bus follows the thumb) and
    // audition on 'change' (once, when the player lets go) — an iron clank on
    // every step of a drag would be unbearable.
    //
    // Each one unlocks first. On the title screen the board may well be the
    // player's FIRST touch of the game, and a volume control that does not
    // make a sound while you set it is a volume control you cannot use.
    if (els.volMusic) {
      els.volMusic.addEventListener('input', () => {
        audio.unlock();
        if (audio.setMusicVolume(els.volMusic.value / 100)) ui.setMuted(false);
        paintSoundBoard();
      });
    }
    if (els.volSfx) {
      els.volSfx.addEventListener('input', () => {
        audio.unlock();
        if (audio.setSfxVolume(els.volSfx.value / 100)) ui.setMuted(false);
        paintSoundBoard();
      });
      els.volSfx.addEventListener('change', () => audio.hit());
    }

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

    // Difficulty cards: built here and again by relang(), never by the game.
    if (els.diffList) {
      paintDifficulties();
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
            del.textContent = tr('slot.sure');
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
        updateState = 'busy';
        els.btnUpdate.textContent = tr('update.busy');
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
    // The board has ONE home now and never moves. It was lent between a pause
    // slot and a sound-screen slot while those were two screens; they are one
    // screen whose contents adapt, so there is nothing left to lend it to and
    // the node simply lives in the menu. Repaint it whenever the menu comes up,
    // because a level may have been changed by the keyboard since.
    if (state === 'pause') paintSoundBoard();
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

  /* A language switch, live (hub CLAUDE.md §2, "Two languages"). i18n.js has
     already repainted every [data-i18n] node; this repaints everything this
     file wrote itself, IN PLACE. It changes no state: the menu that was open
     stays open, a paused run stays paused, the KEEP picks stay picked, an
     armed delete simply disarms. Canvas words (gates carry none; floaters and
     previews do) follow on their next frame — effects.relabel() is main.js's. */
  relang(game) {
    if (!els) return;
    paintCorner();
    paintSoundBoard();
    this.paintMenu(lastInRun);
    if (exitLabel) {
      const label = exitRefused ? tr('exit.refused') : exitLabel();
      for (const id of ['btn-exit-title', 'btn-exit-pause']) {
        const b = $(id);
        if (b) b.textContent = label;
      }
    }
    if (els.btnUpdate && updateState) {
      els.btnUpdate.textContent = updateState === 'busy'
        ? tr('update.busy') : tr('update.ready', updateState.version);
    }
    paintDifficulties();
    if (lastSlots) this.showSlots(lastSlots);
    // KEEP screen: words only — the picks and the running preview survive.
    if (lastLc) {
      paintLevelClearText();
      for (const card of els.lcGrid.querySelectorAll('[data-keep]')) {
        const def = TRACKS[card.dataset.keep];
        const em = card.querySelector('em');
        if (def && em) em.textContent = def.name;
      }
      const own = lcOwned.find((o) => o.key === lcBrowse);
      const def = TRACKS[lcBrowse];
      if (def && own) {
        els.lcDname.textContent = `${def.name} · LV${own.lv}`;
        els.lcDblurb.textContent = def.blurb || '';
      }
    }
    // Upgrades screen: likewise, without restarting its preview.
    if (els.pwGrid) {
      for (const card of els.pwGrid.querySelectorAll('[data-pw]')) {
        const def = TRACKS[card.dataset.pw];
        const em = card.querySelector('em');
        if (def && em) em.textContent = def.name;
      }
      const def = TRACKS[pwBrowse];
      if (def) {
        els.pwDname.textContent = `${def.name} \u00b7 LV${pwLevel}`;
        els.pwDblurb.textContent = def.blurb || '';
        els.pwDtier.textContent = tierNote(def.tier ?? 1);
        for (const b of els.pwLvls.querySelectorAll('[data-lv]')) {
          b.setAttribute('aria-label', tr('up.levelN', +b.dataset.lv));
        }
      }
    }
    if (lastEnd) this.showEnd(lastEnd.game, lastEnd.victory, lastEnd.extra);
    // HUD: the strip and the legend rebuild on their next update(); the act
    // caption, the boss name and the toast are said again now, without
    // replaying their entry animations.
    prevStrip = '';
    prevLegend = '';
    if (prevAct && !els.actLabel.classList.contains('hidden')) els.actLabel.textContent = words(prevAct);
    if (toastItem && toastActive) els.toast.textContent = words(toastItem.label);
    const boss = game && game.boss;
    if (boss && boss.def) els.bossName.textContent = boss.def.name || tr('boss.ironclad');
  },

  setMuted(m) {
    // aria-pressed carries the state and CSS draws the slash off it, the same
    // pairing the fullscreen plate uses — so the picture and what a screen
    // reader is told come from one write and cannot drift. It was an emoji
    // swapped into textContent, which no reader announces and which never
    // looked like the brass around it.
    els.muteBtn.setAttribute('aria-pressed', String(!!m));
    paintCorner();       // the label follows aria-pressed, in the current language
    paintSoundBoard();   // the board's MASTER lever shows the same state
  },

  /* What the one menu panel says, given where it was opened from. Mid-run it is
     a pause and carries the two things only a run has — RESUME, and something
     to abandon. Anywhere else those would both be lies, so they go, and CLOSE
     becomes the way back out. Nothing is built twice: the levels, the way out
     and the panel itself are the same nodes either way. */
  paintMenu(inRun) {
    if (!els) return;
    lastInRun = !!inRun;
    if (els.menuTitle) els.menuTitle.textContent = tr(inRun ? 'menu.paused' : 'menu.settings');
    if (els.btnResume) els.btnResume.classList.toggle('hidden', !inRun);
    if (els.btnQuit) els.btnQuit.classList.toggle('hidden', !inRun);
    if (els.btnMenuClose) els.btnMenuClose.classList.toggle('hidden', inRun);
  },

  // v1.5.2: the version that is actually serving this session (from the SW).
  setVersion(v) {
    if (els && els.versionTag && v) els.versionTag.textContent = v;
  },

  // v1.5.2: a new worker is precached and waiting — surface the opt-in pill.
  offerUpdate(version) {
    if (!els || !els.btnUpdate) return;
    els.btnUpdate.disabled = false;
    updateState = { version: version || '' };
    els.btnUpdate.textContent = tr('update.ready', updateState.version);
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
    lastSlots = slots;
    armedDelete = -1;
    const ago = (t) => {
      if (!t) return '';
      const m = Math.max(1, Math.round((Date.now() - t) / 60000));
      if (m < 60) return tr('slot.agoM', m);
      const h = Math.round(m / 60);
      return h < 48 ? tr('slot.agoH', h) : tr('slot.agoD', Math.round(h / 24));
    };
    // The save stores the difficulty's KEY ('easy'…), never a word, so a save
    // made in one language reads in the other.
    const diffWord = (k) => tr(`diff.${k === 'easy' || k === 'hard' ? k : 'medium'}`);
    els.slotList.innerHTML = slots.map((s, i) => {
      if (!s) {
        return `<button class="pick-card slot-card empty" data-slot="${i}" type="button">
          <b>${esc(tr('slot.name', i + 1))}</b><span>${esc(tr('slot.empty'))}</span></button>`;
      }
      const prog = s.cleared
        ? tr('slot.cleared')
        : tr('slot.level', Math.min(s.levelIndex + 1, 4), 4);
      const diff = esc(diffWord(s.difficulty));
      return `<div class="pick-card slot-card" data-slot="${i}" role="button" tabindex="0">
        <b>${esc(tr('slot.name', i + 1))} · ${esc(prog)}</b>
        <span>${diff} · ${esc(tr('slot.score', s.score ?? 0))} · ${esc(ago(s.updatedAt))}</span>
        <em class="slot-resume">${esc(tr(s.cleared ? 'slot.replay' : 'slot.resume'))}</em>
        <button class="slot-del" data-del="${i}" type="button" aria-label="${esc(tr('slot.delete'))}">\u2715</button>
      </div>`;
    }).join('');
  },

  // v1.5: the KEEP screen — pick exactly `need` upgrades to carry forward.
  showLevelClear(game, info) {
    if (!els || !els.lcHeading) return;
    lastLc = { game, info };

    // Owned positive tracks only (rusted plating resets for free — no card).
    lcOwned = ownedTracks(game.player).filter((o) => o.lv > 0);
    lcNeed = Math.min(2, lcOwned.length);
    lcSelection = new Set(lcNeed < 2 ? lcOwned.map((o) => o.key) : []);
    if (lcOwned.length === 2) lcSelection = new Set(lcOwned.map((o) => o.key));

    paintLevelClearText();   // heading, sub-line, stats and the note

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
    lastEnd = { game, victory, extra };
    const p = game.player;
    if (els.victorySub) {
      if (victory && extra.campaignDone) {
        // extra.difficulty is the DIFFICULTIES entry; its label is a getter,
        // so this reads in the current language every time it is painted.
        const diff = extra.difficulty && typeof extra.difficulty === 'object'
          ? extra.difficulty.label : (extra.difficulty || '');
        els.victorySub.textContent = tr('end.campaign', diff);
        els.victorySub.classList.remove('hidden');
      } else {
        els.victorySub.classList.add('hidden');
      }
    }
    const stats = [
      [tr('stat.score'), game.score],
      [tr('stat.kills'), game.kills],
      [tr('stat.distance'), `${Math.round(p.z / 10)}m`],
    ].map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
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
    // level.js hands over a FUNCTION per act (stable identity, so this compare
    // is the old string compare) that says the caption in the current language.
    const act = game.level && game.level.actLabel;
    if (act) {
      if (act !== prevAct) {
        prevAct = act;
        els.actLabel.textContent = words(act);
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
      els.bossName.textContent = (boss.def && boss.def.name) || tr('boss.ironclad');
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
