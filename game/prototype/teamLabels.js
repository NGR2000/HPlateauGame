import * as THREE from 'three';

// 画面を塞がない、小さな1行のチーム目印。寸法はCSSピクセル。
export function addTeamLabel(group, { text, color, name, width }) {
  const height = 30;
  const canvas = document.createElement('canvas');
  canvas.width = width * 3;
  canvas.height = height * 3;
  const ctx = canvas.getContext('2d');
  ctx.scale(3, 3);
  ctx.fillStyle = 'rgba(10, 20, 30, 0.9)';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, 26, 5);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(4, 24, width - 8, 2);
  ctx.beginPath();
  ctx.arc(width / 2, 28, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = 'bold 14px "Yu Gothic UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, 13);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, depthWrite: false, sizeAttenuation: false,
  }));
  label.name = name;
  label.visible = false; // 俯瞰に切り替えたときだけ表示する。
  label.userData.pixelWidth = width;
  label.userData.pixelHeight = height;
  // 非表示の60m目印柱は含めず、モデルの上端に付ける。
  group.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  group.traverseVisible(object => { if (object.isMesh) bounds.expandByObject(object); });
  const top = group.getWorldPosition(new THREE.Vector3());
  if (!bounds.isEmpty()) top.y = bounds.max.y;
  label.position.copy(group.worldToLocal(top));
  label.position.y += 0.3;
  // 札の下端をモデルの上に置き、画面上で4.5pxだけ間を空ける。
  label.center.set(0.5, -0.15);
  label.renderOrder = 20;
  group.add(label);
  const leader = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
  leader.name = `${name}-leader`;
  leader.visible = false;
  leader.frustumCulled = false;
  leader.renderOrder = 19;
  group.add(leader);
  return label;
}

export function updateTeamLabel(label, camera, viewportHeight) {
  if (!label) return;
  // 距離・画面の縦横・端末の解像度によらず、同じ小ささを保つ。
  const unit = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    / camera.zoom / Math.max(1, viewportHeight);
  label.scale.set(label.userData.pixelWidth * unit, label.userData.pixelHeight * unit, 1);
}

export function separateTeamLabels(balloonLabel, carLabel, camera, width, height) {
  if (!balloonLabel || !carLabel) return;
  carLabel.center.x = 0.5;
  const leader = carLabel.parent.getObjectByName(`${carLabel.name}-leader`);
  leader.visible = false;
  camera.updateMatrixWorld();
  const rect = label => {
    const p = label.getWorldPosition(new THREE.Vector3()).project(camera);
    const w = label.userData.pixelWidth, h = label.userData.pixelHeight;
    return { left: (p.x + 1) * width / 2 - w / 2,
      top: (1 - p.y) * height / 2 - (1 - label.center.y) * h, w, h,
      inView: Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && Math.abs(p.z) < 1 };
  };
  const a = rect(balloonLabel), b = rect(carLabel);
  if (!a.inView || !b.inView) return;
  const gap = 6;
  if (a.left < b.left + b.w + gap && b.left < a.left + a.w + gap
    && a.top < b.top + b.h + gap && b.top < a.top + a.h + gap) {
    // 離陸直後など、同じ場所に見えるときだけ車の札を横へ逃がす。
    const shiftRight = a.left + a.w + gap - b.left;
    const shift = b.left + shiftRight + b.w < width - gap
      ? shiftRight : a.left - gap - (b.left + b.w);
    carLabel.center.x -= shift / b.w;
    // ずらした札が別の機体を指して見えないよう、元の車へ細い線をつなぐ。
    const end = carLabel.getWorldPosition(new THREE.Vector3()).project(camera);
    end.x += shift * 2 / width;
    end.y += 6.5 * 2 / height;
    end.unproject(camera);
    carLabel.parent.worldToLocal(end);
    const points = leader.geometry.attributes.position;
    points.setXYZ(0, carLabel.position.x, carLabel.position.y, carLabel.position.z);
    points.setXYZ(1, end.x, end.y, end.z);
    points.needsUpdate = true;
    leader.visible = true;
  }
}
