/*
 * intro.js — the three-second sting that plays when the game opens.
 *
 * The machine starting. Three brass gears roll in from the edges of a
 * soot-dark plate and drop into mesh, tooth in gap; the train turns over
 * slowly, then spins up hard; steam bursts out of the mesh points; and the
 * brass MAXGEAR slams down out of the steam with a jolt, then flies up to
 * the exact place the title screen keeps it while the curtain fades onto
 * the title. The palette, the type and the gear are the game's own:
 * css/style.css's iron, brass and copper, its --font-display engraved-plate
 * stack (read off the real <h1> rather than copied), and the same
 * eight-spoked cog its title screen turns in the corners.
 *
 * The only word is MAXGEAR itself, which is the game's name and is never
 * translated (hub §2), so there is nothing here for js/i18n.js to do.
 *
 * WHAT IT MAY NOT DO
 *   - Cost anyone a run (hub §1). It only ever plays at page load, over the
 *     title screen, and any tap or key skips straight to the hand-off.
 *   - Let the skipping press through. A key is swallowed in the capture
 *     phase on window — capture on window runs before anything bubbling, and
 *     this script runs async from the top of <body>, long before main.js's
 *     module graph, so it is registered ahead of js/input.js's keydown —
 *     because the press that skips must not also be the title's Escape
 *     (which is the way out to the arcade), or its Space and Enter, which
 *     start a run. A tap lands on the curtain itself, which covers the whole
 *     title — and the title starts a run on a click ANYWHERE, so it matters
 *     that the tap's click lands on this canvas and not on the screen below.
 *   - Delay the game. It is a curtain over the page, not a gate in front of
 *     it: the modules, the audio and the sprite bakes run underneath while
 *     it plays.
 *   - Disturb the layout. It is one fixed canvas over everything and moves
 *     no element; the landscape-phone grid and the title's own logoIn
 *     animation (which finishes under the curtain) are untouched.
 *   - Play for someone who has asked for less motion. prefers-reduced-motion
 *     means the script does nothing at all.
 *
 * A classic script, self-contained, importing nothing, for the reason
 * touch-guard.js stands apart: if anything in the module graph fails, the
 * curtain must still lift. Every frame runs inside a try, a hard timeout
 * removes the curtain whatever happens, and a failure of this file leaves
 * the game exactly as it was without it.
 *
 * Canvas 2D, devicePixelRatio capped at 2, the gear outline and the steam
 * puff baked once and no allocation in the frame loop (hub §10).
 */
