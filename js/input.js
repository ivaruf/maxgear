// Keyboard + pointer(touch/mouse-drag) input. Semantic one-shot actions are
// queued and consumed by main.js via took(action).

export function createInput(canvas, { escape = null } = {}) {
  const keys = { left: false, right: false };
  const presses = new Set();
  let dragPx = 0;              // accumulated horizontal drag in CSS pixels
  let pointerId = null;
  let lastPointerX = 0;

  const press = (a) => presses.add(a);
  const isControl = (el) => !!el && (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'A');

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': keys.left = true; break;
      case 'ArrowRight': case 'KeyD': keys.right = true; break;
      // v1.6: never take Space/Enter off a focused control. The menus are real
      // buttons and real sliders, and preventDefault here suppresses the click
      // a browser would otherwise synthesise — which silently made every
      // screen mouse-only for anyone working the game from the keyboard.
      case 'Space': case 'Enter':
        if (isControl(e.target)) return;
        press('start');
        e.preventDefault();
        break;
      case 'KeyR': press('restart'); break;
      // ESCAPE IS NOT A QUEUED ACTION, and not another name for P. The hub
      // gives it one meaning in every game — one step back, and from the title
      // that step is the arcade — while P stays a pause key and nothing more;
      // folding the two together is how Escape on the title came to do nothing
      // at all. It is answered HERE, inside the keypress, by main.js's
      // escapeStep(), rather than queued for the next animation frame like the
      // rest: so it never sits in the queue to fire later on some other
      // screen, never shares a frame with a start or a pause, and leaving the
      // game happens inside the key's own user activation, which closing an
      // installed window can need. preventDefault so the page does nothing
      // else with it (leaving fullscreen is the browser's own, and it takes
      // that Esc before any page sees it).
      case 'Escape':
        e.preventDefault();
        if (escape) escape();
        break;
      case 'KeyP': press('pause'); break;
      case 'KeyM': press('mute'); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': keys.left = false; break;
      case 'ArrowRight': case 'KeyD': keys.right = false; break;
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    pointerId = e.pointerId;
    lastPointerX = e.clientX;
    press('tap');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    dragPx += e.clientX - lastPointerX;
    lastPointerX = e.clientX;
  });
  const endPointer = (e) => { if (e.pointerId === pointerId) pointerId = null; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  return {
    axis() { return (keys.right ? 1 : 0) - (keys.left ? 1 : 0); },
    takeDrag() { const d = dragPx; dragPx = 0; return d; },
    took(action) { return presses.delete(action); },
    clear() { presses.clear(); dragPx = 0; },
  };
}
