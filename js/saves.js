// Save slots: 3 per device via localStorage. LEAD-OWNED.
// Never throws — quota/denied/headless all degrade to an in-memory store.
//
// save = { v: 1, difficulty: 'easy'|'medium'|'hard', levelIndex: 0..3 (NEXT
//          level to play), tracks: {...}, score, kills, updatedAt, cleared }

const KEY = 'maxgear.saves.v1';
const SLOTS = 3;

let memory = null; // fallback when localStorage is unavailable

function store() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (ls) {
      ls.getItem(KEY); // probe (Safari private mode can throw on access)
      return ls;
    }
  } catch (e) { /* fall through */ }
  return null;
}

function readAll() {
  const ls = store();
  if (!ls) return memory || (memory = new Array(SLOTS).fill(null));
  try {
    const raw = ls.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const out = new Array(SLOTS).fill(null);
    for (let i = 0; i < SLOTS; i++) {
      const s = arr[i];
      out[i] = s && s.v === 1 && typeof s.levelIndex === 'number' ? s : null;
    }
    return out;
  } catch (e) {
    return new Array(SLOTS).fill(null);
  }
}

function writeAll(slots) {
  const ls = store();
  if (!ls) { memory = slots.slice(); return; }
  try { ls.setItem(KEY, JSON.stringify(slots)); } catch (e) { memory = slots.slice(); }
}

export function loadSlots() {
  return readAll();
}

export function writeSlot(i, save) {
  const slots = readAll();
  slots[i] = save;
  writeAll(slots);
}

export function clearSlot(i) {
  writeSlot(i, null);
}

// Snapshot the campaign state. levelIndex = the NEXT level to play.
export function makeSave(game, levelIndex, cleared = false) {
  return {
    v: 1,
    difficulty: game.campaign.difficulty.key,
    levelIndex,
    tracks: { ...game.player.tracks },
    score: game.score,
    kills: game.kills,
    updatedAt: Date.now(),
    cleared,
  };
}
