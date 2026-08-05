// Colored upgrade / HUD icon glyphs. PURE LEAF MODULE — zero imports.
//
// Why a module of its own: the same 20-odd glyphs are needed by the gate panels
// (world canvas, any size, any LOD), the HUD legend (small persistent canvases)
// and the end-screen chips (<img> data URLs). Keeping them dependency-free means
// this file also imports cleanly in Node/headless tests. DOM is touched ONLY
// inside the bake helpers, lazily, and guarded.
//
// Painter contract: painter(ctx, s, p)
//   * draws centered on (0,0) inside the box [-0.5s, +0.5s] (level decorations may
//     use up to ~0.58s vertically — bake at s = px * 0.875 to leave room),
//   * p is a 5-slot palette { base, dark, hi, accent, glass } — body slots are
//     MATERIALS (brass/iron/enamel), `accent` is the SEMANTIC hue (good/bad/aether…),
//   * every accent gets a dark edge or underlay (`p.dark`) so bright hues stay
//     readable on tinted gate glass — this is also what keeps the mono variant
//     legible, since monoPalette() flattens everything except `dark`,
//   * <= 4 material colors + the dark edge; beginPath primitives only,
//   * NEVER touches globalCompositeOperation / shadow* / globalAlpha / filter,
//   * sets its own fillStyle/strokeStyle before every fill/stroke (no leakage),
//   * allocates nothing (paths are built once and re-stroked for the underlay).

const TAU = Math.PI * 2;

// Material palette (steampunk contract from DESIGN.md + the visual spec).
export const MAT = Object.freeze({
  IRON: '#1a1512',
  COAL: '#0f0c09',
  INK: 'rgba(10,8,5,0.85)',
  BRASS: '#c9973b',
  BRASS_HI: '#f0b429',
  BRASS_LO: '#6f5220',
  COPPER: '#b0652f',
  RUST: '#8a3324',
  ENAMEL: '#efe3c8',
  STEAM: '#e6e1d7',
  AETHER: '#8df3ff',
  AETHER_DK: '#2fb8d6',
  GOLD: '#ffd166',
  EMBER: '#ff8a5a',
  GOOD: '#56b06c',
  BAD: '#d2513c',
  MIXED: '#a97bd1',
  CRIMSON: '#c04a3a',
  // highlight literals named by the palette table
  WHITE: '#ffffff',
  BONE: '#fff3d6',      // crit inner star
  FLESH_HI: '#e8836f',  // heart highlight
});

const MONO_DARK = 'rgba(12,9,6,0.85)';
const PIP_OFF = 'rgba(0,0,0,0.45)';

// Below this pixel size the 4-color read turns to mud, so drawIcon flattens the
// glyph to a single hue (white unless the caller asked for its own tint).
const MONO_BELOW = 13;
const PIPS_MIN = 16;     // level pips need this much room
const NUMERAL_MIN = 11;  // …below that, a single gold digit
const SPRITE_FILL = 0.875; // glyph size as a fraction of the baked sprite box

function P(base, hi, accent, glass) {
  return Object.freeze({ base, dark: MAT.INK, hi, accent, glass });
}

// base = body material, hi = highlight material, accent = semantic hue,
// glass = secondary trim (enamel/gold/iron). See the design doc's palette table.
export const ICON_PALETTES = Object.freeze({
  // ---- ported from the old monochrome ICONS map (silhouettes preserved) -----
  shell: P(MAT.BRASS, MAT.BRASS_HI, MAT.EMBER, MAT.ENAMEL),
  rof: P(MAT.BRASS, MAT.BRASS_HI, MAT.GOLD, MAT.ENAMEL),
  fan: P(MAT.BRASS_LO, MAT.BRASS_HI, MAT.AETHER, MAT.ENAMEL),
  ally: P(MAT.AETHER_DK, MAT.AETHER, MAT.BRASS, MAT.BRASS_HI),
  cross: P(MAT.ENAMEL, MAT.WHITE, MAT.GOOD, MAT.STEAM),
  heartUp: P(MAT.CRIMSON, MAT.FLESH_HI, MAT.GOOD, MAT.ENAMEL),
  heartCrack: P(MAT.RUST, MAT.COPPER, MAT.BAD, MAT.IRON),
  bomb: P(MAT.IRON, MAT.BRASS, MAT.EMBER, MAT.GOLD),
  crit: P(MAT.GOLD, MAT.BONE, MAT.GOLD, MAT.WHITE),
  chevrons: P(MAT.BRASS, MAT.BRASS_HI, MAT.STEAM, MAT.BRASS_LO),
  shellDown: P(MAT.BRASS_LO, MAT.BRASS, MAT.BAD, MAT.IRON),
  watchDown: P(MAT.BRASS, MAT.BRASS_HI, MAT.BAD, MAT.ENAMEL),
  // ---- new glyphs -----------------------------------------------------------
  lance: P(MAT.IRON, MAT.BRASS, MAT.AETHER, MAT.BRASS_HI),
  arc: P(MAT.BRASS, MAT.BRASS_HI, MAT.AETHER, MAT.IRON),
  homing: P(MAT.BRASS, MAT.BRASS_HI, MAT.AETHER, MAT.IRON),
  flame: P(MAT.BRASS, MAT.BRASS_HI, MAT.EMBER, MAT.GOLD),
  frost: P(MAT.ENAMEL, MAT.WHITE, MAT.AETHER, MAT.BRASS),
  saw: P(MAT.BRASS, MAT.BRASS_HI, MAT.WHITE, MAT.BRASS_LO),
  broadside: P(MAT.BRASS, MAT.BRASS_HI, MAT.AETHER, MAT.IRON),
  shards: P(MAT.BRASS, MAT.BRASS_HI, MAT.EMBER, MAT.BONE),
  aegis: P(MAT.AETHER_DK, MAT.AETHER, MAT.AETHER, MAT.BRASS),
  siphon: P(MAT.COPPER, MAT.BRASS_HI, MAT.GOOD, MAT.STEAM),
  plate: P(MAT.IRON, MAT.BRASS, MAT.BAD, MAT.BRASS_LO),
  plateCracked: P(MAT.IRON, MAT.COPPER, MAT.BAD, MAT.RUST),
  rust: P(MAT.RUST, MAT.COPPER, MAT.BAD, MAT.BRASS_LO),
});

