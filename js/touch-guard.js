/*
 * touch-guard.js — stop the browser treating MAXGEAR as a page of text.
 *
 * On a tablet the ship is steered by a horizontal drag, and a thumb that
 * rests on the stat rail or starts its drag on a gate's label is, to Safari,
 * a long press over words: it highlights SPEED or a gate's +2 and offers
 * Copy / Look Up in the middle of a run. css/style.css turns selection and
 * the callout off; this is the half CSS cannot promise, for the engines and
 * the edges where it is not honoured (hub CLAUDE.md §2, "a game is not a
 * document"):
 *
 *   selectstart   cancelled unless it begins in a real text field
 *   contextmenu   cancelled likewise — on touch it IS the long-press menu
 *   selectionchange  anything that slipped through anyway is cleared, unless
 *                 a field has focus. MAXGEAR has no text field today; the
 *                 exemption is there so the day one arrives it still works.
 *
 * The cost, written down: no right-click menu over the game on desktop
 * either. Nothing in a game wants one, and devtools stay a keystroke away.
 *
 * A classic script, self-contained, importing nothing, for the same reason
 * screen.js stands apart from main.js: a failure anywhere in the module
 * graph must not take this down with it, and this must not take anything
 * else down.
 */
(function () {
  'use strict';

  function editable(node) {
    return !!(node && node.closest && node.closest('input, textarea, select, [contenteditable="true"]'));
  }

  document.addEventListener('selectstart', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('contextmenu', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('selectionchange', function () {
    if (editable(document.activeElement)) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
  });
})();