(function () {
  "use strict";

  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (e) {
    /* No matchMedia: play it. */
  }

  // css/style.css's materials, copied rather than imported because this
  // file imports nothing.
  var IRON_TOP = "#1f1813";
  var IRON_LOW = "#0c0906";
  var BRASS = "#c9973b";
  var BRASS_LT = "#f0b429";
  var BRASS_HI = "#ffe9bd";
  var COPPER = "#b0652f";
  var SOOT = "#120e0a";
  var INK = "#f4e5c4";

  // The timeline, in milliseconds. ROLL: the gears roll in and mesh. SPIN:
  // the train spins up from there. STEAM: the first burst from the mesh
  // points. SLAM: the wordmark drops, with a jolt and a second burst. LAND
  // starts the hand-off, which takes LAND_MS (or SKIP_MS when skipped).
  var ROLL = 750;
  var SPIN = 750;
  var STEAM = 1150;
  var SLAM = 1500;
  var SLAM_MS = 360;
  var LAND = 2450;
  var LAND_MS = 650;
  var SKIP_MS = 350;

  // ---- the gear, baked once ---------------------------------------------
  //
  // One outline for every gear, in teeth: a unit gear whose tooth pitch is
  // the same at every size, so a gear of N teeth has radius N / NA and any
  // two of them mesh. Each tooth is a trapezoid from root to tip.
  var NA = 16; // teeth on the big gear; the others are in proportion
  var GEARS = [
    // teeth, mesh angle from the big gear (rad), entry direction (rad)
    { n: 16, phi: 0, from: Math.PI },
    { n: 11, phi: -0.42, from: -0.3 },
    { n: 8, phi: 2.35, from: Math.PI * 0.62 },
  ];
  var TIP = 1;
  var ROOT = 0.84;
  function outline(n) {
    var pts = new Float32Array(n * 8);
    var step = (Math.PI * 2) / n;
    // Angular half-widths at the root and at the tip, as fractions of the
    // pitch: a tooth narrows towards its tip.
    var hr = step * 0.27;
    var ht = step * 0.17;
    for (var k = 0; k < n; k++) {
      var c = k * step;
      pts[k * 8] = Math.cos(c - hr - step * 0.06) * ROOT;
      pts[k * 8 + 1] = Math.sin(c - hr - step * 0.06) * ROOT;
      pts[k * 8 + 2] = Math.cos(c - ht) * TIP;
      pts[k * 8 + 3] = Math.sin(c - ht) * TIP;
      pts[k * 8 + 4] = Math.cos(c + ht) * TIP;
      pts[k * 8 + 5] = Math.sin(c + ht) * TIP;
      pts[k * 8 + 6] = Math.cos(c + hr + step * 0.06) * ROOT;
      pts[k * 8 + 7] = Math.sin(c + hr + step * 0.06) * ROOT;
    }
    return pts;
  }
  for (var g = 0; g < GEARS.length; g++) {
    GEARS[g].pts = outline(GEARS[g].n);
    GEARS[g].r = GEARS[g].n / NA; // radius as a fraction of the big gear's
    GEARS[g].x = 0; // resting centre, set on resize
    GEARS[g].y = 0;
    GEARS[g].c = 0; // phase that puts tooth into gap; set below
  }
  // Meshing: when the big gear has a tooth pointing along phi, the small one
  // must have a gap pointing back along phi + PI. Gear angles are tied by
  // theta_i = -theta_0 * (N0 / Ni) + c_i, so solve c_i for that moment.
  for (var m = 1; m < GEARS.length; m++) {
    var G = GEARS[m];
    var stepI = (Math.PI * 2) / G.n;
    G.c = G.phi + Math.PI - 0.5 * stepI + G.phi * (NA / G.n);
  }

  // Steam: puffs from the two mesh points, each with a direction, a speed
  // and a birth time — fixed, so the sting is the same every time. The
  // first half go at STEAM, the second half with the slam.
  var NP = 28;
  var puffs = new Float32Array(NP * 3);
  for (var p = 0; p < NP; p++) {
    var j = (p * 0.61803) % 1;
    puffs[p * 3] = j * Math.PI * 2; // direction
    puffs[p * 3 + 1] = 0.35 + ((p * 7) % 10) / 14; // speed, big-gear radii/s
    puffs[p * 3 + 2] = (p < NP / 2 ? STEAM : SLAM) + ((p * 13) % 9) * 14; // born
  }

  var canvas = document.createElement("canvas");
  canvas.id = "intro";
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  // The puff sprite: a soft white blot, drawn once and scaled per puff.
  var puff = document.createElement("canvas");
  puff.width = puff.height = 64;
  var pctx = puff.getContext("2d");
  if (pctx) {
    var pg = pctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    pg.addColorStop(0, "rgba(240, 235, 225, 0.85)");
    pg.addColorStop(0.5, "rgba(230, 225, 215, 0.35)");
    pg.addColorStop(1, "rgba(230, 225, 215, 0)");
    pctx.fillStyle = pg;
    pctx.fillRect(0, 0, 64, 64);
  }

  // Brass for the gear bodies, in the gear's own unit space (the transform
  // scales it with the gear), so one gradient serves all three.
  var brassGrad = ctx.createRadialGradient(-0.35, -0.4, 0.1, 0, 0, 1.05);
  brassGrad.addColorStop(0, BRASS_HI);
  brassGrad.addColorStop(0.35, BRASS_LT);
  brassGrad.addColorStop(0.75, BRASS);
  brassGrad.addColorStop(1, COPPER);

  var W = 0;
  var H = 0;
  var dpr = 1;
  var R = 1; // the big gear's radius in CSS pixels
  var cx = 0;
  var cy = 0;
  var plate = null;
  var glow = null;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    cx = W / 2;
    cy = H / 2;
    // The whole train spans a little under three big-gear radii.
    R = Math.min(W, H) * 0.24;
    GEARS[0].x = cx - R * 0.25;
    GEARS[0].y = cy + R * 0.12;
    for (var i = 1; i < GEARS.length; i++) {
      // Centres closer than the sum of the radii by the tooth depth, so the
      // teeth sit in each other's gaps.
      var d = R * (1 + GEARS[i].r) * (TIP + ROOT) * 0.5 + R * 0.02;
      GEARS[i].x = GEARS[0].x + Math.cos(GEARS[i].phi) * d;
      GEARS[i].y = GEARS[0].y + Math.sin(GEARS[i].phi) * d;
    }
    // The title screen's own ground: iron, with a brass glow where the
    // wordmark stands (css/style.css #screen-title).
    plate = ctx.createLinearGradient(0, 0, 0, H);
    plate.addColorStop(0, IRON_TOP);
    plate.addColorStop(1, IRON_LOW);
    glow = ctx.createRadialGradient(cx, H * 0.36, 0, cx, H * 0.36, Math.max(W, H) * 0.6);
    glow.addColorStop(0, "rgba(140, 94, 34, 0.42)");
    glow.addColorStop(1, "rgba(18, 13, 10, 0)");
    target = null;
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }
  function easeOut(x) {
    return 1 - Math.pow(1 - x, 3);
  }
  function easeOutBack(x) {
    var c = 1.7;
    return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
  }
  function easeInOut(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  // ---- the title's wordmark, measured --------------------------------------
  //
  // Where the <h1> actually draws its letters (a Range round its text, not
  // the block's box), its font as computed, and the canvas widths of the two
  // halves in that font. The canvas text is scaled to span exactly the real
  // letters, which absorbs a browser without canvas letterSpacing.
  var target = null;
  var word = { x: 0, y: 0, w: 0, a: 0, b: 0, font: "", ls: "0px", found: false };
  var realWord = null;
  var gearGrad = null;
  function measure() {
    var h1 = document.querySelector("#screen-title h1");
    realWord = h1;
    var b = null;
    var cs = null;
    if (h1) {
      var range = document.createRange();
      range.selectNodeContents(h1);
      b = range.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) b = null;
      else cs = getComputedStyle(h1);
    }
    if (cs) {
      word.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      word.ls = cs.letterSpacing;
    } else {
      // No title to land on: the screen's own type, at its own size.
      word.font = "900 " + Math.round(Math.min(88, Math.max(42, W * 0.11))) + "px Copperplate, Didot, Georgia, serif";
      word.ls = "6px";
    }
    ctx.font = word.font;
    if ("letterSpacing" in ctx) ctx.letterSpacing = word.ls;
    word.a = ctx.measureText("MAX").width;
    word.b = ctx.measureText("GEAR").width;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    word.found = !!b;
    if (b) {
      word.x = b.left;
      word.y = b.top + b.height / 2;
      word.w = b.width;
    } else {
      word.w = word.a + word.b;
      word.x = cx - word.w / 2;
      word.y = cy;
    }
    // The shine across GEAR (css/style.css #screen-title h1 .accent), in the
    // text's own space so it travels with the letters.
    gearGrad = ctx.createLinearGradient(word.a, 0, word.a + word.b, 0);
    gearGrad.addColorStop(0, COPPER);
    gearGrad.addColorStop(0.3, BRASS_LT);
    gearGrad.addColorStop(0.5, "#fff4d6");
    gearGrad.addColorStop(0.7, BRASS_LT);
    gearGrad.addColorStop(1, "#a35d24");
    return true;
  }

  var t0 = 0;
  var landAt = LAND;
  var landMs = LAND_MS;
  var remeasured = false;
  var done = false;
  var raf = 0;

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", size);
    if (realWord) realWord.style.visibility = "";
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function skip() {
    var now = performance.now() - t0;
    if (now >= landAt) return;
    landAt = now;
    landMs = SKIP_MS;
  }

  function onKey(e) {
    // Skip, and let the press go no further: see the header.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) skip();
  }

  // ---- drawing -----------------------------------------------------------

  // The big gear's angle at time t (seconds): turning over slowly as it
  // rolls in, then spinning up hard once the train is meshed.
  function theta(ts) {
    var s = SPIN / 1000;
    var over = ts > s ? ts - s : 0;
    return 0.9 * ts + 2.4 * over * over;
  }

  function drawGear(G, x, y, ang, alpha) {
    var r = R * G.r;
    var c = Math.cos(ang) * r * dpr;
    var s = Math.sin(ang) * r * dpr;
    ctx.setTransform(c, s, -s, c, x * dpr, y * dpr);
    ctx.globalAlpha = alpha;
    // The body: teeth and rim in brass, outlined in soot.
    var pts = G.pts;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fillStyle = brassGrad;
    ctx.fill();
    ctx.lineWidth = 0.035;
    ctx.strokeStyle = SOOT;
    ctx.stroke();
    // The web, cut away to soot between four spokes, and the hub.
    ctx.fillStyle = SOOT;
    ctx.beginPath();
    ctx.arc(0, 0, 0.64, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = brassGrad;
    ctx.fillRect(-0.64, -0.09, 1.28, 0.18);
    ctx.fillRect(-0.09, -0.64, 0.18, 1.28);
    ctx.beginPath();
    ctx.arc(0, 0, 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SOOT;
    ctx.beginPath();
    ctx.arc(0, 0, 0.09, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTrain(t, fade, jolt) {
    var ts = t / 1000;
    var th = theta(ts);
    var roll = easeOut(clamp01(t / ROLL));
    var far = Math.hypot(W, H) * 0.7;
    for (var i = 0; i < GEARS.length; i++) {
      var G = GEARS[i];
      // Rolling in from beyond the edge along its own direction.
      var off = (1 - roll) * far;
      var x = G.x + Math.cos(G.from) * off;
      var y = G.y + Math.sin(G.from) * off + jolt;
      var ang = i === 0 ? th : -th * (NA / G.n) + G.c;
      drawGear(G, x, y, ang, fade);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }

  function drawSteam(t, fade) {
    if (!pctx) return;
    for (var i = 0; i < NP; i++) {
      var age = (t - puffs[i * 3 + 2]) / 1000;
      if (age <= 0 || age > 1.1) continue;
      // Odd puffs from one mesh point, even from the other.
      var G = GEARS[1 + (i % 2)];
      var mx = (GEARS[0].x + G.x) / 2;
      var my = (GEARS[0].y + G.y) / 2;
      var dir = puffs[i * 3];
      var sp = puffs[i * 3 + 1] * R * 1.6;
      // Steam rises: a drift up on top of the burst, slowing as it spreads.
      var k = 1 - Math.pow(1 - age / 1.1, 2);
      var x = mx + Math.cos(dir) * sp * k;
      var y = my + Math.sin(dir) * sp * k - R * 0.5 * age;
      var size = R * (0.25 + 0.9 * k);
      ctx.globalAlpha = fade * 0.8 * (1 - age / 1.1);
      ctx.drawImage(puff, x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  // The wordmark, its letters' box scaled by `s` about the point (x, y).
  function drawWord(x, y, s, alpha) {
    var total = word.a + word.b;
    var k = (word.w / total) * s;
    ctx.globalAlpha = alpha;
    ctx.font = word.font;
    if ("letterSpacing" in ctx) ctx.letterSpacing = word.ls;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (x - (total / 2) * k), dpr * y);
    // The plate's hard drop and a brass glow, as on the title's <h1>.
    ctx.shadowColor = "rgba(240, 180, 41, 0.45)";
    ctx.shadowBlur = 22 * dpr;
    ctx.fillStyle = INK;
    ctx.fillText("MAX", 0, 0);
    ctx.fillStyle = gearGrad;
    ctx.fillText("GEAR", word.a, 0);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (done) return;
    try {
      if (!t0) t0 = now;
      var t = now - t0;
      var land = clamp01((t - landAt) / landMs);
      if (land >= 1) {
        finish();
        return;
      }
      var fade = 1 - easeInOut(land);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = fade;
      ctx.fillStyle = plate;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;

      // The slam's jolt: the whole train kicks down and settles.
      var sl = (t - SLAM) / SLAM_MS;
      var jolt = sl > 0 && sl < 1 ? Math.sin(sl * Math.PI * 3) * (1 - sl) * R * 0.06 : 0;

      // The gears dim behind the wordmark once it is down, so it reads.
      var behind = 1 - 0.45 * clamp01((t - SLAM) / 400);
      drawTrain(t, fade * behind, jolt);
      drawSteam(t, fade);

      // The wordmark: slams down at centre stage, holds, then flies home.
      var si = (t - SLAM) / SLAM_MS;
      if (land > 0 && si < 1) si = 1; // a skip before the slam lands it whole
      if (si > 0) {
        if (land > 0 && !remeasured) {
          // Once more as the hand-off begins: the title may have shown its
          // quit button, or repainted in English, since the first look.
          remeasured = true;
          target = null;
        }
        if (target === null) target = measure();
        // Centre stage: as large as fits, up to a third larger than home.
        var stageS = Math.min(1.35, (W * 0.88) / word.w);
        var sx = cx;
        var sy = cy;
        var sc = stageS * (1 + 1.2 * (1 - easeOutBack(clamp01(si))));
        var alpha = clamp01(si * 3);
        if (land > 0) {
          var k = easeInOut(land);
          if (word.found) {
            sx += (word.x + word.w / 2 - sx) * k;
            sy += (word.y - sy) * k;
            sc += (1 - sc) * k;
            // The real letters step aside while the flying ones are on
            // their way, so the fading curtain never shows two wordmarks,
            // and come back for the last stretch, where the two cross-fade
            // in the same place.
            if (realWord) realWord.style.visibility = land < 0.75 ? "hidden" : "";
            alpha *= 1 - clamp01((land - 0.75) / 0.25);
          } else {
            alpha *= 1 - k; // no title on screen to land on: just fade
          }
        }
        drawWord(sx, sy, sc, alpha);
      }
    } catch (e) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    size();
    window.addEventListener("resize", size);
    window.addEventListener("keydown", onKey, true);
    canvas.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      skip();
    });
    document.body.appendChild(canvas);
    raf = requestAnimationFrame(frame);
    // Whatever happens to the frame loop, the curtain does not outstay this.
    setTimeout(finish, 6000);
  }

  // Loaded from the top of <body>, so the body exists even though the rest
  // of the page may not have been parsed yet.
  start();
})();