const DEFAULT_PAL = P(MAT.BRASS, MAT.BRASS_HI, MAT.GOLD, MAT.ENAMEL);

// Flatten a glyph to one hue. `dark` survives so edges/underlays keep the
// interior detail readable — that is what makes the mono variant work at all.
export function monoPalette(color) {
  const c = color || MAT.WHITE;
  return { base: c, dark: MONO_DARK, hi: c, accent: c, glass: c };
}

// Negative/"cracked" variants: same name, different painter + palette.
// drawIcon(ctx,'plate',…,{negative:true}) === drawIcon(ctx,'plateCracked',…).
const NEGATIVE_OF = Object.freeze({ plate: 'plateCracked' });

// ---- shared primitives -------------------------------------------------------
// All of these operate on the CURRENT path so nothing is allocated per draw.

function solid(ctx, p, s, color, k) {
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(0.6, s * (k || 0.075));
  ctx.strokeStyle = p.dark;
  ctx.stroke();
}

// Stroke the current path twice: a fat dark underlay, then the color on top.
function strokeTwice(ctx, p, s, color, w) {
  ctx.strokeStyle = p.dark;
  ctx.lineWidth = Math.max(0.9, s * (w + 0.07));
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.6, s * w);
  ctx.stroke();
}

function box(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

function disc(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

function dot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
}

// Ported silhouettes -----------------------------------------------------------
function shellPath(ctx, s) {
  const w = s * 0.3, h = s * 0.9;
  ctx.beginPath();
  ctx.moveTo(0, -h / 2);
  ctx.quadraticCurveTo(w, -h * 0.14, w, h * 0.1);
  ctx.lineTo(w, h / 2);
  ctx.lineTo(-w, h / 2);
  ctx.lineTo(-w, h * 0.1);
  ctx.quadraticCurveTo(-w, -h * 0.14, 0, -h / 2);
  ctx.closePath();
}

function heartPath(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(0, s * 0.36);
  ctx.bezierCurveTo(-s * 0.52, 0, -s * 0.3, -s * 0.4, 0, -s * 0.12);
  ctx.bezierCurveTo(s * 0.3, -s * 0.4, s * 0.52, 0, 0, s * 0.36);
  ctx.closePath();
}

function arrowPath(ctx, x, y, s, dir) {
  ctx.beginPath();
  ctx.moveTo(x, y + dir * s * 0.5);
  ctx.lineTo(x - s * 0.34, y + dir * s * 0.02);
  ctx.lineTo(x - s * 0.12, y + dir * s * 0.02);
  ctx.lineTo(x - s * 0.12, y - dir * s * 0.45);
  ctx.lineTo(x + s * 0.12, y - dir * s * 0.45);
  ctx.lineTo(x + s * 0.12, y + dir * s * 0.02);
  ctx.lineTo(x + s * 0.34, y + dir * s * 0.02);
  ctx.closePath();
}

function starPath(ctx, s, out, inn) {
  ctx.beginPath();
  ctx.moveTo(0, -s * out);
  ctx.lineTo(s * inn, -s * inn);
  ctx.lineTo(s * out, 0);
  ctx.lineTo(s * inn, s * inn);
  ctx.lineTo(0, s * out);
  ctx.lineTo(-s * inn, s * inn);
  ctx.lineTo(-s * out, 0);
  ctx.lineTo(-s * inn, -s * inn);
  ctx.closePath();
}

function plusPath(ctx, span, thick) {
  const a = span / 2, b = thick / 2;
  ctx.beginPath();
  ctx.moveTo(-b, -a); ctx.lineTo(b, -a); ctx.lineTo(b, -b); ctx.lineTo(a, -b);
  ctx.lineTo(a, b); ctx.lineTo(b, b); ctx.lineTo(b, a); ctx.lineTo(-b, a);
  ctx.lineTo(-b, b); ctx.lineTo(-a, b); ctx.lineTo(-a, -b); ctx.lineTo(-b, -b);
  ctx.closePath();
}

function cogPath(ctx, cx, cy, r, teeth, depth) {
  const n = teeth * 2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const rr = i % 2 ? r * (1 - depth) : r;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

// Broken ring: N arc segments with gaps (moveTo kills the connecting chord).
function brokenRing(ctx, r, n, gap) {
  ctx.beginPath();
  const step = TAU / n;
  for (let k = 0; k < n; k++) {
    const a0 = k * step + gap * 0.5, a1 = a0 + step - gap;
    ctx.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
    ctx.arc(0, 0, r, a0, a1);
  }
}

// Semantic up/down badge used inside painters (accent + dark edge).
function badge(ctx, p, s, x, y, size, dir) {
  arrowPath(ctx, x, y, size, dir);
  solid(ctx, p, s, p.accent, 0.05);
}

// Public: the standalone arrow for mixed gate rows (gain ▲ / loss ▼).
export function drawArrow(ctx, x, y, s, dir, color) {
  if (!ctx || typeof ctx.save !== 'function') return;
  if (!(s > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  ctx.save();
  ctx.lineJoin = 'round';
  arrowPath(ctx, x, y, s, dir >= 0 ? 1 : -1);
  ctx.fillStyle = color || MAT.GOLD;
  ctx.fill();
  ctx.lineWidth = Math.max(0.6, s * 0.13);
  ctx.strokeStyle = MAT.INK;
  ctx.stroke();
  ctx.restore();
}

// ---- painters ----------------------------------------------------------------
const PAINTERS = {
  // brass slug, enamel driving band, glowing nose
  shell(ctx, s, p) {
    shellPath(ctx, s);
    solid(ctx, p, s, p.base, 0.075);
    ctx.fillStyle = p.hi;                                  // machined sheen
    ctx.fillRect(-s * 0.19, -s * 0.02, s * 0.06, s * 0.4);
    box(ctx, -s * 0.3, s * 0.08, s * 0.6, s * 0.12);        // enamel band
    solid(ctx, p, s, p.glass, 0.05);
    ctx.beginPath();                                       // hot nose
    ctx.moveTo(0, -s * 0.45);
    ctx.quadraticCurveTo(s * 0.3, -s * 0.2, s * 0.2, -s * 0.06);
    ctx.lineTo(-s * 0.2, -s * 0.06);
    ctx.quadraticCurveTo(-s * 0.3, -s * 0.2, 0, -s * 0.45);
    ctx.closePath();
    solid(ctx, p, s, p.accent, 0.055);
  },

  // three shells with gold speed dashes (ported layout)
  rof(ctx, s, p) {
    for (let i = -1; i <= 1; i++) {
      const x = i * s * 0.26, y = i * i * s * 0.06;
      box(ctx, x - s * 0.045, y + s * 0.18, s * 0.09, s * 0.3);
      solid(ctx, p, s, p.accent, 0.045);
      ctx.beginPath();
      ctx.ellipse(x, y - s * 0.14, s * 0.1, s * 0.22, 0, 0, TAU);
      solid(ctx, p, s, p.base, 0.05);
      ctx.beginPath();
      ctx.ellipse(x - s * 0.03, y - s * 0.2, s * 0.028, s * 0.07, 0, 0, TAU);
      ctx.fillStyle = p.hi;
      ctx.fill();
    }
  },

  // cyan tri-spray leaving a brass muzzle
  fan(ctx, s, p) {
    for (let i = -1; i <= 1; i++) {
      ctx.save();
      ctx.rotate(i * 0.44);
      ctx.beginPath();
      ctx.ellipse(0, -s * 0.26, s * 0.1, s * 0.24, 0, 0, TAU);
      solid(ctx, p, s, p.accent, 0.05);
      ctx.restore();
    }
    disc(ctx, 0, s * 0.28, s * 0.14);
    solid(ctx, p, s, p.base, 0.06);
    dot(ctx, 0, s * 0.26, s * 0.06, p.hi);
  },

  // two escort wedges, brass canopies
  ally(ctx, s, p) {
    for (const dx of [-s * 0.24, s * 0.24]) {
      ctx.beginPath();
      ctx.moveTo(dx, -s * 0.34);
      ctx.lineTo(dx + s * 0.2, s * 0.3);
      ctx.lineTo(dx, s * 0.14);
      ctx.lineTo(dx - s * 0.2, s * 0.3);
      ctx.closePath();
      solid(ctx, p, s, p.base, 0.065);
      ctx.beginPath();
      ctx.moveTo(dx, -s * 0.2);
      ctx.lineTo(dx + s * 0.09, s * 0.16);
      ctx.lineTo(dx - s * 0.09, s * 0.16);
      ctx.closePath();
      ctx.fillStyle = p.hi;
      ctx.fill();
      dot(ctx, dx, s * 0.0, s * 0.05, p.accent);
    }
  },

  // enamel cross plate with a green inlay (plus silhouette kept for mono)
  cross(ctx, s, p) {
    plusPath(ctx, s * 0.9, s * 0.3);
    solid(ctx, p, s, p.base, 0.08);
    ctx.fillStyle = p.hi;
    ctx.fillRect(-s * 0.13, -s * 0.44, s * 0.05, s * 0.16);
    plusPath(ctx, s * 0.62, s * 0.17);
    ctx.fillStyle = p.accent;
    ctx.fill();
  },

  // crimson heart + green up badge
  heartUp(ctx, s, p) {
    ctx.save();
    ctx.translate(-s * 0.08, s * 0.05);
    heartPath(ctx, s * 0.82);
    solid(ctx, p, s, p.base, 0.07);
    ctx.beginPath();
    ctx.ellipse(-s * 0.13, -s * 0.09, s * 0.08, s * 0.045, -0.6, 0, TAU);
    ctx.fillStyle = p.hi;
    ctx.fill();
    ctx.restore();
    badge(ctx, p, s, s * 0.34, -s * 0.28, s * 0.34, -1);
  },

  // rusted heart split by a red fracture (crack silhouette ported)
  heartCrack(ctx, s, p) {
    heartPath(ctx, s * 0.94);
    solid(ctx, p, s, p.base, 0.07);
    ctx.beginPath();
    ctx.ellipse(-s * 0.15, -s * 0.1, s * 0.08, s * 0.045, -0.6, 0, TAU);
    ctx.fillStyle = p.hi;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.16);
    ctx.lineTo(-s * 0.1, 0);
    ctx.lineTo(s * 0.08, s * 0.1);
    ctx.lineTo(-s * 0.04, s * 0.3);
    strokeTwice(ctx, p, s, p.accent, 0.07);
  },

  // cyan-tipped brass spike punched through two iron plates (replaces `pierce`)
  lance(ctx, s, p) {
    box(ctx, -s * 0.44, -s * 0.21, s * 0.88, s * 0.14);
    solid(ctx, p, s, p.base, 0.055);
    box(ctx, -s * 0.3, s * 0.12, s * 0.6, s * 0.14);
    solid(ctx, p, s, p.base, 0.055);
    ctx.fillStyle = p.glass;                                  // rivets
    dot(ctx, -s * 0.36, -s * 0.14, s * 0.035, p.glass);
    dot(ctx, s * 0.36, -s * 0.14, s * 0.035, p.glass);
    box(ctx, -s * 0.07, -s * 0.3, s * 0.14, s * 0.74);        // brass shaft
    solid(ctx, p, s, p.hi, 0.05);
    ctx.fillStyle = p.glass;
    ctx.fillRect(-s * 0.055, -s * 0.28, s * 0.04, s * 0.7);
    ctx.beginPath();                                          // aether tip
    ctx.moveTo(0, -s * 0.5);
    ctx.lineTo(s * 0.17, -s * 0.24);
    ctx.lineTo(-s * 0.17, -s * 0.24);
    ctx.closePath();
    solid(ctx, p, s, p.accent, 0.055);
  },

  // two brass terminals bridged by a forked aether bolt
  arc(ctx, s, p) {
    for (const x of [-s * 0.46, s * 0.3]) {
      box(ctx, x, -s * 0.22, s * 0.16, s * 0.44);
      solid(ctx, p, s, p.base, 0.055);
      ctx.fillStyle = p.hi;
      ctx.fillRect(x, -s * 0.22, s * 0.05, s * 0.44);
    }
    ctx.beginPath();
    ctx.moveTo(-s * 0.28, -s * 0.02);
    ctx.lineTo(-s * 0.1, s * 0.11);
    ctx.lineTo(0, -s * 0.12);
    ctx.lineTo(s * 0.28, s * 0.02);
    ctx.moveTo(0, -s * 0.12);
    ctx.lineTo(s * 0.14, -s * 0.34);
    strokeTwice(ctx, p, s, p.accent, 0.08);
  },

  // brass reticle with a cyan dart in the middle
  homing(ctx, s, p) {
    const r = s * 0.42;
    brokenRing(ctx, r, 4, 0.5);
    strokeTwice(ctx, p, s, p.base, 0.085);
    ctx.beginPath();                                          // gap ticks
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2, cx = Math.cos(a), cy = Math.sin(a);
      ctx.moveTo(cx * r * 0.66, cy * r * 0.66);
      ctx.lineTo(cx * r * 1.1, cy * r * 1.1);
    }
    strokeTwice(ctx, p, s, p.hi, 0.06);
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.24);
    ctx.lineTo(s * 0.15, s * 0.18);
    ctx.lineTo(0, s * 0.06);
    ctx.lineTo(-s * 0.15, s * 0.18);
    ctx.closePath();
    solid(ctx, p, s, p.accent, 0.055);
  },

  // ember flame with a gold core rising off a brass canister
  flame(ctx, s, p) {
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.48);
    ctx.quadraticCurveTo(s * 0.3, -s * 0.18, s * 0.24, s * 0.04);
    ctx.quadraticCurveTo(s * 0.18, s * 0.26, 0, s * 0.26);
    ctx.quadraticCurveTo(-s * 0.18, s * 0.26, -s * 0.24, s * 0.04);
    ctx.quadraticCurveTo(-s * 0.3, -s * 0.18, 0, -s * 0.48);
    ctx.closePath();
    solid(ctx, p, s, p.accent, 0.065);
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.22);
    ctx.quadraticCurveTo(s * 0.13, -s * 0.04, s * 0.09, s * 0.1);
    ctx.quadraticCurveTo(0, s * 0.2, -s * 0.09, s * 0.1);
    ctx.quadraticCurveTo(-s * 0.13, -s * 0.04, 0, -s * 0.22);
    ctx.closePath();
    ctx.fillStyle = p.glass;
    ctx.fill();
    box(ctx, -s * 0.07, s * 0.14, s * 0.14, s * 0.1);          // nozzle
    solid(ctx, p, s, p.base, 0.05);
    box(ctx, -s * 0.2, s * 0.22, s * 0.4, s * 0.24);           // canister
    solid(ctx, p, s, p.base, 0.055);
    ctx.fillStyle = p.hi;
    ctx.fillRect(-s * 0.2, s * 0.26, s * 0.4, s * 0.05);
  },

  // enamel crystal with cyan rime, brass nozzle
  frost(ctx, s, p) {
    box(ctx, -s * 0.12, s * 0.3, s * 0.24, s * 0.16);
    solid(ctx, p, s, p.glass, 0.055);
    ctx.save();
    ctx.translate(0, -s * 0.08);
    const len = s * 0.36;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 3;
      const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
      ctx.moveTo(-dx, -dy);
      ctx.lineTo(dx, dy);
    }
    strokeTwice(ctx, p, s, p.base, 0.085);
    ctx.beginPath();                                           // rime barbs
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 3;
      const px = Math.cos(a) * len * 0.6, py = Math.sin(a) * len * 0.6;
      const bx = Math.cos(a + Math.PI / 2) * len * 0.2;
      const by = Math.sin(a + Math.PI / 2) * len * 0.2;
      ctx.moveTo(px - bx, py - by);
      ctx.lineTo(px + bx, py + by);
    }
    strokeTwice(ctx, p, s, p.accent, 0.06);
    dot(ctx, 0, 0, s * 0.06, p.hi);
    ctx.restore();
  },

  // pair of orbiting toothed discs, white spark on the leading tooth
  saw(ctx, s, p) {
    ctx.beginPath();
    ctx.ellipse(0, s * 0.06, s * 0.44, s * 0.2, 0, 0, TAU);
    strokeTwice(ctx, p, s, p.glass, 0.05);
    for (const d of [-1, 1]) {
      const cx = d * s * 0.28, cy = s * 0.06 - d * s * 0.16;
      cogPath(ctx, cx, cy, s * 0.19, 8, 0.28);
      solid(ctx, p, s, p.hi, 0.05);
      disc(ctx, cx, cy, s * 0.12);
      solid(ctx, p, s, p.base, 0.045);
      dot(ctx, cx, cy, s * 0.04, p.dark);
    }
    ctx.beginPath();                                           // spark
    for (let i = 0; i < 3; i++) {
      const a = -1.2 + i * 0.5;
      const sx = s * 0.4, sy = -s * 0.2;
      ctx.moveTo(sx + Math.cos(a) * s * 0.03, sy + Math.sin(a) * s * 0.03);
      ctx.lineTo(sx + Math.cos(a) * s * 0.1, sy + Math.sin(a) * s * 0.1);
    }
    strokeTwice(ctx, p, s, p.accent, 0.05);
  },

  // iron hull with three outward barrels + cyan muzzle flares
  broadside(ctx, s, p) {
    for (const a of [-Math.PI / 2, Math.PI / 2, Math.PI]) {
      ctx.save();
      ctx.rotate(a);
      box(ctx, -s * 0.065, -s * 0.44, s * 0.13, s * 0.26);
      solid(ctx, p, s, p.base, 0.05);
      ctx.fillStyle = p.hi;
      ctx.fillRect(-s * 0.065, -s * 0.26, s * 0.13, s * 0.05);
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.5);
      ctx.lineTo(s * 0.1, -s * 0.4);
      ctx.lineTo(-s * 0.1, -s * 0.4);
      ctx.closePath();
      solid(ctx, p, s, p.accent, 0.05);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.3);
    ctx.lineTo(s * 0.22, s * 0.24);
    ctx.lineTo(0, s * 0.1);
    ctx.lineTo(-s * 0.22, s * 0.24);
    ctx.closePath();
    solid(ctx, p, s, p.glass, 0.06);
    ctx.fillStyle = p.hi;
    ctx.fillRect(-s * 0.028, -s * 0.16, s * 0.056, s * 0.28);
  },

  // cracked disc bursting into four brass shards over an ember core
  shards(ctx, s, p) {
    brokenRing(ctx, s * 0.33, 4, 0.62);
    strokeTwice(ctx, p, s, p.base, 0.085);
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.rotate(Math.PI / 4 + k * Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.48);
      ctx.lineTo(s * 0.11, -s * 0.3);
      ctx.lineTo(-s * 0.09, -s * 0.28);
      ctx.closePath();
      solid(ctx, p, s, p.hi, 0.05);
      ctx.restore();
    }
    dot(ctx, 0, 0, s * 0.15, p.dark);
    dot(ctx, 0, 0, s * 0.11, p.accent);
    dot(ctx, -s * 0.03, -s * 0.03, s * 0.045, p.glass);
  },

  // aether ward ring around the protected core, brass arc bridging the gap
  aegis(ctx, s, p) {
    const r = s * 0.36;
    ctx.beginPath();
    ctx.arc(0, 0, r, Math.PI * 0.68, Math.PI * 2.32);
    strokeTwice(ctx, p, s, p.accent, 0.1);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.78, Math.PI * 0.3, Math.PI * 0.7);
    strokeTwice(ctx, p, s, p.glass, 0.085);
    disc(ctx, 0, 0, s * 0.13);
    solid(ctx, p, s, p.base, 0.06);
  },

  // finned copper condenser dripping a green droplet, steam above
  siphon(ctx, s, p) {
    ctx.fillStyle = p.glass;
    ctx.beginPath();
    ctx.ellipse(-s * 0.22, -s * 0.36, s * 0.1, s * 0.055, -0.3, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(s * 0.1, -s * 0.44, s * 0.12, s * 0.06, 0.2, 0, TAU);
    ctx.fill();
    box(ctx, -s * 0.09, -s * 0.3, s * 0.18, s * 0.48);
    solid(ctx, p, s, p.base, 0.055);
    for (const y of [-s * 0.24, -s * 0.08, s * 0.08]) {
      box(ctx, -s * 0.32, y, s * 0.64, s * 0.08);
      solid(ctx, p, s, p.base, 0.045);
      ctx.fillStyle = p.hi;
      ctx.fillRect(-s * 0.32, y, s * 0.64, s * 0.022);
    }
    ctx.beginPath();                                           // droplet
    ctx.moveTo(0, s * 0.22);
    ctx.quadraticCurveTo(s * 0.17, s * 0.36, 0, s * 0.48);
    ctx.quadraticCurveTo(-s * 0.17, s * 0.36, 0, s * 0.22);
    ctx.closePath();
    solid(ctx, p, s, p.accent, 0.055);
  },

  // riveted iron shield plate (armour)
  plate(ctx, s, p) { platePaint(ctx, s, p, false); },
  // …and its breached variant: same plate, red fracture (armour LOSS)
  plateCracked(ctx, s, p) { platePaint(ctx, s, p, true); },

  // corroded gear + red down badge (decay / debuff)
  rust(ctx, s, p) {
    cogPath(ctx, -s * 0.04, -s * 0.02, s * 0.38, 9, 0.24);
    solid(ctx, p, s, p.base, 0.06);
    disc(ctx, -s * 0.04, -s * 0.02, s * 0.21);
    solid(ctx, p, s, p.hi, 0.05);
    dot(ctx, -s * 0.04, -s * 0.02, s * 0.09, p.dark);
    for (const q of [[-0.24, -0.16], [0.06, -0.24], [-0.18, 0.14], [0.12, 0.1]]) {
      dot(ctx, q[0] * s, q[1] * s, s * 0.04, p.dark);
    }
    badge(ctx, p, s, s * 0.32, s * 0.26, s * 0.32, 1);
  },

  // gold starburst with a white core
  crit(ctx, s, p) {
    starPath(ctx, s, 0.5, 0.12);
    solid(ctx, p, s, p.base, 0.06);
    starPath(ctx, s, 0.32, 0.07);
    ctx.fillStyle = p.hi;
    ctx.fill();
    dot(ctx, 0, 0, s * 0.09, p.glass);
  },

  // iron bomb, brass collar, gold fuse, ember spark
  bomb(ctx, s, p) {
    ctx.beginPath();
    ctx.moveTo(s * 0.08, -s * 0.18);
    ctx.quadraticCurveTo(s * 0.22, -s * 0.34, s * 0.34, -s * 0.3);
    strokeTwice(ctx, p, s, p.glass, 0.075);
    disc(ctx, 0, s * 0.1, s * 0.32);
    solid(ctx, p, s, p.base, 0.07);
    ctx.fillStyle = p.hi;
    ctx.beginPath();
    ctx.ellipse(-s * 0.11, -s * 0.02, s * 0.09, s * 0.05, -0.6, 0, TAU);
    ctx.fill();
    box(ctx, -s * 0.11, -s * 0.28, s * 0.22, s * 0.14);        // collar
    solid(ctx, p, s, p.hi, 0.05);
    ctx.beginPath();                                           // spark rays
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      ctx.moveTo(s * 0.34 + Math.cos(a) * s * 0.06, -s * 0.3 + Math.sin(a) * s * 0.06);
      ctx.lineTo(s * 0.34 + Math.cos(a) * s * 0.15, -s * 0.3 + Math.sin(a) * s * 0.15);
    }
    strokeTwice(ctx, p, s, p.accent, 0.055);
    dot(ctx, s * 0.34, -s * 0.3, s * 0.055, p.accent);
  },

  // brass chevrons over steam streaks
  chevrons(ctx, s, p) {
    ctx.beginPath();
    ctx.moveTo(-s * 0.4, s * 0.44); ctx.lineTo(-s * 0.16, s * 0.44);
    ctx.moveTo(-s * 0.07, s * 0.44); ctx.lineTo(s * 0.07, s * 0.44);
    ctx.moveTo(s * 0.16, s * 0.44); ctx.lineTo(s * 0.4, s * 0.44);
    strokeTwice(ctx, p, s, p.accent, 0.055);
    ctx.beginPath();
    ctx.moveTo(-s * 0.32, s * 0.34); ctx.lineTo(0, s * 0.12); ctx.lineTo(s * 0.32, s * 0.34);
    strokeTwice(ctx, p, s, p.base, 0.12);
    ctx.beginPath();
    ctx.moveTo(-s * 0.32, 0); ctx.lineTo(0, -s * 0.22); ctx.lineTo(s * 0.32, 0);
    strokeTwice(ctx, p, s, p.hi, 0.12);
  },

  // dull shell + red down badge (damage loss)
  shellDown(ctx, s, p) {
    ctx.save();
    ctx.translate(-s * 0.1, 0);
    ctx.scale(0.78, 0.78);
    shellPath(ctx, s);
    solid(ctx, p, s, p.base, 0.075);
    ctx.fillStyle = p.hi;
    ctx.fillRect(-s * 0.19, -s * 0.02, s * 0.06, s * 0.4);
    box(ctx, -s * 0.3, s * 0.08, s * 0.6, s * 0.1);
    solid(ctx, p, s, p.glass, 0.05);
    ctx.restore();
    badge(ctx, p, s, s * 0.34, s * 0.1, s * 0.36, 1);
  },

  // brass pocket watch, enamel dial, red hand + down badge (fire-rate loss)
  watchDown(ctx, s, p) {
    const cx = -s * 0.08, cy = s * 0.04, r = s * 0.32;
    box(ctx, -s * 0.16, -s * 0.42, s * 0.16, s * 0.1);         // crown
    solid(ctx, p, s, p.hi, 0.05);
    disc(ctx, cx, cy, r);
    solid(ctx, p, s, p.glass, 0.06);
    disc(ctx, cx, cy, r);
    strokeTwice(ctx, p, s, p.base, 0.08);
    ctx.beginPath();                                           // hour hand
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - s * 0.19);
    strokeTwice(ctx, p, s, p.base, 0.065);
    ctx.beginPath();                                           // red minute hand
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + s * 0.15, cy + s * 0.08);
    strokeTwice(ctx, p, s, p.accent, 0.06);
    dot(ctx, cx, cy, s * 0.04, p.dark);
    badge(ctx, p, s, s * 0.36, -s * 0.24, s * 0.34, 1);
  },
};

