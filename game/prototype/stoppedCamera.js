import * as THREE from 'three';

// GameTargetの停車中カメラと同じ操作。位置を固定して見回し、画角でズームする。
// 参照: https://rhitomigm-hash.github.io/GameTarget/prototype/stoppedCamera.js
export function createStoppedCamera({ camera, element, canMove, render }) {
  let active = false, yaw = 0, pitch = 0;
  const originalFov = camera.fov;
  const pointers = new Map();
  function reset() {
    active = false;
    pointers.clear();
    if (camera.fov !== originalFov) {
      camera.fov = originalFov;
      camera.updateProjectionMatrix();
    }
  }
  function move(dx, dy, dolly = 0) {
    if (!canMove()) { reset(); return; }
    if (!active) {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      yaw = Math.atan2(direction.x, -direction.z);
      pitch = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
    }
    yaw -= dx * 0.0038;
    pitch = THREE.MathUtils.clamp(pitch - dy * 0.0038,
      -THREE.MathUtils.degToRad(85), THREE.MathUtils.degToRad(85));
    const cy = Math.cos(pitch);
    camera.lookAt(camera.position.x + Math.sin(yaw) * cy,
      camera.position.y + Math.sin(pitch), camera.position.z - Math.cos(yaw) * cy);
    camera.fov = THREE.MathUtils.clamp(camera.fov - dolly, 25, 85);
    camera.updateProjectionMatrix();
    active = true;
    render();
  }
  element.addEventListener('pointerdown', event => {
    if (!canMove() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    element.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  element.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId), next = { x: event.clientX, y: event.clientY };
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      move(0, 0, (Math.hypot(next.x - other.x, next.y - other.y)
        - Math.hypot(prev.x - other.x, prev.y - other.y)) * 0.15);
    } else move(next.x - prev.x, next.y - prev.y);
    if (canMove()) pointers.set(event.pointerId, next);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    element.addEventListener(name, event => pointers.delete(event.pointerId));
  }
  element.addEventListener('wheel', event => {
    if (!canMove()) return;
    event.preventDefault();
    move(0, 0, -THREE.MathUtils.clamp(event.deltaY, -200, 200) * 0.08);
  }, { passive: false });
  window.addEventListener('blur', () => pointers.clear());
  return { reset, get active() { return active; } };
}
