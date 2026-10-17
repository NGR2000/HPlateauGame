// 指をボタンの外へ動かしても、離した瞬間を必ず受け取る。
export function holdButton(button, onDown, onUp) {
  const pointers = new Set();
  const reset = () => {
    pointers.clear();
    button.classList.remove('active');
    onUp();
  };
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointers.add(event.pointerId);
    button.setPointerCapture(event.pointerId);
    button.classList.add('active');
    onDown();
  });
  const release = event => {
    pointers.delete(event.pointerId);
    if (!pointers.size) reset();
  };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(name, release);
  }
  button.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  return reset;
}

// キーボードと複数の指をまとめ、片方を離しても他の入力が残るようにする。
export function bindCarControls(input) {
  const keys = new Set(), touches = new Set();
  const mapping = {
    KeyW: 'forward', ArrowUp: 'forward', KeyS: 'reverse', ArrowDown: 'reverse',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  };
  const update = () => {
    const active = new Set([...touches, ...[...keys].map(key => mapping[key])]);
    input.throttle = Number(active.has('forward')) - Number(active.has('reverse'));
    input.steer = Number(active.has('right')) - Number(active.has('left'));
  };
  const releases = ['forward', 'reverse', 'left', 'right'].map(action =>
    holdButton(document.getElementById(`tc-car-${action}`),
      () => { touches.add(action); update(); },
      () => { touches.delete(action); update(); }));
  window.addEventListener('keydown', event => {
    if (!mapping[event.code] || event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    keys.add(event.code);
    update();
  });
  window.addEventListener('keyup', event => {
    if (!mapping[event.code]) return;
    keys.delete(event.code);
    update();
  });
  const reset = () => {
    keys.clear();
    releases.forEach(release => release());
    update();
  };
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  return reset;
}