// Shared body for plate / plateCracked (see NEGATIVE_OF above).
function platePaint(ctx, s, p, cracked) {
  ctx.beginPath();
  ctx.moveTo(-s * 0.4, -s * 0.44);
  ctx.lineTo(s * 0.4, -s * 0.44);
  ctx.lineTo(s * 0.4, s * 0.12);
  ctx.quadraticCurveTo(s * 0.4, s * 0.4, 0, s * 0.48);
  ctx.quadraticCurveTo(-s * 0.4, s * 0.4, -s * 0.4, s * 0.12);
  ctx.closePath();
  solid(ctx, p, s, p.base, 0.075);
  ctx.fillStyle = p.glass;                                     // bevel
  ctx.fillRect(-s * 0.4, -s * 0.44, s * 0.8, s * 0.07);
  for (const q of [[-0.28, -0.3], [0.28, -0.3], [-0.28, 0.08], [0.28, 0.08]]) {
    dot(ctx, q[0] * s, q[1] * s, s * 0.045, p.hi);
  }
  if (!cracked) return;
  ctx.beginPath();
  ctx.moveTo(-s * 0.06, -s * 0.44);
  ctx.lineTo(s * 0.07, -s * 0.16);
  ctx.lineTo(-s * 0.08, s * 0.04);
  ctx.lineTo(s * 0.05, s * 0.26);
  ctx.lineTo(-s * 0.02, s * 0.46);
  strokeTwice(ctx, p, s, p.accent, 0.07);
}

