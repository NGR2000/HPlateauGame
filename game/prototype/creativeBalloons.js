// 創作の世界専用。チームのモデルと、周囲を飛ぶ5機の軽量な気球。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createBalloonAutopilot } from './balloonAutopilot.js';

export async function loadTeamBalloonModel() {
  const { scene } = await new GLTFLoader().loadAsync(
    new URL('./assets/MV56b_hot_air_balloon.glb', import.meta.url).href);
  scene.name = 'MV56b-team-model';
  return scene;
}

export function markTeamBalloon(group) {
  group.name = 'creative-team-balloon';
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#083e4e';
  ctx.beginPath();
  ctx.roundRect(4, 4, 504, 120, 22);
  ctx.fill();
  ctx.strokeStyle = '#8cf4e8';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 38px "Yu Gothic UI", sans-serif';
  ctx.fillText('自分のチーム', 256, 54);
  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#9bf2e7';
  ctx.fillText('MV56b', 256, 98);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, depthWrite: false, sizeAttenuation: false,
  }));
  label.name = 'team-balloon-label';
  const height = new THREE.Box3().setFromObject(group).max.y;
  label.userData.envelopeTop = height;
  label.position.y = height + 5;
  label.scale.set(0.22, 0.055, 1);
  label.renderOrder = 20;
  group.add(label);
}

export function updateTeamBalloonLabel(group, camera) {
  const label = group.getObjectByName('team-balloon-label');
  if (!label) return;
  // 画面上で一定サイズの札が、遠景でも球皮を覆わない高さに置く。
  const distance = camera.position.distanceTo(group.position);
  label.position.y = label.userData.envelopeTop + 3 + distance * 0.035;
}

export function createTeamBalloon(model) {
  const group = new THREE.Group();
  group.add(model);
  markTeamBalloon(group);
  // 元モデルのツインバーナーに合わせた炎。球皮の配色はそのまま保持する。
  const flame = new THREE.Group();
  for (const x of [-0.23, 0.23]) {
    const jet = new THREE.Mesh(new THREE.ConeGeometry(0.14, 1.1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffba52, side: THREE.DoubleSide,
        transparent: true, opacity: 0.85 }));
    jet.position.set(x, 2.85, 0);
    flame.add(jet);
  }
  flame.visible = false;
  group.add(flame);
  const flameLight = new THREE.PointLight(0xffa040, 0, 30);
  flameLight.position.y = 2.4;
  group.add(flameLight);
  return { group, flame, flameLight, envInnerMat: null, rope: null };
}

const TRAFFIC = [
  { color: '#d95848', stripe: '#ffe5ba', dx: -130, dz: -70, height: 70, cruise: [350, 600, 900] },
  { color: '#e69b30', stripe: '#fff1ca', dx: 120, dz: -110, height: 95, cruise: [500, 800, 1100] },
  { color: '#875aab', stripe: '#ede2fc', dx: -200, dz: 90, height: 120, cruise: [700, 1000, 1400] },
  { color: '#789b3b', stripe: '#f3efba', dx: 210, dz: 65, height: 145, cruise: [900, 1200, 1600] },
  { color: '#cf6c9e', stripe: '#ffe2ed', dx: 25, dz: 200, height: 170, cruise: [1100, 1500, 1800] },
];

function trafficMesh(color, stripe) {
  const group = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 ? stripe : color;
    ctx.fillRect(i * 16, 0, 16, 32);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const envelope = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16),
    new THREE.MeshLambertMaterial({ map: texture }));
  envelope.scale.y = 1.18;
  envelope.position.y = 13.5;
  group.add(envelope);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 0.65, 3.5, 16, 1, true),
    new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  skirt.position.y = 4.7;
  group.add(skirt);
  const basket = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 1.2),
    new THREE.MeshLambertMaterial({ color: 0x9d7749 }));
  basket.position.y = 0.5;
  group.add(basket);
  const supportMaterial = new THREE.MeshLambertMaterial({ color: 0x52493c });
  for (const x of [-0.5, 0.5]) {
    for (const z of [-0.5, 0.5]) {
      const support = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.2, 4), supportMaterial);
      support.position.set(x, 2, z);
      group.add(support);
    }
  }
  return group;
}

export function createCreativeFleet({ startX, startZ, getHeight, windAt, bounds }) {
  const group = new THREE.Group();
  group.name = 'creative-traffic-fleet';
  const balloons = TRAFFIC.map((profile, index) => {
    const mesh = trafficMesh(profile.color, profile.stripe);
    mesh.name = `creative-traffic-balloon-${index + 2}`;
    const pos = new THREE.Vector3(startX + profile.dx, 0, startZ + profile.dz);
    pos.y = getHeight(pos.x, pos.z) + profile.height;
    mesh.position.copy(pos);
    group.add(mesh);
    return { mesh, pos, vy: 0, heat: 0.65, profile,
      pilot: createBalloonAutopilot({ windAt,
        targetX: profile.dx, targetZ: profile.dz, cruiseScanFt: profile.cruise }) };
  });

  function update(dt) {
    if (dt <= 0) return;
    // 時間加速時も浮力の計算が不安定にならないよう細分化する。
    const steps = Math.ceil(dt / 0.05);
    const h = dt / steps;
    for (let step = 0; step < steps; step++) {
      for (const balloon of balloons) {
        const { pos, pilot, profile } = balloon;
        const control = pilot.control(pos, balloon.vy, h);
        balloon.heat = THREE.MathUtils.clamp(balloon.heat
          + (control.burner ? 0.055 * h : 0) - (control.rip ? 0.16 * h : 0) - 0.012 * h, 0, 1);
        balloon.vy += (7 * (balloon.heat - 0.5) - 0.5 * balloon.vy) * h;
        pos.y += balloon.vy * h;
        const wind = windAt(pos.y, pos.x, pos.z);
        pos.x += wind.vx * h;
        pos.z += wind.vz * h;
        const ground = getHeight(pos.x, pos.z);
        if (pos.y < ground + 5) {
          pos.y = ground + 5;
          balloon.vy = Math.max(0, balloon.vy);
        }
        // 地形の外へ出た機体は出発地点の上空へ戻し、6機の風景を維持する。
        if (bounds && (pos.x < bounds.minX || pos.x > bounds.maxX
          || pos.z < bounds.minZ || pos.z > bounds.maxZ)) {
          pos.set(startX + profile.dx, getHeight(startX + profile.dx, startZ + profile.dz) + profile.height,
            startZ + profile.dz);
          balloon.vy = 0;
          balloon.heat = 0.65;
        }
        balloon.mesh.position.copy(pos);
      }
    }
  }
  return { group, update, positions: () => balloons.map(balloon => balloon.pos) };
}
