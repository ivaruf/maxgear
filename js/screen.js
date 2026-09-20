// The fullscreen plate in the title screen's corner. That is the whole file.
//
// DELIBERATELY SELF-CONTAINED: this module imports nothing, exports nothing,
// and no other file in MAXGEAR knows it exists. index.html loads it as its own
// <script type="module">, BESIDE js/main.js rather than from inside it. That is
// the design, not an oversight. The title screen is plain markup that the
// browser paints before a line of the game runs, so if the game itself fails to
// boot — a level that will not parse, a renderer throwing on some browser we
// have never seen — the one button that makes a phone worth holding sideways is
// still there and still works. The reverse matters just as much: nothing in
// here can take the game down with it.
//
// THE FILENAME IS LOAD-BEARING. It is not fullscreen.js and that word appears
// nowhere in this path. uBlock Origin's DEFAULT filter lists carry a rule
// banning that basename across the whole of github.io — it reads the name and
// never looks inside the file — and every game in this hub shares that origin.
// fishtank shipped a client/js/fullscreen.js and served a blank screen to every
// visitor running uBlock, because a blocked static dependency aborts the entire
// module graph rather than just the one file. Hub CLAUDE.md §2 has the story.
//
// NOT EVERY BROWSER HAS THIS. Safari on iPhone has no element fullscreen at all
// — there it belongs to <video> and nothing else — so the plate ships `hidden`
// in the markup and is only uncovered once a working request/exit PAIR has
// answered. A pushbutton that does nothing when pressed is worse than no
// pushbutton; the corner simply shrinks to the sound plate and nothing else in
// the game has to care.
//
// Inside the arcade this still works: the arcade frames every game with
// allow="fullscreen; …" already.
//
// One thing this file does NOT do is stop the click from bubbling. The title
// screen starts a run on a click anywhere, so reaching for this plate must not
// launch one — that is handled once for the whole cluster in js/ui.js, in the
// same breath as the sound board's, rather than teaching this module about a
// screen it should know nothing about. If ui.js never ran, neither did the
// title screen's click handler, so there is nothing to bubble into.

const button = document.getElementById('btn-screen');
const root = document.documentElement;

// The webkit-prefixed pair is the fallback for older Safari on the desktop.
// Everywhere else this game runs, the unprefixed names are what exist.
const request = root.requestFullscreen || root.webkitRequestFullscreen || null;
const exit = document.exitFullscreen || document.webkitExitFullscreen || null;

function isFull() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

// Keep the engraving and the words matching reality, whoever changed it.
//
// The glyph is a picture, so the accessible name is the only thing that can say
// which way the plate is currently thrown — hence aria-label and title rather
// than textContent. CSS swaps the two paths inside the one <svg> off the same
// aria-pressed attribute, so what is drawn and what is announced cannot drift.
//
// The words stay plain rather than being dressed in MAXGEAR's voice, which is
// the one place this cluster does not follow the house rule about naming
// controls the way the game names them. Fullscreen is not part of the fiction —
// it is a thing the browser does, it has one name everywhere, and "OPEN THE
// THROTTLE" would leave a player guessing whether it changed the gearing.
function paint() {
  const active = isFull();
  const label = active ? 'Exit fullscreen' : 'Fullscreen';
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', label);
  button.title = label;
}

if (button && request && exit) {
  button.hidden = false;
  paint();

  button.addEventListener('click', () => {
    const result = isFull() ? exit.call(document) : request.call(root);
    // Either call returns a promise that is allowed to reject: a permissions
    // policy refusing it, or a player backing out of the browser's own prompt.
    // What actually happened is repainted from the change event below, so this
    // catch exists only to keep a refusal from surfacing as an unhandled
    // rejection in the console.
    if (result && typeof result.catch === 'function') result.catch(() => {});
  });

  // The plate is not the only way out of fullscreen — Escape and the browser's
  // own chrome both leave without ever touching it — so the label has to be
  // able to catch up from outside the click handler.
  document.addEventListener('fullscreenchange', paint);
  document.addEventListener('webkitfullscreenchange', paint);
}