// ---- level decorations -------------------------------------------------------

// Row of pips under the glyph: how many times this upgrade has been taken.
function drawPips(ctx, s, level, maxLevel) {
  const w = s * 0.12, h = s * 0.1, gap = s * 0.07;
  const total = maxLevel * w + (maxLevel - 1) * gap;
  const y = s * 0.52 - h / 2;
  const lw = Math.max(0.5, s * 0.022);
  let x = -total / 2;
  for (let i = 0; i < maxLevel; i++) {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    const on = i < level;
    ctx.fillStyle = on ? MAT.BRASS_HI : PIP_OFF;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = on ? MAT.INK : MAT.BRASS_LO;
    ctx.stroke();
    x += w + gap;
  }
}

// Fallback for sizes too small for pips: one gold digit inset bottom-right.
function drawNumeral(ctx, s, level) {
  const fs = Math.max(7, s * 0.36);
  const r = fs * 0.62;
  const bx = s * 0.5 - r, by = s * 0.5 - r;
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, TAU);
  ctx.fillStyle = MONO_DARK;
  ctx.fill();
  ctx.lineWidth = Math.max(0.5, fs * 0.1);
  ctx.strokeStyle = MAT.BRASS_LO;
  ctx.stroke();
  ctx.font = `900 ${Math.round(fs)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = MAT.GOLD;
  ctx.fillText(String(level), bx, by + fs * 0.04);
}

// ---- public draw -------------------------------------------------------------

export function hasIcon(name) {
  return typeof PAINTERS[name] === 'function';
}

/**
 * Draw an icon centered on (x, y) inside a box of size s.
 * @param mono  color string -> flatten to that single hue; null -> full palette
 *              (forced on, white by default, below MONO_BELOW px).
 * @param opts  { level, maxLevel = 5, spin, negative }
 * @returns true if something was drawn.
 */
export function drawIcon(ctx, name, x, y, s, mono = null, opts = null) {
  if (!ctx || typeof ctx.save !== 'function') return false;
  if (!(s > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  let key = name;
  if (opts && opts.negative && NEGATIVE_OF[key]) key = NEGATIVE_OF[key];
  const painter = PAINTERS[key];
  if (typeof painter !== 'function') return false;

  const flat = mono || s < MONO_BELOW;
  const p = flat ? monoPalette(typeof mono === 'string' ? mono : MAT.WHITE)
    : (ICON_PALETTES[key] || DEFAULT_PAL);

  const level = opts && Number.isFinite(opts.level) ? Math.max(0, Math.round(opts.level)) : 0;
  const maxLevel = opts && Number.isFinite(opts.maxLevel) ? Math.max(1, Math.round(opts.maxLevel)) : 5;
  const pips = level > 0 && s >= PIPS_MIN && maxLevel <= 5;
  const numeral = !pips && level > 0 && s >= NUMERAL_MIN;
  const spin = opts && Number.isFinite(opts.spin) ? opts.spin : 0;

  ctx.save();
  ctx.translate(x, y);
  // Pips live in the icon box too, so the glyph gives up a little room for them.
  const gs = pips ? s * 0.86 : s;
  ctx.save();
  if (pips) ctx.translate(0, -s * 0.06);
  if (spin) ctx.rotate(spin);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = p.base;
  ctx.strokeStyle = p.dark;
  ctx.lineWidth = Math.max(0.6, gs * 0.075);
  painter(ctx, gs, p);
  ctx.restore();
  if (pips) drawPips(ctx, s, level, maxLevel);
  else if (numeral) drawNumeral(ctx, s, level);
  ctx.restore();
  return true;
}

// ---- offscreen bakes (the only DOM users; safe to import headless) -----------

const spriteCache = new Map();
const urlCache = new Map();
const CACHE_MAX = 192;   // ~2 dprs x 3 sizes x 6 levels x 25 icons is far more
                         // than the HUD ever asks for; drop everything if hit.

function bakeKey(name, px, dpr, opts) {
  const level = opts && Number.isFinite(opts.level) ? Math.max(0, Math.round(opts.level)) : 0;
  const max = opts && Number.isFinite(opts.maxLevel) ? Math.max(1, Math.round(opts.maxLevel)) : 5;
  const neg = opts && opts.negative ? 1 : 0;
  const mono = (opts && typeof opts.mono === 'string') ? opts.mono : '';
  return `${name}|${px}|${dpr}|${level}|${max}|${neg}|${mono}`;
}

/**
 * Memoized offscreen canvas of one icon, px CSS pixels at `dpr` backing scale.
 * Returns null when there is no DOM (Node/tests) or no 2D context.
 */
export function bakeIconSprite(name, px, dpr = 1, opts = null) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  if (!hasIcon(name) && !(opts && opts.negative && NEGATIVE_OF[name])) return null;
  if (!(px > 0)) return null;
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const key = bakeKey(name, px, d, opts);
  const hit = spriteCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(px * d));
  c.height = c.width;
  const g = c.getContext && c.getContext('2d');
  if (!g) return null;
  g.setTransform(d, 0, 0, d, 0, 0);
  const ok = drawIcon(g, name, px / 2, px / 2, px * SPRITE_FILL,
    (opts && typeof opts.mono === 'string') ? opts.mono : null, opts);
  if (!ok) return null;
  if (spriteCache.size >= CACHE_MAX) spriteCache.clear();
  spriteCache.set(key, c);
  return c;
}

/** Memoized data URL of the same bake — for <img> chips in the DOM HUD. */
export function iconDataURL(name, px, dpr = 1, opts = null) {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const key = bakeKey(name, px, d, opts);
  const hit = urlCache.get(key);
  if (hit) return hit;
  const c = bakeIconSprite(name, px, d, opts);
  if (!c || typeof c.toDataURL !== 'function') return '';
  const url = c.toDataURL('image/png');
  if (urlCache.size >= CACHE_MAX) urlCache.clear();
  urlCache.set(key, url);
  return url;
}

/** Drop every bake — call on devicePixelRatio changes. */
export function clearIconCache() {
  spriteCache.clear();
  urlCache.clear();
}
