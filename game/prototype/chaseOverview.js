import * as THREE from 'three';

// 自分の気球と車だけを自動で収める。周囲の気球は画角の計算に含めない。
export function createChaseOverview({ camera, element, getHeight, isActive }) {
  let zoom = 1;
  const pointers = new Map();
  const changeZoom = factor => { zoom = THREE.MathUtils.clamp(zoom * factor, 0.5, 6); };
  element.addEventListener('wheel', event => {
    if (!isActive()) return;
    event.preventDefault();
    changeZoom(Math.exp(THREE.MathUtils.clamp(event.deltaY, -300, 300) * 0.002));
  }, { passive: false });
  element.addEventListener('pointerdown', event => {
    if (!isActive() || event.pointerType !== 'touch') return;
    element.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  element.addEventListener('pointermove', event => {
    if (!isActive()) { pointers.clear(); return; }
    if (!pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId), next = { x: event.clientX, y: event.clientY };
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      if (before > 5 && after > 5) changeZoom(before / after);
    }
    pointers.set(event.pointerId, next);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    element.addEventListener(name, event => pointers.delete(event.pointerId));
  }
  window.addEventListener('blur', () => pointers.clear());
  return {
    reset() { zoom = 1; pointers.clear(); },
    get zoom() { return zoom; },
    update(balloon, car) {
      const bounds = new THREE.Box3().setFromPoints([
        new THREE.Vector3(balloon.x - 10, balloon.y, balloon.z - 10),
        new THREE.Vector3(balloon.x + 10, balloon.y + 28, balloon.z + 10),
        new THREE.Vector3(car.x - 4, car.y, car.z - 4),
        new THREE.Vector3(car.x + 4, car.y + 4, car.z + 4),
      ]);
      const center = bounds.getCenter(new THREE.Vector3());
      const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      // 視線(0,-0.6,-0.8)に対する縦横・奥行きを使い、縦長画面でも両方収める。
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * 0.8;
      const fit = Math.max(half.x / (tanV * camera.aspect), (half.y * 0.8 + half.z * 0.6) / tanV)
        + half.y * 0.6 + half.z * 0.8;
      const distance = Math.max(80, fit) * zoom;
      camera.position.set(center.x, center.y + distance * 0.6, center.z + distance * 0.8);
      camera.position.y = Math.max(camera.position.y, getHeight(camera.position.x, camera.position.z) + 3);
      camera.lookAt(center);
    },
  };
}
