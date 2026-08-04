// Keyboard + pointer(touch/mouse-drag) input. Semantic one-shot actions are
// queued and consumed by main.js via took(action).

export function createInput(canvas) {
  const keys = { left: false, right: false };
  const presses = new Set();
  let dragPx = 0;              // accumulated horizontal drag in CSS pixels
  let pointerId = null;
  let lastPointerX = 0;

  const press = (a) => presses.add(a);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': keys.left = true; break;
      case 'ArrowRight': case 'KeyD': keys.right = true; break;
      case 'Space': case 'Enter': press('start'); e.preventDefault(); break;
      case 'KeyR': press('restart'); break;
      case 'Escape': case 'KeyP': press('pause'); break;
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
