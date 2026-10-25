import { parseFlightSettings, validateWind, buildShareQuery, validStartTime, FLIGHT_LIMITS } from './flightSettings.js';
import { createTileLoader } from './tileLoader.js';
// 熱気球フライト プロトタイプ
// 佐賀・嘉瀬川周辺(約20km四方)を地理院タイルから生成し、
// バーナー/リップライン(上下操作)+ 高度別レイヤーの風で飛ぶ。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTerrain, lonLatToTile } from './terrain.js';
// ?mode=chase 専用: 「マーカー回収レース」(プレイヤーが車を操縦、気球はオートパイロット)。
// フェーズ1デモ(chase/)で検証した2モジュールをそのまま使う。**気球の物理には一切触れない**
// (バーナー/リップラインの入力を、キーボードの代わりにオートパイロットが埋めるだけ)
import { createPlayerCar } from './playerCar.js';
import { RECOVERY_RADIUS, groundReportStatus, chasePoints } from './chaseRules.js';
import { createBalloonAutopilot } from './balloonAutopilot.js';
import { carAutopilotControl } from './carAutopilot.js';
import { loadCreativeCarModel } from './creativeCar.js';
import { balloonSoundMix } from './balloonAudio.js';
import { holdButton, bindCarControls } from './touchControls.js';
import { addTeamLabel, updateTeamLabel, separateTeamLabels } from './teamLabels.js';
import { createStoppedCamera } from './stoppedCamera.js';
import { createChaseOverview } from './chaseOverview.js';
import { loadTeamBalloonModel, createTeamBalloon, markTeamBalloon, createCreativeFleet } from './creativeBalloons.js';
import { loadCity, creativeLaunch, CATALOG } from './cityLayout.js';
import { loadCityModels, createCityView, buildingBlocks } from './cityView.js';
import { createTeamPilot, segmentViolation } from './creativeAirspace.js';

// 創作の入口は同じ場所・風・チェイスモードから始める。
// 共有URLの実在世界向け設定が混ざっても、この舞台を移動させない。
const creativeWorld = location.search.length <= FLIGHT_LIMITS.queryLength
  && new URLSearchParams(location.search).get('world') === 'creative';
const savedCity = creativeWorld ? loadCity() : null;
const creativeCity = savedCity?.city;
let creativeCityView = null, creativeAirspace = null;
if (creativeWorld) {
  history.replaceState(null, '', `${location.pathname}?world=creative&mode=chase`);
  document.title = '創作の世界 — 佐賀・嘉瀬川';
  document.body.classList.add('creative-world');
  document.getElementById('world-name').textContent = '創作の世界 · 佐賀・嘉瀬川';
  document.querySelector('#loading .logo').textContent = '創作の世界';
  document.querySelector('#loading .tagline').textContent = '実際の地形から、これからつくる街へ。';
  document.getElementById('creative-note').hidden = false;
  document.getElementById('creative-flight-info').hidden = false;
  document.getElementById('race-overview-help').textContent = '自分の気球と車を見渡す俯瞰';
  document.getElementById('overview-button').hidden = false;
  document.getElementById('race-car-balloon-label').textContent = '1号車→自分のチーム';
}

// ---- 舞台設定 ----
const TILE_RADIUS = 2; // 5x5タイル ≒ 20km四方
let AREA = null;       // { lon, lat, name? } エリア選択またはURLで決まる

// 日本の主な気球競技開催地(エリア選択のプリセット)
const PRESET_AREAS = [
  { name: '佐賀・嘉瀬川', lon: 130.25, lat: 33.27 },
  { name: '渡良瀬遊水地', lon: 139.68, lat: 36.22 },
  { name: '佐久・千曲川', lon: 138.48, lat: 36.25 },
  { name: '一関・平泉', lon: 141.13, lat: 38.93 },
  { name: '上士幌(北海道)', lon: 143.30, lat: 43.23 },
];

// パイバル観測データ。高度ft(MSL) / 風向FROM 磁方位° / 風速kt
const WIND_PRESETS = [
  { name: '佐賀・朝の順転(既定)',
    rows: [[0, 140, 3], [500, 160, 5], [1000, 190, 7], [2000, 220, 10], [3000, 240, 13], [5000, 260, 17]] },
  { name: '逆転(北東→北西)',
    rows: [[0, 40, 4], [500, 20, 6], [1000, 350, 8], [2000, 330, 11], [3000, 310, 14], [5000, 300, 18]] },
  { name: 'ほぼ一定(南風)',
    rows: [[0, 170, 4], [1000, 180, 6], [3000, 185, 9], [5000, 190, 12]] },
  { name: '強風・大きく順転',
    rows: [[0, 120, 6], [500, 150, 9], [1000, 180, 12], [2000, 220, 15], [3000, 250, 18], [5000, 270, 24]] },
];
const toRowObj = ([ft, dir, kt]) => ({ ft, dir, kt });

const flightSettings = parseFlightSettings(creativeWorld ? '' : location.search);
let flightStartTime = flightSettings.startTime;
const shareUrl = () => creativeWorld
  ? `${location.origin}${location.pathname}?world=creative&mode=chase`
  : `${location.origin}${location.pathname}?${buildShareQuery({area: AREA, wind: PIBAL, startTime: flightStartTime})}`;
let PIBAL = flightSettings.wind || WIND_PRESETS[0].rows.map(toRowObj);
const mapBitmap = createTileLoader({ concurrency: 4 });
const KT2MS = 0.514444;
const M2FT = 3.28084;

// JDGターゲットはエリア中央。離陸地点はブリーフィングでプレイヤーが選ぶ
const TARGET_XZ = { x: 0, z: 0 };
const BEST_KEY = 'balloon-jdg-proto-best';
const TASK_LIMIT_S = 30 * 60; // 制限時間(ゲーム内秒)

// マーカー(70g+リボン)の落下特性
const MARKER_TERMINAL = 10;              // 終端速度 m/s
const MARKER_DRAG = 9.81 / MARKER_TERMINAL;
const MARKER_WIND_TAU = 1.5;             // 水平速度が風に馴染む時定数 s

function windDirKtToVec(dir, kt) {
  const toRad = ((dir + 180) * Math.PI) / 180; // FROM → 進行方向
  const ms = kt * KT2MS;
  return { dir, kt, vx: ms * Math.sin(toRad), vz: -ms * Math.cos(toRad) };
}

// パイバル表のみを使った、高度ftに対する風向・風速の補間(気圧配置モデルを使わない場合の基本形)
function pibalInterpDirKt(ft) {
  let a = PIBAL[0], b = PIBAL[PIBAL.length - 1];
  if (ft <= a.ft) b = a;
  else if (ft >= b.ft) a = b;
  else {
    for (let i = 0; i < PIBAL.length - 1; i++) {
      if (ft >= PIBAL[i].ft && ft < PIBAL[i + 1].ft) { a = PIBAL[i]; b = PIBAL[i + 1]; break; }
    }
  }
  const t = a === b ? 0 : (ft - a.ft) / (b.ft - a.ft);
  // 風向は最短の角度経路で補間(例: 350°→020° は北回り)
  const delta = ((b.dir - a.dir + 540) % 360) - 180;
  const dir = (a.dir + delta * t + 360) % 360;
  const kt = a.kt + (b.kt - a.kt) * t;
  return { dir, kt };
}

function windAt(altM) {
  const { dir, kt } = pibalInterpDirKt(altM * M2FT);
  return windDirKtToVec(dir, kt);
}

// ---- three.js セットアップ ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia('(pointer: coarse)').matches ? 1.5 : 2));
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec8e8);
scene.fog = new THREE.Fog(0x9ec8e8, 4000, 16000);

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x54604a, 0.9));
const sun = new THREE.DirectionalLight(0xfff2df, 1.6);
sun.position.set(-3000, 5000, -2000);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 40000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.maxPolarAngle = Math.PI * 0.52;
controls.minDistance = 25;
controls.maxDistance = 600;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// 編みかご風テクスチャ(Canvasで生成。横方向の籐の束を段違いに重ねた見た目)
function buildWickerTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#5d451f';
  ctx.fillRect(0, 0, 128, 128);
  const rowH = 16, segW = 32;
  for (let y = 0, r = 0; y < 128; y += rowH, r++) {
    const off = (r % 2) * (segW / 2);
    for (let x = -segW; x < 128 + segW; x += segW) {
      const grad = ctx.createLinearGradient(0, y, 0, y + rowH);
      grad.addColorStop(0, '#8a6a3c');
      grad.addColorStop(0.45, '#b28a54');
      grad.addColorStop(1, '#6d5127');
      ctx.fillStyle = grad;
      ctx.fillRect(x + off + 1, y + 1, segW - 2, rowH - 2);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ゴア(縦の縫い目パネル)模様のテクスチャ。bright=true は内面用の明るい配色
function buildGoreTexture(bright) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 64;
  const ctx = cv.getContext('2d');
  const gores = 16, w = 512 / gores;
  const cols = bright ? ['#e0584a', '#c94434'] : ['#c62828', '#a81f1f'];
  const seam = bright ? '#a83028' : '#7a1515';
  for (let i = 0; i < gores; i++) {
    ctx.fillStyle = cols[i % 2];
    ctx.fillRect(i * w, 0, w, 64);
    ctx.fillStyle = seam;
    ctx.fillRect(i * w, 0, 2, 64);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 気球(プレースホルダ形状) ----
const BASKET_W = 1.4, BASKET_H = 1.1, WALL_T = 0.06, BURNER_Y = 2.0;
function buildBalloon() {
  const g = new THREE.Group(); // 原点 = バスケット底面(接地点)
  const envMat = new THREE.MeshLambertMaterial({ map: buildGoreTexture(false) });
  const env = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 18), envMat);
  env.scale.set(1, 1.12, 1);
  env.position.y = 16.5;
  g.add(env);
  // 球皮の内面(見上げたときに見える側)。日光が透けた明るい布として自発光風に描く
  const envInnerMat = new THREE.MeshBasicMaterial({
    map: buildGoreTexture(true), side: THREE.BackSide,
  });
  const envInner = new THREE.Mesh(new THREE.SphereGeometry(8.8, 24, 18), envInnerMat);
  envInner.scale.set(1, 1.12, 1);
  envInner.position.y = 16.5;
  g.add(envInner);

  // スカート(球皮の口からバーナー上方へ絞る布)。上端半径3.0は球皮の
  // y=7.0における断面半径と一致させ、継ぎ目が浮かないようにしている
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(3.0, 1.5, 3.2, 20, 1, true),
    new THREE.MeshLambertMaterial({ color: 0xb52a2a, side: THREE.DoubleSide }));
  skirt.position.y = 5.4;
  g.add(skirt);

  // 四角い編みかごのゴンドラ(4面の壁+床。内側からも見えるようDoubleSide)
  const wicker = buildWickerTexture();
  wicker.repeat.set(3, 3);
  const wickerMat = new THREE.MeshLambertMaterial({ map: wicker, side: THREE.DoubleSide });
  const half = BASKET_W / 2 - WALL_T / 2;
  for (const [w, d, x, z] of [
    [BASKET_W, WALL_T, 0, half], [BASKET_W, WALL_T, 0, -half],   // 前後の壁
    [WALL_T, BASKET_W, half, 0], [WALL_T, BASKET_W, -half, 0],   // 左右の壁
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, BASKET_H, d), wickerMat);
    wall.position.set(x, BASKET_H / 2, z);
    g.add(wall);
  }
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(BASKET_W, WALL_T, BASKET_W),
    new THREE.MeshLambertMaterial({ color: 0x4a3620 }));
  floor.position.y = WALL_T / 2;
  g.add(floor);

  // 上縁の革張りリム(4辺の横棒。壁の上面を覆って縞の露出を隠す)
  const rimMat = new THREE.MeshLambertMaterial({ color: 0x3e2b18 });
  for (const [len, rot, x, z] of [
    [BASKET_W + 0.14, 0, 0, half], [BASKET_W + 0.14, 0, 0, -half],
    [BASKET_W + 0.14, Math.PI / 2, half, 0], [BASKET_W + 0.14, Math.PI / 2, -half, 0],
  ]) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, len, 10), rimMat);
    rim.rotation.z = Math.PI / 2;
    rim.rotation.y = rot;
    rim.position.set(x, BASKET_H, z);
    g.add(rim);
  }

  // 四隅の支柱(革巻き風。バスケット上縁→スカート裾まで)+バーナー本体
  const POLE_TOP = 3.9; // スカート裾(y=3.8)に届く高さ
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x5c3a26 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, POLE_TOP - BASKET_H, 6), poleMat);
      pole.position.set(sx * (half - 0.05), (POLE_TOP + BASKET_H) / 2, sz * (half - 0.05));
      g.add(pole);
    }
  }
  const burnerUnit = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.32, 10),
    new THREE.MeshLambertMaterial({ color: 0x555555 }));
  burnerUnit.position.y = BURNER_Y;
  g.add(burnerUnit);

  // リップライン(ゴンドラから気球の口まで伸びる赤いロープ)
  const ropeBaseY = 4.5; // 中心y。長さ5.2でおよそ y=1.9〜7.1
  const rope = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 5.2, 6),
    new THREE.MeshBasicMaterial({ color: 0xd32f2f }));
  rope.position.set(0.3, ropeBaseY, 0.3);
  g.add(rope);

  // バーナー炎(外側オレンジ+芯の黄色の二重コーン)。バーナー上端から上へ吹き上がる。
  // 底面なし(openEnded)にして、ゴンドラから見上げたときも自然に見えるようにする
  const flame = new THREE.Group();
  const flameMatOpts = { transparent: true, side: THREE.DoubleSide };
  const flameOuter = new THREE.Mesh(
    new THREE.ConeGeometry(0.35, 1.8, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8a30, opacity: 0.85, ...flameMatOpts }));
  flame.add(flameOuter);
  const flameCore = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 1.2, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffe082, opacity: 0.95, ...flameMatOpts }));
  flameCore.position.y = -0.25;
  flame.add(flameCore);
  flame.position.y = BURNER_Y + 1.3; // 基部 y≈2.4 からバーナー上方へ吹き上がる
  flame.visible = false;
  g.add(flame);
  const flameLight = new THREE.PointLight(0xffa040, 0, 60);
  flameLight.position.y = BURNER_Y + 1.1;
  g.add(flameLight);
  return { group: g, flame, flameLight, envInnerMat, rope, ropeBaseY };
}

// ---- JDGターゲット(オレンジのX+白リング) ----
function buildTarget(x, z, groundY) {
  const g = new THREE.Group();
  const armMat = new THREE.MeshBasicMaterial({ color: 0xff5a00 });
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(16, 0.2, 2.6), armMat);
    arm.rotation.y = rot;
    g.add(arm);
  }
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(24, 25.5, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  g.position.set(x, groundY + 0.4, z);
  return g;
}

// ---- マーカー(重り+リボン+視認用グロー) ----
function buildMarkerMesh() {
  const g = new THREE.Group();
  const weight = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0xd32f2f }));
  g.add(weight);
  const ribbon = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 4.5),
    new THREE.MeshBasicMaterial({ color: 0xffee58, side: THREE.DoubleSide }));
  ribbon.position.y = 2.6;
  g.add(ribbon);
  // 落下中でも見失わないよう、常にカメラを向く淡い光のスプライトを重ねる
  const spCv = document.createElement('canvas');
  spCv.width = spCv.height = 64;
  const sctx = spCv.getContext('2d');
  const grad = sctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,235,80,0.85)');
  grad.addColorStop(1, 'rgba(255,235,80,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 64, 64);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(spCv), transparent: true, depthWrite: false,
  }));
  glow.scale.set(3, 3, 1);
  g.add(glow);
  return g;
}

// ---- サウンド(Web Audio合成、外部ファイル不要) ----
// ブラウザの自動再生制限があるため、初回のユーザー操作で初期化し、
// suspended のままなら操作のたびに resume する(前回鳴らなかった原因への対処)
let audioCtx = null, burnerGain = null, ripGain = null, windGain = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const noise = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const makeLoop = (type, freq, q) => {
      const src = audioCtx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = audioCtx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0;
      src.connect(filter).connect(gainNode).connect(audioCtx.destination);
      src.start();
      return gainNode;
    };
    burnerGain = makeLoop('bandpass', 600, 0.6);   // バーナーの噴射音(ゴーッ)
    ripGain = makeLoop('bandpass', 2600, 0.9);     // リップラインの排気音(シューッ)
    windGain = makeLoop('lowpass', 380, 0.4);      // 風のアンビエント
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
addEventListener('keydown', ensureAudio);
addEventListener('pointerdown', ensureAudio);

// 毎フレーム呼ばれ、入力状態・風速に音量を追従させる
function updateSounds(windKt) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const bOn = input.burner && state.fuel > 0;
  let levels = { burner: bOn ? 0.4 : 0, rip: input.rip ? 0.25 : 0 };
  if (chaseMode && raceCar) {
    const car = raceCar.info();
    levels = balloonSoundMix([
      { pos: state.pos, burner: bOn, rip: input.rip },
      ...(creativeFleet?.soundSources() ?? []),
    ], { x: car.x, y: car.y + 1.5, z: car.z });
  }
  // 点火状態が同じでも距離は変わるので、毎フレーム滑らかに音量を追従させる。
  burnerGain.gain.setTargetAtTime(paused ? 0 : levels.burner, t, 0.12);
  ripGain.gain.setTargetAtTime(paused ? 0 : levels.rip, t, 0.12);
  windGain.gain.setTargetAtTime(paused ? 0 : THREE.MathUtils.clamp(windKt / 40, 0, 1) * 0.15, t, 0.4);
}

// ---- 入力 ----
const input = { burner: false, rip: false };
let resetRaceControls = null;
let timeScale = 1;
let fpv = false;
let flightReady = false; // 離陸前のキー入力を無視する
let started = false;     // 離陸済みかどうか(物理・時計は離陸後のみ進む)
let remaining = TASK_LIMIT_S;
let expired = false;
// 一時停止(#pause-btn)。dt を 0 にするだけで、シミュレーション(気球物理・車・マーカー落下・
// 制限時間)を止める。playerCar.js/chasecar.js は update(dt=0, ...) で早期リターンするので、
// 個別に「動きを止める」処理を足す必要はない。カメラ追従もその場に止まる(追う先の位置が
// 変わらないため、結果として静止する)
let paused = false;

// 一人称視点(ゴンドラ視点)。目の位置は固定し、視線方向だけをドラッグで回す
let fpvYaw = 0, fpvPitch = 0;
//   'balloon' … 気球を見る(クルーの見方)。車が曲がっても気球を見続ける
//   'forward' … 進行方向を見る(運転席の見方)。道路の繋がりや経路の選び方が分かる
// どちらもドラッグ量はその基準からの相対角なので、ずらして見回せる
let carView = false;
let carAim = 'balloon';
// どの車の中から見ているか(0:1号車 / 1:2号車)。2号車は「気球を見る」だけを足す
// (到着後は動かないので「進行方向」に価値がほとんど無い)
let carIndex = 0;
let carYaw = 0, carPitch = 0;
const viewCar = () => (carIndex === 0 ? chaseCar : chaseCar2);
// 目の高さは**車の床から**測る(車は道路の描画面 1.5m の上に乗っているので、
// 地面から測ると座席がその分だけ低くなる)
const CAR_EYE_ABOVE_FLOOR = 0.9;
// V(ゴンドラ/車内)とは層が違う操作なので、V の循環は長くならない。
// OrbitControls はそのまま使い、controls.target の行き先だけを差し替える
let orbitCar = null;                  // null なら気球を回る(既定)
const CAR_ORBIT_LIFT = 0.7;           // 回る中心の高さ(車の床から車体の真ん中まで)
const prevOrbitPos = new THREE.Vector3();
let hasPrevOrbitPos = false;
const EYE_HEIGHT = 1.85;
const LOOK_SPEED = 0.0038;
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);
const look = { dragging: false, lastX: 0, lastY: 0 };

// 視点は 外部 → ゴンドラ → 1号車内(気球)→ 1号車内(進行方向)→ 2号車(気球)→ 外部
// 既定モードの V は今までどおり「ゴンドラ/外部」の2択のまま。
// **5つが上限**と考えている(これ以上増やすなら別操作に分ける)
function toggleFpv() {
  if (!started) return;
  if (fpv) {
    fpv = false;
    if (chaseCar) { carView = true; carIndex = 0; carAim = 'balloon'; applyViewMode(); return; }
  } else if (carView && carIndex === 0 && carAim === 'balloon') {
    carAim = 'forward';          // 同じ車内で、見る向きだけを進行方向に切り替える
    applyViewMode();
    return;
  } else if (carView && carIndex === 0 && chaseCar2) {
    carIndex = 1;                // 2号車へ。こちらは「気球を見る」だけ
    carAim = 'balloon';
    applyViewMode();
    return;
  } else if (carView) {
    carView = false;
    carIndex = 0;
  } else {
    fpv = true;
  }
  applyViewMode();
  // 車を回っているときは、外部視点の位置決めは下の orbit 側に任せる
  if (!fpv && !carView && !orbitCar) {
    // ゴンドラ/チェイスカー視点から戻るときは、見ていた方向の後方に回り込む
    const horiz = new THREE.Vector3(Math.sin(fpvYaw), 0, -Math.cos(fpvYaw));
    const tgt = new THREE.Vector3(state.pos.x, state.pos.y + 12, state.pos.z);
    camera.position.copy(tgt).addScaledVector(horiz, -90).add(new THREE.Vector3(0, 35, 0));
    controls.target.copy(tgt);
  }
}

// Shift+V: 外部視点で回る対象を 気球 → 1号車(→ 2号車…)→ 気球 と巡回する。
// 車が増えてもこの配列に足すだけで済む
const orbitCars = () => [chaseCar, chaseCar2].filter(Boolean);
function cycleOrbitTarget() {
  const cars = orbitCars();
  if (cars.length === 0) return;                 // 車がいなければ何も起きない
  const i = orbitCar ? cars.indexOf(orbitCar) : -1;
  orbitCar = i + 1 < cars.length ? cars[i + 1] : null;
  hasPrevOrbitPos = false;

  // 車を回るときは外部視点に出る(ゴンドラ・車内のままでは切り替えが見えない)
  fpv = false;
  carView = false;
  applyViewMode();

  if (orbitCar) {
    // 車の斜め後ろに置く。実物大(4.4m)なので、気球のときより ずっと近くから見る
    const c = orbitCar.info();
    const head = (c.headingDeg * Math.PI) / 180;
    const tgt = new THREE.Vector3(c.x, c.y + CAR_ORBIT_LIFT, c.z);
    camera.position.set(
      tgt.x - Math.sin(head) * 16 + Math.cos(head) * 6,
      tgt.y + 7,
      tgt.z + Math.cos(head) * 16 + Math.sin(head) * 6,
    );
    controls.target.copy(tgt);
  } else {
    const tgt = new THREE.Vector3(state.pos.x, state.pos.y + 12, state.pos.z);
    camera.position.copy(tgt).add(new THREE.Vector3(60, 35, 60));
    controls.target.copy(tgt);
  }
}
function togglePibal() {
  const p = document.getElementById('pibal');
  p.style.display = p.style.display === 'none' ? '' : 'none';
}
function cycleTimeScale() {
  const seq = [1, 2, 4, 8];
  timeScale = seq[(seq.indexOf(timeScale) + 1) % seq.length];
  document.getElementById('tscale').textContent = timeScale;
  const btn = document.getElementById('tc-tscale');
  if (btn) btn.textContent = `×${timeScale}`;
}
function togglePause() {
  paused = !paused;
  resetRaceControls?.();
  const btn = document.getElementById('pause-btn');
  btn.textContent = paused ? '▶ 再開' : '⏸ 一時停止';
  btn.classList.toggle('active', paused);
}
document.getElementById('pause-btn').addEventListener('click', togglePause);

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.code === 'Space' && !chaseMode) { input.burner = true; e.preventDefault(); }
  if (e.code === 'KeyR' && !chaseMode) input.rip = true;
  // **?mode=chase では V/Shift+V は別のキーハンドラ(下)に譲る**(気球ではなく車を見る操作のため)
  if (e.code === 'KeyV' && !chaseMode) { if (e.shiftKey) cycleOrbitTarget(); else toggleFpv(); }
  // C は Crew / Chase。無線は**問い合わせ形式**で、開いている間だけ報告が出る
  // Shift+C は隠しコマンド: 開発用の状態表示(距離・速度・幅員区分・残り区間)。
  // V / Shift+V と同じ層の分け方 — C は無線、Shift+C は「その裏の数字」
  if (e.code === 'KeyC' && chaseMode && !e.repeat) sendGroundReport();
  if (e.code === 'KeyM' && flightReady && !chaseMode) dropMarker();
  if (e.code === 'KeyP') togglePibal();
  if (e.code >= 'Digit1' && e.code <= 'Digit4') {
    timeScale = [1, 2, 4, 8][Number(e.code.slice(5)) - 1];
    document.getElementById('tscale').textContent = timeScale;
    const btn = document.getElementById('tc-tscale');
    if (btn) btn.textContent = `×${timeScale}`;
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') input.burner = false;
  if (e.code === 'KeyR') input.rip = false;
});

// ?mode=chase 専用のキー操作(W/S/A/D または矢印キーで車を運転、V で追走視点を切替)。
// chaseMode でなければ何も起きない
addEventListener('keydown', (e) => {
  if (!chaseMode) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (e.code === 'KeyV' && !e.repeat) toggleRaceView();
  if ((e.code === 'KeyO' || e.code === 'KeyB') && !e.repeat) { e.preventDefault(); toggleRaceOverview(); }
});

// ---- タッチ操作ボタン(スマホ・タブレットなどタッチ端末向け) ----
// 地形の読み込み待ちでも toggle が発生するため、イベント登録前に初期化する。
let cityStatusEl = null;   // 街並みの読み込み状態(8秒後に DOM から取り除く)
let roadStatusEl = null;   // 道路・チェイスカーの状態表示(隠しコマンド Shift+C)
let radioEl = null;        // 無線パネル(C)。第3段階の報告

const isTouchDevice = matchMedia('(hover: none) and (pointer: coarse)').matches;
if (isTouchDevice) {
  document.getElementById('pibal').style.display = 'none'; // 初期状態は隠して画面を広く使う
} else {
  // PCでは折りたたみパネルを開いたまま表示(スマホでは省スペースのため閉じておく)
  document.getElementById('instruments').open = true;
  document.getElementById('credit').open = true;
  // キー説明は**既定モードでは開いたまま**にする(初めての人が最初に読むもの)。
  // ここでは URL を直接読む。参照すると画面が真っ暗になる
  document.getElementById('help-keys').open = true;
}
// キー説明をたたむと #help の高さが変わる。その上に載せているチェイスカーの状態表示・無線を置き直す
function setupTouchControls() {
  holdButton(document.getElementById('tc-burner'),
    () => { input.burner = true; }, () => { input.burner = false; });
  holdButton(document.getElementById('tc-rip'),
    () => { input.rip = true; }, () => { input.rip = false; });
  document.getElementById('tc-marker').addEventListener('click', () => {
    if (flightReady) dropMarker();
  });
  document.getElementById('tc-view').addEventListener('click', () => {
    if (chaseMode) toggleRaceView(); else toggleFpv();
  });
  document.getElementById('tc-overview').addEventListener('click', toggleRaceOverview);
  document.getElementById('tc-tscale').addEventListener('click', cycleTimeScale);
  document.getElementById('tc-pibal').addEventListener('click', togglePibal);
  document.getElementById('overview-button').addEventListener('click', toggleRaceOverview);
}
setupTouchControls();

// ゴンドラ視点でのルック操作(ドラッグで視線方向を回転。目の位置は動かさない)
// pointerイベントなのでマウスでもタッチでも同じコードで動く
renderer.domElement.addEventListener('pointerdown', (e) => {
  if ((!fpv && !carView) || !started) return;
  renderer.domElement.setPointerCapture(e.pointerId);
  look.dragging = true;
  look.lastX = e.clientX;
  look.lastY = e.clientY;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!look.dragging) return;
  const dx = e.clientX - look.lastX, dy = e.clientY - look.lastY;
  look.lastX = e.clientX;
  look.lastY = e.clientY;
  if (carView) {
    carYaw -= dx * LOOK_SPEED;
    carPitch = THREE.MathUtils.clamp(carPitch - dy * LOOK_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
    return;
  }
  fpvYaw -= dx * LOOK_SPEED;
  fpvPitch = THREE.MathUtils.clamp(fpvPitch - dy * LOOK_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
});
renderer.domElement.addEventListener('pointerup', () => { look.dragging = false; });
renderer.domElement.addEventListener('pointercancel', () => { look.dragging = false; });

function applyViewMode() {
  if (fpv) {
    // 現在の視線方向を引き継いでゴンドラ視点に入る(切り替え時の違和感を減らす)
    const dir = new THREE.Vector3().subVectors(controls.target, camera.position).normalize();
    fpvYaw = Math.atan2(dir.x, -dir.z);
    fpvPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    controls.enabled = false;
  } else if (carView) {
    // 入るとき・見る向きを変えるときは、その基準を正面に置く(相対角を0に戻す)
    carYaw = 0;
    carPitch = 0;
    controls.enabled = false;
  } else {
    controls.enabled = true;
  }
  // 車内にいる間は**その車の**車体を描かない(目の前が箱で塞がるため)。
  // もう1台は外にいるので描いたままにする
  for (const c of orbitCars()) {
    c.group.visible = !(carView && c === viewCar());
    // 上空から車を探すための60mの柱は、車のそばで回すと画面を貫く。外から見る間は消す
    c.setMarkVisible(!orbitCar);
  }

  // 車を回るときは寄れるようにする。既定の 25m は実物大(4.4m)の車には遠すぎる。
  // 併せて、地面より下へ回り込まないよう仰角の下限も水平より上に留める
  if (orbitCar) {
    controls.minDistance = 6;
    controls.maxDistance = 300;
    controls.maxPolarAngle = Math.PI * 0.48;
  } else {
    controls.minDistance = 25;
    controls.maxDistance = 600;
    controls.maxPolarAngle = Math.PI * 0.52;
  }

  // 気球を見るときだけ画角を絞る。1〜2km先にあることも多く、既定の60°では点にしかならない
  // (「目を凝らして見ている」ぶんだけで、双眼鏡ほどには寄せない)。
  // 進行方向を見るときは、運転席らしい見え方のまま 60° にしておく
  const wantFov = carView && carAim === 'balloon' ? 35 : 60;
  if (camera.fov !== wantFov) {
    camera.fov = wantFov;
    camera.updateProjectionMatrix();
  }
}

// ---- 飛行中HUDのパイバル表を描画 ----
function renderFlightPibal() {
  document.getElementById('pibal-body').innerHTML = PIBAL
    .map((r) => `<tr><td>${r.ft}</td><td>${String(Math.round(r.dir)).padStart(3, '0')}</td><td>${r.kt}</td></tr>`)
    .join('');
}
renderFlightPibal();

// ---- 「使い方」「本格モード」オーバーレイ(リンク付きの簡易情報パネル) ----
function setupLinkOverlay(linkId, overlayId, closeBtnId) {
  const link = document.getElementById(linkId);
  const overlay = document.getElementById(overlayId);
  const closeBtn = document.getElementById(closeBtnId);
  link.addEventListener('click', (e) => {
    e.preventDefault();
    overlay.style.display = '';
  });
  closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') overlay.style.display = 'none';
  });
}
setupLinkOverlay('howto-link', 'howto-overlay', 'howto-close');
// ---- エリア選択画面(日本全図のスリッピーマップ+プリセット) ----
function selectArea() {
  return new Promise((resolve) => {
    const el = document.getElementById('areasel');
    const btn = document.getElementById('area-btn');
    el.style.display = '';
    let sel = null;

    const map = setupAreaMap(document.getElementById('area-map'), (lon, lat, name) => {
      sel = { lon, lat, name };
      btn.disabled = false;
      btn.textContent = `このエリアで飛ぶ(${name || `${lat.toFixed(3)}N, ${lon.toFixed(3)}E`})`;
    });

    const presetBox = document.getElementById('area-presets');
    presetBox.innerHTML = PRESET_AREAS
      .map((p, i) => `<button type="button" data-i="${i}">${p.name}</button>`)
      .join('');
    presetBox.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const p = PRESET_AREAS[Number(b.dataset.i)];
      map.jumpTo(p.lon, p.lat);
      map.select(p.lon, p.lat, p.name);
    });

    btn.addEventListener('click', () => {
      if (!sel) return;
      el.style.display = 'none';
      resolve(sel);
    });
  });
}

// マウスとタッチを共通で扱うためのヘルパー。
// 1本指ドラッグ=パン、動かず離す=タップ選択、2本指ピンチ=ズーム。
// (マウスのホイールズームは呼び出し側で別途 'wheel' を扱う)
function enablePointerNav(cv, cssRatio, { onPanStart, onPan, onTap, onZoom }) {
  const pointers = new Map();
  let mode = null; // 'pan' | 'pinch'
  let dragStart = null;
  let pinchDist = 0;

  function rectOffset(clientX, clientY) {
    const r = cv.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  }

  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      mode = 'pan';
      dragStart = { cx: e.clientX, cy: e.clientY, moved: false };
      onPanStart();
    } else if (pointers.size === 2) {
      mode = 'pinch';
      const [p1, p2] = [...pointers.values()];
      pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pan' && pointers.size === 1) {
      const dx = (e.clientX - dragStart.cx) * cssRatio();
      const dy = (e.clientY - dragStart.cy) * cssRatio();
      if (Math.abs(dx) + Math.abs(dy) > 6) dragStart.moved = true;
      if (dragStart.moved) onPan(dx, dy);
    } else if (mode === 'pinch' && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchDist > 0 && (dist / pinchDist > 1.15 || dist / pinchDist < 0.87)) {
        const [ox, oy] = rectOffset((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
        onZoom(ox, oy, dist > pinchDist ? 1 : -1);
        pinchDist = dist;
      }
    }
  });
  function end(e) {
    if (pointers.has(e.pointerId)) {
      if (mode === 'pan' && pointers.size === 1 && !dragStart.moved) {
        onTap(...rectOffset(e.clientX, e.clientY));
      }
      pointers.delete(e.pointerId);
    }
    if (pointers.size === 0) {
      mode = null; dragStart = null;
    } else if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      mode = 'pan';
      dragStart = { cx: p.x, cy: p.y, moved: true }; // 2本指→1本指の切替時は誤タップを防ぐ
    }
  }
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

function setupAreaMap(cv, onSelect) {
  const ctx = cv.getContext('2d');
  let z = 5;
  let c = lonLatToTile(137.0, 38.0, z); // 日本全体が入る初期ビュー
  let sel = null;

  const tiles = new Map();
  function getTile(zz, tx, ty) {
    const key = `${zz}/${tx}/${ty}`;
    const v = tiles.get(key);
    if (v) return v instanceof ImageBitmap ? v : null;
    if (tiles.size >= 160) {
      for (const [oldKey, oldTile] of tiles) {
        if (oldTile === 'loading') continue;
        oldTile?.close?.(); tiles.delete(oldKey); break;
      }
      if (tiles.size >= 160) return null;
    }
    tiles.set(key, 'loading');
    mapBitmap(`https://cyberjapandata.gsi.go.jp/xyz/std/${zz}/${tx}/${ty}.png`)
      .then((bmp) => { tiles.set(key, bmp); render(); })
      .catch(() => tiles.set(key, 'error'));
    return null;
  }

  const cssRatio = () => cv.width / cv.clientWidth;
  const toScreen = (tx, ty) => [(tx - c.x) * 256 + cv.width / 2, (ty - c.y) * 256 + cv.height / 2];
  const toTile = (sx, sy) => [(sx - cv.width / 2) / 256 + c.x, (sy - cv.height / 2) / 256 + c.y];
  const tileToLonLat = (tx, ty) => [
    (tx / 2 ** z) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI,
  ];

  function render() {
    ctx.fillStyle = '#0d1620';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const n = 2 ** z;
    const [txL, tyT] = toTile(0, 0);
    const [txR, tyB] = toTile(cv.width, cv.height);
    for (let ty = Math.max(0, Math.floor(tyT)); ty <= Math.min(n - 1, Math.floor(tyB)); ty++) {
      for (let tx = Math.max(0, Math.floor(txL)); tx <= Math.min(n - 1, Math.floor(txR)); tx++) {
        const bmp = getTile(z, tx, ty);
        if (!bmp) continue;
        const [sx, sy] = toScreen(tx, ty);
        ctx.drawImage(bmp, sx, sy, 256.5, 256.5);
      }
    }
    if (sel) {
      const t = lonLatToTile(sel.lon, sel.lat, z);
      const [sx, sy] = toScreen(t.x, t.y);
      // この緯度・ズームでの1画面ピクセルあたりの実距離から20km枠を描く
      const mpp = (156543.03392 * Math.cos((sel.lat * Math.PI) / 180)) / 2 ** z;
      const box = 20460 / mpp;
      ctx.strokeStyle = '#ff5a00';
      ctx.lineWidth = 3;
      ctx.strokeRect(sx - box / 2, sy - box / 2, box, box);
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy);
      ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8);
      ctx.stroke();
    }
  }

  function zoomAt(ox, oy, dir) {
    const nz = THREE.MathUtils.clamp(z + dir, 4, 16);
    if (nz === z) return;
    const r = cssRatio();
    const [fx, fy] = toTile(ox * r, oy * r);
    const k = 2 ** (nz - z);
    z = nz;
    c = {
      x: fx * k - (ox * r - cv.width / 2) / 256,
      y: fy * k - (oy * r - cv.height / 2) / 256,
    };
    render();
  }
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  let panOrigin = null;
  enablePointerNav(cv, cssRatio, {
    onPanStart: () => { panOrigin = { x: c.x, y: c.y }; },
    onPan: (dx, dy) => {
      c = { x: panOrigin.x - dx / 256, y: panOrigin.y - dy / 256 };
      render();
    },
    onTap: (ox, oy) => {
      const r = cssRatio();
      const [fx, fy] = toTile(ox * r, oy * r);
      const [lon, lat] = tileToLonLat(fx, fy);
      select(lon, lat, null);
    },
    onZoom: zoomAt,
  });

  function select(lon, lat, name) {
    sel = { lon, lat, name };
    render();
    onSelect(lon, lat, name);
  }
  function jumpTo(lon, lat, zz) {
    z = zz || 10;
    c = lonLatToTile(lon, lat, z);
    render();
  }
  render();
  return { select, jumpTo };
}

// Public real-data flights always start with preparation. Experimental URL flags are not supported.
const setupMode = !creativeWorld;
const chaseMode = creativeWorld;
const chaseCar = null, chaseCar2 = null;

// ---- ?mode=chase 専用の状態 ----
// フェーズ1デモ(chase/)と同じ2モジュールを使う: balloonAutopilot.js が気球を自動操縦し、
// playerCar.js の自由走行車をプレイヤーが操縦する。**車は離陸地点が決まってから作る**
// (離陸前の座標はまだ無いので、chasecar.js の地上クルーと同じ理由で startFlight から呼ぶ)
let raceCar = null;              // createPlayerCar() の戻り値
let raceAutopilot = null;        // createBalloonAutopilot() の戻り値
let creativeFleet = null;       // 創作の世界だけに追加する、周囲の5機
const raceCarInput = { throttle: 0, steer: 0 };
// 2号車・3号車(参考動作、捕獲判定には関与しない)。carAutopilot.js の単純な追尾で動く。
// 2号車: ターゲット手前で待機(chasecar.js 本体の2号車と同じ standoffM=100 に合わせる)
// 3号車: 気球の直下を常に追いかける
let raceCar2 = null, raceCar3 = null;
const RACE_CAR2_STANDOFF_M = 100;
// GameTargetと同じ2視点。位置は車の後方で、Vで見る方向だけ切り替える。
let raceViewMode = 'forward'; // 'forward' / 'balloon'
let raceStoppedCamera = null;
let raceOverviewCamera = null;
const RACE_CHASE_BACK_M = 14;
const RACE_CHASE_UP_M = 6;
// 気球と車の両方を見下ろす俯瞰(O キー、旧Bも有効)。Vとは別枠のオン・オフで、
// **気球が高く上がって画面から見失う**問題への対策(2026-09-06)。
// 距離は2体の間隔に応じて自動で伸ばすので、離れるほどカメラも引く
let raceOverview = false;
const chaseRace = { finished: false, reported: false, caught: false, afterLanding: false, landingDistance: null };
const chaseRadioLog = [];
let chaseToastTimer = null;
const CHASE_BEST_KEY = 'chase-marker-score-best-v1'; // 通常モードの自己ベスト(BEST_KEY)とは別に持つ
if (chaseMode) {
  raceAutopilot = createBalloonAutopilot({ windAt, targetX: TARGET_XZ.x, targetZ: TARGET_XZ.z });
}
// **chaseMode が確定した直後、かつ DOM 操作の対象(help-keys.open 等)が
// 既に決まったあとに呼ぶこと。**これより前で呼ぶと chaseMode の TDZ(初期化前アクセス)で
// 画面が真っ暗になる(2026-09-15に発覚。教訓として明示しておく)
applyRaceHudMode();
AREA = creativeWorld ? PRESET_AREAS[0] : (flightSettings.area || await selectArea());

const loadingEl = document.getElementById('loading');
document.getElementById('load-title').textContent =
  `${AREA.name || `${AREA.lat.toFixed(3)}N ${AREA.lon.toFixed(3)}E`} の地形を読み込み中…`;
loadingEl.style.display = '';

const loadEl = document.getElementById('load-progress');
const [terrain, creativeCarModel, teamBalloonModel, cityModels] = await Promise.all([
  buildTerrain(AREA.lon, AREA.lat, TILE_RADIUS,
    (done, total) => { loadEl.textContent = `${done} / ${total}`; },
    { imagery: !creativeWorld, lowMemory: isTouchDevice, maxTextureSize: renderer.capabilities.maxTextureSize,
      onStatus: ({ missingDem, missingPhotos }) => {
        document.getElementById('terrain-error').hidden = !missingDem && !missingPhotos;
        document.getElementById('terrain-error-text').textContent =
          `地形データの一部を取得できませんでした（標高${missingDem}枚・写真${missingPhotos}枚）。未取得部分は簡易表示です。通信が戻ってから再読み込みできます。`;
      } }),
  creativeWorld ? loadCreativeCarModel().catch((error) => {
    console.warn('創作の車両モデルを読み込めませんでした:', error);
    document.getElementById('car-model-error').hidden = false;
    return null; // 通信に失敗しても従来の車体で操作を続けられる
  }) : null,
  creativeWorld ? loadTeamBalloonModel().catch((error) => {
    console.warn('チームの気球モデルを読み込めませんでした:', error);
    document.getElementById('balloon-model-error').hidden = false;
    return null;
  }) : null,
  creativeWorld ? loadCityModels(message => {
    document.getElementById('city-load-warning').textContent = message;
  }) : null,
]);
scene.add(terrain.group);
if (creativeWorld) {
  creativeCityView = createCityView(creativeCity, terrain.getHeight, cityModels);
  creativeCityView.pzGroup.visible = false;
  scene.add(creativeCityView.group);
  creativeAirspace = { ceiling: creativeCity.ceiling, zones: creativeCityView.zones };
  raceAutopilot = createTeamPilot({ windAt, airspace: creativeAirspace,
    getHeight: terrain.getHeight, onRadio: chaseRadio });
  document.getElementById('creative-airspace').hidden = false;
  document.getElementById('creative-altitude').textContent =
    `最高高度：海抜 ${creativeCity.ceiling}m / ${Math.round(creativeCity.ceiling*M2FT)}ft（気球の上端まで）`;
  if (savedCity.warning) document.getElementById('city-load-warning').textContent = savedCity.warning;
  document.getElementById('creative-zone-list').textContent = creativeAirspace.zones.map(z =>
    `${z.name}：${z.type==='yellow'?'離着陸禁止':`${Math.round(z.altitude)}m MSL ${z.type==='red'?'未満を禁止':'超を禁止'}`}`).join(' ／ ');
}
loadingEl.remove();

// ---- ブリーフィング(タスクシート+パイバル編集+離陸地点選択) ----
// setupMode のときだけ構築する(既定モードでは風は既定値/URL指定のまま使う)
if (setupMode) setupWindEditor();
function spawnRaceCar(x, z) {
  if (!chaseMode || raceCar) return;
  const tm = terrain.map;
  const bounds = {
    minX: tm.minX, minZ: tm.minZ,
    maxX: tm.minX + tm.n * terrain.tileMeters,
    maxZ: tm.minZ + tm.n * terrain.tileMeters,
  };
  raceCar = createPlayerCar({
    // Park beside the balloon so its basket does not overlap the car at takeoff.
    getHeight: terrain.getHeight,
    startX: x + (creativeWorld ? 18*Math.cos(25*Math.PI/180) : 0),
    startZ: z + (creativeWorld ? 18*Math.sin(25*Math.PI/180) : 0), bounds,
    bodyColor: 0xffb300, markColor: 0x00e5ff,
    bodyModel: creativeCarModel,
    headingDeg: creativeWorld ? 25 : 0,
    isBlocked: creativeWorld ? (x,z) => buildingBlocks(creativeCity,x,z) : null,
  });
  scene.add(raceCar.group);
  // 上空から見つけるための60mの柱は、自分で操縦している車には要らないので消しておく
  raceCar.setMarkVisible(false);
  if (creativeWorld) {
    addTeamLabel(raceCar.group, { text: '車', color: '#ffd166', name: 'team-car-label', width: 28 });
  }
  raceStoppedCamera = createStoppedCamera({ camera, element: renderer.domElement,
    canMove: () => started && !raceOverview && Math.abs(raceCar.info().speedMps) <= 0.05,
    render: () => renderer.render(scene, camera) });
  raceOverviewCamera = createChaseOverview({ camera, element: renderer.domElement,
    getHeight: terrain.getHeight, isActive: () => raceOverview });
  updateRaceControlsEnabled();
  placeRaceFollowCamera();

  // 2号車・3号車(参考動作)。1号車と重ならないよう、出発点を少しずらす。
  // **視点には関与しない**(V/B は1号車と気球だけを見る、今の実装のまま)
  raceCar2 = createPlayerCar({
    getHeight: terrain.getHeight, startX: x + 60, startZ: z, bounds,
    bodyColor: 0x2f5f9e, markColor: 0x5ad0ff, // chasecar.js 本体の2号車と同じ配色(濃い青)
  });
  scene.add(raceCar2.group);
  raceCar3 = createPlayerCar({
    getHeight: terrain.getHeight, startX: x - 40, startZ: z + 40, bounds,
    bodyColor: 0xf0f0f0, markColor: 0xffd24a, // chasecar.js 本体の1号車(ハイエース型)と同じ配色
  });
  scene.add(raceCar3.group);
}

// GameTargetと同じ車の後方14m・高さ6m。地面へ潜らないよう高さを補正する。
function placeRaceFollowCamera() {
  if (!raceCar) return;
  const c = raceCar.info();
  const head = (c.headingDeg * Math.PI) / 180;
  const x = c.x - Math.sin(head) * RACE_CHASE_BACK_M;
  const z = c.z + Math.cos(head) * RACE_CHASE_BACK_M;
  camera.position.set(x, Math.max(c.y + RACE_CHASE_UP_M, terrain.getHeight(x, z) + 3), z);
  if (raceViewMode === 'balloon') camera.lookAt(state.pos.x, state.pos.y + 12, state.pos.z);
  else camera.lookAt(c.x, c.y + 1, c.z);
}
function toggleRaceView() {
  if (!started || !raceCar) return;
  raceOverview = false;
  raceStoppedCamera?.reset();
  raceOverviewCamera?.reset();
  raceViewMode = raceViewMode === 'forward' ? 'balloon' : 'forward';
  updateRaceControlsEnabled();
  placeRaceFollowCamera();
}
// O(旧Bも可)で俯瞰を切り替え、戻るときは以前の見る方向を保つ。
function toggleRaceOverview() {
  if (!started || !raceCar) return;
  raceOverview = !raceOverview;
  raceStoppedCamera?.reset();
  raceOverviewCamera?.reset();
  updateRaceControlsEnabled();
  if (!raceOverview) placeRaceFollowCamera();
  else raceOverviewCamera?.update(state.pos, raceCar.info());
}
// 画面のボタンと、俯瞰だけに出す名札を同期する。
function updateRaceControlsEnabled() {
  controls.enabled = false; // 停車中の見回しは位置固定の専用カメラで行う。
  const touchOverview = document.getElementById('tc-overview');
  touchOverview.setAttribute('aria-pressed', String(raceOverview));
  touchOverview.textContent = raceOverview ? '運転へ' : '俯瞰';
  const viewButton = document.getElementById('tc-view');
  viewButton.textContent = raceViewMode === 'forward' ? '気球へ' : '前方へ';
  viewButton.setAttribute('aria-label', raceViewMode === 'forward' ? '気球を見る' : '進行方向を見る');
  updateCreativeTeamLabels();
  if (creativeWorld) {
    const button = document.getElementById('overview-button');
    button.textContent = raceOverview ? '運転に戻る(O)' : '自分のチームを俯瞰(O)';
    button.setAttribute('aria-pressed', String(raceOverview));
  }
}

function updateCreativeTeamLabels() {
  if (!creativeWorld) return;
  const balloonLabel = scene.getObjectByName('team-balloon-label');
  const carLabel = scene.getObjectByName('team-car-label');
  for (const label of [balloonLabel, carLabel]) {
    if (!label) continue;
    label.visible = raceOverview;
    const leader = label.parent.getObjectByName(`${label.name}-leader`);
    if (leader) leader.visible = false;
    if (raceOverview) updateTeamLabel(label, camera, innerHeight);
  }
  if (raceOverview) separateTeamLabels(balloonLabel, carLabel, camera, innerWidth, innerHeight);
}

// 距離の表し方(1km未満はm)。状態表示と無線報告で同じ言い方にする
const distText = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(2)}km`);

function setupWindEditor() {
  const sel = document.getElementById('wind-preset');
  sel.innerHTML = WIND_PRESETS
    .map((p, i) => `<option value="${i}">${p.name}</option>`)
    .join('') + '<option value="custom">カスタム</option>';
  if (flightSettings.wind) sel.value = 'custom';
  renderEditorRows(PIBAL);

  sel.addEventListener('change', () => {
    if (sel.value === 'custom') return;
    renderEditorRows(WIND_PRESETS[Number(sel.value)].rows.map(toRowObj));
  });
  document.getElementById('wind-add').addEventListener('click', () => {
    const rows = readEditorRows();
    if (!rows || rows.length >= FLIGHT_LIMITS.windRows) return;
    const last = rows[rows.length - 1];
    rows.push(last ? { ft: Math.min(FLIGHT_LIMITS.altitudeFt, last.ft + 1000), dir: last.dir, kt: last.kt } : { ft: 0, dir: 180, kt: 5 });
    renderEditorRows(rows);
    sel.value = 'custom';
  });
  const editor = document.getElementById('wind-editor');
  editor.addEventListener('input', () => { sel.value = 'custom'; });
  editor.addEventListener('click', (e) => {
    if (!e.target.classList.contains('del')) return;
    if (editor.querySelectorAll('tr').length <= 1) return; // 最低1行は残す
    e.target.closest('tr').remove();
    sel.value = 'custom';
  });
  document.getElementById('wind-copy').addEventListener('click', (e) => {
    if (applyWindFromEditor()) copyShare(e.target);
  });
}

function renderEditorRows(rows) {
  document.getElementById('wind-editor').innerHTML = rows.map((r) =>
    `<tr><td><input type="number" class="w-ft" step="100" min="0" value="${r.ft}"></td>` +
    `<td><input type="number" class="w-dir" step="10" min="0" max="360" value="${r.dir}"></td>` +
    `<td><input type="number" class="w-kt" step="1" min="0" value="${r.kt}"></td>` +
    `<td><button type="button" class="del" title="行を削除">×</button></td></tr>`).join('');
}

function readEditorRows() {
  return validateWind([...document.querySelectorAll('#wind-editor tr')].map(tr => ({
    ft: tr.querySelector('.w-ft').valueAsNumber,
    dir: tr.querySelector('.w-dir').valueAsNumber,
    kt: tr.querySelector('.w-kt').valueAsNumber,
  })));
}

function applyWindFromEditor() {
  const rows = readEditorRows();
  const time = document.getElementById('flight-time').value;
  const warning = document.getElementById('flight-settings-warning');
  if (!rows || !validStartTime(time)) {
    warning.textContent = '開始時刻と風を確認してください。高度0〜30000ft、風向0〜360度、風速0〜150kt、最大32行です。高度の重複は使えません。';
    return false;
  }
  warning.textContent = '';
  PIBAL = rows;
  flightStartTime = time;
  renderFlightPibal();
  history.replaceState(null, '', shareUrl());
  return true;
}

function copyShare(btn) {
  const orig = btn.textContent;
  navigator.clipboard.writeText(shareUrl())
    .then(() => { btn.textContent = 'コピーしました!'; })
    .catch(() => { btn.textContent = 'コピー失敗'; })
    .finally(() => setTimeout(() => { btn.textContent = orig; }, 1600));
}

document.getElementById('result-share').addEventListener('click', (e) => copyShare(e.target));

const launchSel = { x: null, z: null };
if (setupMode) {
  setupLaunchMap();
  document.getElementById('briefing').style.display = '';
  document.getElementById('briefing-title').textContent = 'フライト準備';
  document.getElementById('selected-area').textContent = AREA.name || `${AREA.lat.toFixed(3)}N, ${AREA.lon.toFixed(3)}E`;
  document.getElementById('flight-time').value = flightStartTime;
  document.getElementById('flight-settings-warning').textContent = flightSettings.errors.join(' ');
}

// ブリーフィング地図: ズーム(ホイール)+パン(ドラッグ)可能な簡易スリッピーマップ。
// ズームに応じて標準地図タイルを z11〜z17 から選んで表示する
function setupLaunchMap() {
  const cv = document.getElementById('launch-map');
  const ctx = cv.getContext('2d');
  const M = terrain.map;
  const tm13 = terrain.tileMeters;            // z13タイルの一辺(m)
  const c13x = M.x0 - M.minX / tm13;          // 世界原点のz13タイル座標
  const c13y = M.y0 - M.minZ / tm13;
  const fitScale = cv.width / terrain.sizeMeters; // 全域表示のpx/m
  const MAX_SCALE = 1.0;
  const view = {
    x: M.minX + terrain.sizeMeters / 2,
    z: M.minZ + terrain.sizeMeters / 2,
    scale: fitScale,
  };

  const tiles = new Map(); // "z/x/y" -> ImageBitmap | 'loading' | 'error'
  function getTile(z, tx, ty) {
    const key = `${z}/${tx}/${ty}`;
    const v = tiles.get(key);
    if (v) return v instanceof ImageBitmap ? v : null;
    if (tiles.size >= 160) {
      for (const [oldKey, oldTile] of tiles) {
        if (oldTile === 'loading') continue;
        oldTile?.close?.(); tiles.delete(oldKey); break;
      }
      if (tiles.size >= 160) return null;
    }
    tiles.set(key, 'loading');
    mapBitmap(`https://cyberjapandata.gsi.go.jp/xyz/std/${z}/${tx}/${ty}.png`)
      .then((bmp) => { tiles.set(key, bmp); render(); })
      .catch(() => tiles.set(key, 'error'));
    return null;
  }

  const cssRatio = () => cv.width / cv.clientWidth;
  const worldToScreen = (wx, wz) => [
    (wx - view.x) * view.scale + cv.width / 2,
    (wz - view.z) * view.scale + cv.height / 2,
  ];
  const screenToWorld = (sx, sy) => [
    (sx - cv.width / 2) / view.scale + view.x,
    (sy - cv.height / 2) / view.scale + view.z,
  ];
  function clampView() {
    const half = cv.width / 2 / view.scale;
    view.x = THREE.MathUtils.clamp(view.x, M.minX + half, M.minX + terrain.sizeMeters - half);
    view.z = THREE.MathUtils.clamp(view.z, M.minZ + half, M.minZ + terrain.sizeMeters - half);
  }

  function render() {
    ctx.fillStyle = '#0d1620';
    ctx.fillRect(0, 0, cv.width, cv.height);

    // 表示解像度に合ったタイルズームを選ぶ
    let z = Math.round(13 + Math.log2((view.scale * tm13) / 256));
    z = THREE.MathUtils.clamp(z, 11, 17);
    const f = 2 ** (z - 13);
    const tmz = tm13 / f;

    const [wL, wT] = screenToWorld(0, 0);
    const [wR, wB] = screenToWorld(cv.width, cv.height);
    const txMin = Math.max(Math.floor((c13x + wL / tm13) * f), Math.floor(M.x0 * f));
    const txMax = Math.min(Math.floor((c13x + wR / tm13) * f), Math.ceil((M.x0 + M.n) * f) - 1);
    const tyMin = Math.max(Math.floor((c13y + wT / tm13) * f), Math.floor(M.y0 * f));
    const tyMax = Math.min(Math.floor((c13y + wB / tm13) * f), Math.ceil((M.y0 + M.n) * f) - 1);
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const bmp = getTile(z, tx, ty);
        if (!bmp) continue;
        const [sx, sy] = worldToScreen((tx / f - c13x) * tm13, (ty / f - c13y) * tm13);
        const s = tmz * view.scale;
        ctx.drawImage(bmp, sx, sy, s + 0.5, s + 0.5);
      }
    }

    // ターゲット(橙X+白丸)
    const [tx, ty] = worldToScreen(TARGET_XZ.x, TARGET_XZ.z);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(tx, ty, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#ff5a00';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(tx - 11, ty - 11); ctx.lineTo(tx + 11, ty + 11);
    ctx.moveTo(tx - 11, ty + 11); ctx.lineTo(tx + 11, ty - 11);
    ctx.stroke();
    // 選択中の離陸地点(赤丸)
    if (launchSel.x !== null) {
      const [lx, ly] = worldToScreen(launchSel.x, launchSel.z);
      ctx.fillStyle = '#e53935';
      ctx.beginPath();
      ctx.arc(lx, ly, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(lx, ly, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function zoomAt(ox, oy, dir) {
    const [wx, wz] = screenToWorld(ox * cssRatio(), oy * cssRatio());
    const k = dir > 0 ? 1.3 : 1 / 1.3;
    view.scale = THREE.MathUtils.clamp(view.scale * k, fitScale, MAX_SCALE);
    // カーソル/指の位置の地点が動かないように中心を合わせ直す
    view.x = wx - (ox * cssRatio() - cv.width / 2) / view.scale;
    view.z = wz - (oy * cssRatio() - cv.height / 2) / view.scale;
    clampView();
    render();
  }
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  let panOrigin = null;
  enablePointerNav(cv, cssRatio, {
    onPanStart: () => { panOrigin = { x: view.x, z: view.z }; },
    onPan: (dx, dy) => {
      view.x = panOrigin.x - dx / view.scale;
      view.z = panOrigin.z - dy / view.scale;
      clampView();
      render();
    },
    onTap: (ox, oy) => {
      const [wx, wz] = screenToWorld(ox * cssRatio(), oy * cssRatio());
      selectAt(wx, wz);
    },
    onZoom: zoomAt,
  });

  function selectAt(wx, wz) {
    launchSel.x = THREE.MathUtils.clamp(wx, M.minX, M.minX + terrain.sizeMeters);
    launchSel.z = THREE.MathUtils.clamp(wz, M.minZ, M.minZ + terrain.sizeMeters);
    render();
    const btn = document.getElementById('launch-btn');
    btn.disabled = false;
    const d = Math.hypot(launchSel.x - TARGET_XZ.x, launchSel.z - TARGET_XZ.z);
    btn.textContent = `離陸!(ターゲットまで ${(d / 1000).toFixed(2)} km)`;
  }

  render();
  return { selectAt };
}

document.getElementById('launch-btn').addEventListener('click', () => {
  if (launchSel.x === null) return;
  if (setupMode && !applyWindFromEditor()) return; // 離陸時点のエディタ内容で風を確定(既定モードは風エディタが無いため不要)
  startFlight(launchSel.x, launchSel.z);
});

function defaultLaunchPoint() {
  if (creativeWorld) return creativeLaunch();
  const w = windAt(1500 / M2FT);
  const spd = Math.hypot(w.vx, w.vz) || 1;
  const dist = 3000;
  return { x: -(w.vx / spd) * dist, z: -(w.vz / spd) * dist };
}

function startFlight(x, z) {
  // 離陸地点とターゲット周辺は先に高解像度化しておく
  terrain.requestDetail(x, z);
  terrain.requestDetail(TARGET_XZ.x, TARGET_XZ.z);
  state.pos.set(x, terrain.getHeight(x, z), z);
  state.vy = 0;
  state.heat = 0.5;
  state.grounded = true;
  balloon.group.position.copy(state.pos);
  controls.target.copy(state.pos).add(new THREE.Vector3(0, 12, 0));
  camera.position.copy(controls.target).add(new THREE.Vector3(60, 35, 60));
  prevPos.copy(state.pos);
  document.getElementById('briefing').style.display = 'none';
  flightReady = true;
  started = true;
  // チェイスカーは**離陸地点が決まってから**置く。道路の読み込みがまだ終わって
  // いなければ、終わった時点で loadRoadNetwork 側から置かれる
  // ?mode=chase: プレイヤーの車も同じ理由で離陸地点に置く(気球と同じ x,z から出発)
  spawnRaceCar(x, z);
  if (creativeWorld) {
    // 自分のチームは車と同じ離陸地点から出発し、周囲の5機は上空を飛ぶ。
    const tm = terrain.map;
    creativeFleet = createCreativeFleet({ startX: x, startZ: z,
      getHeight: terrain.getHeight, windAt, airspace: creativeAirspace,
      bounds: { minX: tm.minX, minZ: tm.minZ,
        maxX: tm.minX + tm.n * terrain.tileMeters,
        maxZ: tm.minZ + tm.n * terrain.tileMeters } });
    scene.add(creativeFleet.group);
  }
}

const balloon = teamBalloonModel ? createTeamBalloon(teamBalloonModel) : buildBalloon();
if (creativeWorld && !teamBalloonModel) markTeamBalloon(balloon.group);
scene.add(balloon.group);

const targetGroundY = terrain.getHeight(TARGET_XZ.x, TARGET_XZ.z);
const target = buildTarget(TARGET_XZ.x, TARGET_XZ.z, targetGroundY);
scene.add(target);

// 無線は短時間だけ表示。全文と得点はメニューから確認できる。
function chaseRadio(message) {
  chaseRadioLog.unshift(message);
  chaseRadioLog.length = Math.min(chaseRadioLog.length, 8);
  document.getElementById('chase-radio-log').textContent = chaseRadioLog.join('\n');
  const toast = document.getElementById('chase-toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(chaseToastTimer);
  chaseToastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}

function reportStatus() {
  const c = raceCar?.info();
  return groundReportStatus({ active: started && !expired && !chaseRace.finished && !!c,
    reported: chaseRace.reported,
    distance: c ? Math.hypot(c.x - TARGET_XZ.x, c.z - TARGET_XZ.z) : Infinity,
    speedMps: c?.speedMps });
}

function sendGroundReport() {
  if (!chaseMode || reportStatus() !== 'ready') return;
  const w = windAt(targetGroundY, TARGET_XZ.x, TARGET_XZ.z);
  if (!Number.isFinite(w.dir) || !Number.isFinite(w.kt) || w.kt < 0) return;
  chaseRace.reported = true;
  const dir = String(((Math.round(w.dir) % 360) + 360) % 360).padStart(3, '0');
  chaseRadio(`1号車：ターゲットの地上風 ${dir}°／${w.kt.toFixed(1)} kt。気球：了解！ 報告＋50点`);
  updateChaseMission();
}

function updateChaseMission() {
  const points = chasePoints(chaseRace);
  document.getElementById('chase-score').textContent = `${points.total} 点`;
  const status = reportStatus();
  const messages = { reported: '地上風報告済み（＋50点）', inactive: '地上風報告は競技中に送れます',
    'too-close': 'ターゲットから100〜400m離れて停車', 'too-far': 'ターゲットまで400m以内に進んで停車',
    moving: '停車すると地上風を報告できます', ready: '地上風を報告できます（1回50点）' };
  document.getElementById('chase-report-hint').textContent = messages[status];
  document.getElementById('chase-report').disabled = status !== 'ready';
  document.getElementById('chase-report-quick').hidden = status !== 'ready';
  let navigation = '';
  if (marker.state?.landed && !chaseRace.finished) {
    const c = raceCar.info(), p = marker.state.pos;
    const distance = Math.hypot(p.x - c.x, p.z - c.z);
    const bearing = (Math.atan2(p.x - c.x, -(p.z - c.z)) * 180 / Math.PI + 360) % 360;
    navigation = `回収まで ${Math.round(distance)}m · ${String(Math.round(bearing) % 360).padStart(3, '0')}°`;
  }
  const nav = document.getElementById('chase-recovery');
  nav.textContent = navigation;
  nav.hidden = !navigation;
}

function finishChase(caught, afterLanding, note) {
  if (chaseRace.finished) return;
  Object.assign(chaseRace, { finished: true, caught, afterLanding });
  expired = true;
  input.burner = input.rip = false;
  resetRaceControls?.();
  document.getElementById('pause-btn').disabled = true;
  const points = chasePoints(chaseRace);
  let best = 0;
  try {
    best = Number(localStorage.getItem(CHASE_BEST_KEY)) || 0;
    if (points.total > best) localStorage.setItem(CHASE_BEST_KEY, String(points.total));
  } catch { /* 保存できなくても結果は表示する */ }
  document.querySelector('#result .r-title').textContent = note;
  document.querySelector('#result .r-dist').hidden = true;
  const landing = chaseRace.landingDistance === null ? '' : `\n着地時の車との距離 ${chaseRace.landingDistance.toFixed(1)}m`;
  document.getElementById('result-sub').textContent =
    `合計 ${points.total} 点\n回収 ${points.recovery} 点 ／ 地上風報告 ${points.report} 点${landing}\n自己ベスト ${Math.max(best, points.total)} 点`;
  document.getElementById('result-sub').style.whiteSpace = 'pre-line';
  document.getElementById('result-retry').textContent = 'もう一度走る';
  document.getElementById('result').style.display = '';
  document.getElementById('mobile-menu').open = false;
  document.getElementById('marker-info').textContent = caught ? '回収済み' : '終了';
  chaseRadio(`${note} 合計 ${points.total} 点`);
  updateChaseMission();
}

function checkGroundRecovery() {
  if (chaseRace.finished || !marker.state?.landed || !raceCar) return;
  const c = raceCar.info(), p = marker.state.pos;
  if (Math.hypot(p.x - c.x, p.z - c.z) <= RECOVERY_RADIUS) finishChase(true, true, '着地後に回収！');
}

function stepChaseFlight(dt) {
  let w = windAt(state.pos.y, state.pos.x, state.pos.z);
  // ×8でも着地時の車位置を古いフレームで判定しない。
  for (let left = dt; left > 1e-9 && !chaseRace.finished;) {
    const step = Math.min(left, 1 / 60);
    left -= step;
    const ctrl = raceAutopilot.control(state.pos, state.vy, step, state.heat);
    if (creativeWorld && ctrl.blocked) {
      finishChase(false, false, '安全な飛行経路が見つからないためフライトを終了');
      break;
    }
    input.burner = ctrl.burner;
    input.rip = ctrl.rip;
    const previous = creativeWorld ? { ...state.pos, vy: state.vy, heat: state.heat, fuel: state.fuel, grounded: state.grounded } : null;
    w = stepPhysics(step);
    if (creativeWorld) {
      const violation = segmentViolation(previous, state.pos, creativeAirspace, terrain.getHeight);
      if (violation) {
        // Stop the game at the last valid state, never clamp/teleport through a PZ.
        state.pos.set(previous.x,previous.y,previous.z);
        Object.assign(state,{vy:previous.vy,heat:previous.heat,fuel:previous.fuel,grounded:previous.grounded});
        finishChase(false, false, `${violation}への進入を防ぐためフライトを終了`);
        break;
      }
    }
    raceCar?.update(step, raceCarInput);
    stepMarker(step);
    if (chaseRace.finished) break;
    checkGroundRecovery();
    if (chaseRace.finished) break;
    stepClock(step);
    if (chaseRace.finished) break;
    if (!expired && !state.grounded && marker.available > 0) {
      const notice = raceAutopilot.dropNotice(state.pos);
      if (notice !== null) chaseRadio(`気球：${notice <= 5 ? 'まもなく' : `約${Math.ceil(notice)}秒後に`}投下予定（ゲーム内時間・風で変わります）。`);
      if (raceAutopilot.shouldDrop(state.pos)) dropMarker();
    }
    const p = marker.state?.pos || state.pos, map = terrain.map;
    if (p.x < map.minX || p.z < map.minZ || p.x > map.minX + terrain.sizeMeters || p.z > map.minZ + terrain.sizeMeters) {
      finishChase(false, false, '飛行範囲外のため終了');
    }
  }
  return w;
}

// マーカーは1本。dropped後は marker.state が物理を持つ
const marker = { available: 1, state: null, mesh: null };

function dropMarker() {
  if (marker.available <= 0 || state.grounded || expired || (chaseMode && chaseRace.finished)) return false;
  marker.available = 0;
  const w = windAt(state.pos.y, state.pos.x, state.pos.z);
  marker.state = {
    pos: state.pos.clone().add(new THREE.Vector3(0, 0.8, 0)),
    vel: new THREE.Vector3(w.vx, state.vy, w.vz), // 気球(=風)の速度を引き継ぐ
    landed: false,
  };
  marker.mesh = buildMarkerMesh();
  marker.mesh.position.copy(marker.state.pos);
  scene.add(marker.mesh);
  document.getElementById('marker-info').textContent = '投下!';
  if (chaseMode) {
    raceAutopilot.markDropped();
    chaseRadio('気球：マーカー投下！ 着地点へ先回りしてください。');
  }
  return true;
}

function stepMarker(dt) {
  const m = marker.state;
  if (!m || m.landed) return;
  const w = windAt(m.pos.y, m.pos.x, m.pos.z);
  m.vel.y += (-9.81 - MARKER_DRAG * m.vel.y) * dt;
  m.vel.x += ((w.vx - m.vel.x) / MARKER_WIND_TAU) * dt;
  m.vel.z += ((w.vz - m.vel.z) / MARKER_WIND_TAU) * dt;
  m.pos.addScaledVector(m.vel, dt);

  const ground = terrain.getHeight(m.pos.x, m.pos.z);
  if (m.pos.y <= ground) {
    m.pos.y = ground + 0.3;
    m.landed = true;
    marker.mesh.position.copy(m.pos);
    onMarkerLanded(m.pos);
    return;
  }
  marker.mesh.position.copy(m.pos);
  marker.mesh.rotation.y += 2 * dt; // リボンの回転(演出)
  document.getElementById('marker-info').textContent = `落下中 ${Math.round(m.pos.y - ground)}m`;
}

function onMarkerLanded(pos) {
  if (chaseMode && raceCar) {
    if (chaseRace.finished) return;
    const car = raceCar.info();
    chaseRace.landingDistance = Math.hypot(pos.x - car.x, pos.z - car.z);
    if (chaseRace.landingDistance <= RECOVERY_RADIUS) {
      finishChase(true, false, '着地時に回収！');
    } else {
      chaseRadio('気球：マーカー着地。車で30m以内に近づくと回収500点です。');
    }
    return;
  }
  // 通常モード(JDG)はターゲット中心からの距離で計測する。
  const refX = TARGET_XZ.x;
  const refZ = TARGET_XZ.z;
  const dist = Math.hypot(pos.x - refX, pos.z - refZ);
  // 着地点→ターゲットの計測ライン
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(pos.x, pos.y + 1, pos.z),
    new THREE.Vector3(refX, terrain.getHeight(refX, refZ) + 1, refZ),
  ]);
  scene.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffee58 })));
  showResult(dist, null);
}

function showResult(dist, note) {
  // 通常モード(JDG)の距離記録。回収レースの得点記録とは分ける。
  const bestKey = BEST_KEY;
  let prev = 0;
  try { prev = Number(localStorage.getItem(bestKey)); } catch { /* 保存不可でも競技を続ける */ }
  const isBest = !Number.isFinite(prev) || prev <= 0 || dist < prev;
  if (isBest) { try { localStorage.setItem(bestKey, dist.toFixed(1)); } catch { /* 任意の保存 */ } }

  const subs = [];
  if (note) subs.push(note);
  subs.push(isBest ? '自己ベスト更新!' : `自己ベスト: ${Number(prev).toFixed(1)} m`);
  document.getElementById('result-dist').textContent = dist.toFixed(1);
  document.getElementById('result-sub').innerHTML = subs.join('<br>');
  document.getElementById('result').style.display = '';
  document.getElementById('marker-info').textContent = `${dist.toFixed(1)} m`;
}

// 制限時間の進行。時間内に投下できなければ現在地点で計測(フォールバック)
function stepClock(dt) {
  if (expired) return;
  remaining = Math.max(0, remaining - dt);
  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(Math.floor(remaining % 60)).padStart(2, '0');
  hud.clock.textContent = `${mm}:${ss}`;
  if (remaining <= 0) {
    expired = true;
    if (!marker.state) {
      marker.available = 0;
      if (chaseMode) { finishChase(false, false, '時間切れ：マーカー未投下'); return; }
      // マーカーが投下されなかった場合のフォールバック計測は、通常モードと同じく
      // 「気球の現在地→ターゲット」のまま(まだ着地点が無いので車との比較はできない)
      const d = Math.hypot(state.pos.x - TARGET_XZ.x, state.pos.z - TARGET_XZ.z);
      showResult(d, '制限時間切れ: 現在地点で計測');
    }
  }
}

document.getElementById('result-retry').addEventListener('click', () => location.reload());

// 物理状態。pos.y はバスケット底面の標高(MSL)
const state = {
  pos: new THREE.Vector3(0, terrain.getHeight(0, 0), 0),
  vy: 0,
  heat: 0.5,   // エンベロープ温度(0..1)。0.5 が中立浮力
  fuel: 100,
  grounded: true,
};
const H_NEUTRAL = 0.5;

function stepPhysics(dt) {
  if (input.burner && state.fuel > 0) {
    state.heat += 0.055 * dt;
    state.fuel = Math.max(0, state.fuel - 0.25 * dt);
  }
  if (input.rip) state.heat -= 0.16 * dt;
  state.heat -= 0.012 * dt; // 自然冷却
  state.heat = THREE.MathUtils.clamp(state.heat, 0, 1);

  // 浮力(温度差比例)と空気抵抗。加熱の効きが遅れて現れる感覚はこの一次遅れで出る
  const acc = 7.0 * (state.heat - H_NEUTRAL) - 0.5 * state.vy;
  state.vy += acc * dt;
  state.pos.y += state.vy * dt;

  const w = windAt(state.pos.y, state.pos.x, state.pos.z);
  if (!state.grounded) {
    state.pos.x += w.vx * dt;
    state.pos.z += w.vz * dt;
  }

  const ground = terrain.getHeight(state.pos.x, state.pos.z);
  if (state.pos.y <= ground) {
    state.pos.y = ground;
    if (state.vy < 0) state.vy = 0;
    state.grounded = true;
  } else if (state.pos.y > ground + 0.05) {
    state.grounded = false;
  }
  return w;
}

document.getElementById('chase-report').addEventListener('click', sendGroundReport);
document.getElementById('chase-report-quick').addEventListener('click', sendGroundReport);

// ---- コンパス(カメラの向き=画面正面の磁方位。ターゲット方向をオレンジ印で表示) ----
const compassCv = document.getElementById('compass');
const compassCtx = compassCv.getContext('2d');
const camDirTmp = new THREE.Vector3();

function drawCompass() {
  camera.getWorldDirection(camDirTmp);
  const heading = (Math.atan2(camDirTmp.x, -camDirTmp.z) * 180 / Math.PI + 360) % 360;

  const ctx = compassCtx;
  const W = compassCv.width, C = W / 2, R = W / 2 - 10;
  ctx.clearRect(0, 0, W, W);

  // 文字盤(視線方向が常に上。北の文字が回る)
  ctx.save();
  ctx.translate(C, C);
  ctx.rotate((-heading * Math.PI) / 180);
  for (let d = 0; d < 360; d += 30) {
    const rad = (d * Math.PI) / 180;
    const isCard = d % 90 === 0;
    ctx.strokeStyle = isCard ? '#e8f0f6' : '#5a7085';
    ctx.lineWidth = isCard ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(Math.sin(rad) * (R - (isCard ? 12 : 7)), -Math.cos(rad) * (R - (isCard ? 12 : 7)));
    ctx.lineTo(Math.sin(rad) * R, -Math.cos(rad) * R);
    ctx.stroke();
  }
  ctx.font = 'bold 20px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cards = [['N', 0, '#ff5252'], ['E', 90, '#e8f0f6'], ['S', 180, '#e8f0f6'], ['W', 270, '#e8f0f6']];
  for (const [label, deg, color] of cards) {
    const rad = (deg * Math.PI) / 180;
    ctx.save();
    ctx.translate(Math.sin(rad) * (R - 26), -Math.cos(rad) * (R - 26));
    ctx.rotate((heading * Math.PI) / 180); // 文字自体は正立させる
    ctx.fillStyle = color;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
  // ターゲット方向(オレンジの印)
  const brgT = Math.atan2(TARGET_XZ.x - state.pos.x, -(TARGET_XZ.z - state.pos.z));
  ctx.fillStyle = '#ff5a00';
  ctx.beginPath();
  ctx.arc(Math.sin(brgT) * (R - 5), -Math.cos(brgT) * (R - 5), 5, 0, Math.PI * 2);
  ctx.fill();

  // 2km も離れると車は画面上で点にもならないので、実機と同じく「見えなくても方位は分かる」
  if (chaseCar) {
    const c = chaseCar.info();
    const brgC = Math.atan2(c.x - state.pos.x, -(c.z - state.pos.z));
    ctx.fillStyle = '#5ad0ff';
    ctx.beginPath();
    ctx.rect(Math.sin(brgC) * (R - 5) - 4, -Math.cos(brgC) * (R - 5) - 4, 8, 8);
    ctx.fill();
  }
  ctx.restore();

  // 視線方向の固定ポインタ(上向き三角)と数値
  ctx.fillStyle = '#ffd54f';
  ctx.beginPath();
  ctx.moveTo(C, 4);
  ctx.lineTo(C - 7, 18);
  ctx.lineTo(C + 7, 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e8f0f6';
  ctx.font = 'bold 16px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${String(Math.round(heading)).padStart(3, '0')}°`, C, C);
}

// ---- HUD ----
const hud = {
  altFt: document.getElementById('alt-ft'),
  altM: document.getElementById('alt-m'),
  agl: document.getElementById('agl'),
  vario: document.getElementById('vario'),
  wind: document.getElementById('wind'),
  fuel: document.getElementById('fuel'),
  fuelFill: document.getElementById('fuel-fill'),
  heatFill: document.getElementById('heat-fill'),
  status: document.getElementById('status'),
  target: document.getElementById('target-info'),
  clock: document.getElementById('clock'),
  raceCruise: document.getElementById('race-cruise'),
  raceCarSpeed: document.getElementById('race-car-speed'),
  raceCarTarget: document.getElementById('race-car-target'),
  raceCarBalloon: document.getElementById('race-car-balloon'),
};
function updateHud(w) {
  const ground = terrain.getHeight(state.pos.x, state.pos.z);
  hud.altFt.textContent = Math.round(state.pos.y * M2FT);
  hud.altM.textContent = Math.round(state.pos.y);
  hud.agl.textContent = Math.round(state.pos.y - ground);
  hud.vario.textContent = (state.vy >= 0 ? '+' : '') + state.vy.toFixed(1);
  hud.wind.textContent = `${String(Math.round(w.dir)).padStart(3, '0')}° / ${w.kt.toFixed(0)}kt`;
  hud.fuel.textContent = Math.round(state.fuel);
  hud.fuelFill.style.width = `${state.fuel}%`;
  hud.heatFill.style.width = `${state.heat * 100}%`;
  hud.status.textContent = state.grounded ? '接地' : '飛行中';

  const dxE = TARGET_XZ.x - state.pos.x;        // 東成分
  const dN = -(TARGET_XZ.z - state.pos.z);      // 北成分
  const distT = Math.hypot(dxE, dN);
  const brg = (Math.atan2(dxE, dN) * 180 / Math.PI + 360) % 360;
  hud.target.textContent =
    `${distT >= 1000 ? (distT / 1000).toFixed(2) + ' km' : Math.round(distT) + ' m'} / ${String(Math.round(brg)).padStart(3, '0')}°`;
}

// ?mode=chase 専用のHUD行(1号車の速度・ターゲット/気球までの距離・気球の巡航目標)。
// updateHud() とは別関数にする: 気球パイロット向けの updateHud() は通常モードでも
// そのまま使い続けるので、chaseMode 専用の追加分だけをここに切り出す
function updateRaceHud() {
  if (!raceCar) return;
  const c = raceCar.info();
  hud.raceCarSpeed.textContent = `${c.speedKmh} km/h`;

  // 1号車→ターゲット(距離・方位)。updateHud() の「ターゲット」行(気球→ターゲット)と
  // 同じ方位の求め方(x:東+, z:南+ → atan2(東成分, 北成分)で北基準の方位)
  const dxT = TARGET_XZ.x - c.x, dNT = -(TARGET_XZ.z - c.z);
  const distCarTarget = Math.hypot(dxT, dNT);
  const brgCarTarget = (Math.atan2(dxT, dNT) * 180 / Math.PI + 360) % 360;
  hud.raceCarTarget.textContent =
    `${distText(distCarTarget)} / ${String(Math.round(brgCarTarget)).padStart(3, '0')}°`;

  // 1号車→気球(水平距離のみ。高度差は「気球 高度」行で分かるので混ぜない)
  const dxB = state.pos.x - c.x, dNB = -(state.pos.z - c.z);
  hud.raceCarBalloon.textContent = distText(Math.hypot(dxB, dNB));

  // 気球が今どの高度を巡航目標にしているか。RESCAN_S(25秒)おきにしか変わらないので、
  // パイバル表と突き合わせれば「しばらくこの向きへ飛ぶ」と読める
  const cruise = raceAutopilot ? raceAutopilot.cruiseFt() : null;
  hud.raceCruise.textContent = cruise === null ? '--' : `${Math.round(cruise)} ft`;
  updateChaseMission();
  if (creativeWorld && document.getElementById('creative-airspace').open) drawCityMap();
}

function drawCityMap() {
  const cv=document.getElementById('city-map'),ctx=cv.getContext('2d');
  const lp=creativeLaunch(),c=raceCar.info();
  const points=[lp,state.pos,{x:c.x,z:c.z},{x:0,z:0},...creativeCity.items];
  const minX=Math.min(...points.map(p=>p.x))-300,maxX=Math.max(...points.map(p=>p.x))+300;
  const minZ=Math.min(...points.map(p=>p.z))-300,maxZ=Math.max(...points.map(p=>p.z))+300;
  const scale=Math.min(cv.width/(maxX-minX),cv.height/(maxZ-minZ));
  const px=x=>(x-(minX+maxX)/2)*scale+cv.width/2,pz=z=>(z-(minZ+maxZ)/2)*scale+cv.height/2;
  ctx.fillStyle='#273e36';ctx.fillRect(0,0,cv.width,cv.height);
  for (const item of creativeCity.items) {
    const spec=CATALOG[item.type];ctx.fillStyle=item.type==='park'?'#749a69':item.type==='road'?'#87958a':'#c9c0a2';
    ctx.save();ctx.translate(px(item.x),pz(item.z));ctx.rotate(-item.rotation*Math.PI/180);
    const w=Math.max(2,spec.width*item.scale*scale),d=Math.max(2,(item.length||spec.depth)*item.scale*scale);
    ctx.fillRect(-w/2,-d/2,w,d);ctx.restore();
  }
  for (const z of creativeAirspace.zones) {
    ctx.strokeStyle=z.type==='red'?'#e67d67':z.type==='blue'?'#74b1ee':'#dfc16d';
    ctx.beginPath();ctx.arc(px(z.x),pz(z.z),z.radius*scale,0,Math.PI*2);ctx.stroke();
  }
  for (const [p,color,r] of [[lp,'#d7b265',3],[{x:0,z:0},'#fffef2',5],[state.pos,'#65dcf0',4],[c,'#ffd167',3]]) {
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(px(p.x),pz(p.z),r,0,Math.PI*2);ctx.fill();
  }
  ctx.fillStyle='#fff';ctx.font='11px sans-serif';ctx.fillText(`気球：海抜${Math.round(state.pos.y)}m / 対地${Math.round(state.pos.y-terrain.getHeight(state.pos.x,state.pos.z))}m`,9,18);
}

// ?mode=chase では、気球パイロット向けの表示(燃料・エンベロープ温度・通常の操作説明)を隠し、
// 車の速度・ターゲット/気球までの距離などチェイスモードで意味のある表示に切り替える。
// DOM 側(instruments-race-only 等)は既定で隠してあるので、通常モードでは何もしない
function applyRaceHudMode() {
  if (!chaseMode) return;
  document.body.classList.add('chase-mode');
  document.getElementById('chase-mission').hidden = false;
  document.getElementById('chase-quick').hidden = false;
  document.getElementById('tc-flight').hidden = true;
  document.getElementById('tc-marker').hidden = true;
  document.getElementById('tc-driving').hidden = false;
  document.getElementById('tc-overview').hidden = false;
  document.getElementById('tc-view').textContent = '視点';
  if (isTouchDevice) {
    document.getElementById('tc-toolbar').append(document.getElementById('pause-btn'));
    const menu = document.getElementById('mobile-menu');
    menu.hidden = false;
    const content = document.getElementById('mobile-menu-content');
    for (const id of ['tc-toolbar', 'help', 'instruments', 'credit']) {
      content.append(document.getElementById(id));
    }
    // 視点を選んだらすぐ景色へ戻す。一時停止中は再開ボタンを見せておく。
    for (const id of ['tc-view', 'tc-overview']) {
      document.getElementById(id).addEventListener('click', () => { menu.open = false; });
    }
  }
  resetRaceControls = bindCarControls(raceCarInput);
  document.getElementById('instruments-pilot-only').style.display = 'none';
  document.getElementById('instruments-race-only').style.display = '';
  document.getElementById('target-label').textContent = '気球→ターゲット';
  const normalHelp = document.getElementById('help-keys');
  const raceHelp = document.getElementById('help-keys-race');
  raceHelp.open = normalHelp.open; // 開閉状態(devModeかどうかで既に決まっている)を引き継ぐ
  normalHelp.style.display = 'none';
  raceHelp.style.display = '';
  // 一時停止ボタンは既定で hidden 属性を付けて隠してある。chaseMode のときだけ外して出す
  document.getElementById('pause-btn').hidden = false;
  // コンパスのターゲット方位(オレンジの印)は気球基準(state.pos)で計算されており、
  // 車を運転するチェイスモードでは向きがずれて誤解を招く。車基準に作り直すのではなく、
  // このモードでは単純に隠す(下のレンダーループの drawCompass() 呼び出し自体も止める)。
  // 空いた画面下中央に一時停止ボタンを置く
  document.getElementById('compass').style.display = 'none';
  // instruments/pibal/credit の3つだけが対象(いずれもタッチ端末判定より前の
  // 分岐で .open = true にされているので、ここで上書きする)
  document.getElementById('instruments').open = false;
  document.getElementById('pibal').open = false;
  document.getElementById('credit').open = false;
  updateRaceControlsEnabled();
}

// ---- カメラ初期配置 ----
balloon.group.position.copy(state.pos);
controls.target.copy(state.pos).add(new THREE.Vector3(0, 12, 0));
camera.position.copy(controls.target).add(new THREE.Vector3(60, 35, 60));
applyViewMode();

const prevPos = state.pos.clone();
const clock = new THREE.Clock();
let lastDetailCheck = 0;
let envGlow = 0;  // バーナー点火時の球皮内面の明るさ(0..1、滑らかに追従)
let ripPull = 0;  // リップラインを引いた量(0..1、滑らかに追従)

// 初回起動(既定エリア・setupなし・住所指定なし・devなし)ではブリーフィングを介さず即離陸する。
// ?fpv=1 を付けるとゴンドラ視点で開始(視点確認用、離陸後に反映される)
if (creativeWorld) {
  const lp = defaultLaunchPoint();
  startFlight(lp.x, lp.z);
}

renderer.setAnimationLoop(() => {
  // clock.getDelta() は一時停止中も毎フレーム呼んでおく(呼ばないと、再開した瞬間に
  // 止めていた分の経過時間がまとめて dt に乗ってしまい、カクつきや飛び越しが起きる)。
  // 止めるのは dt を 0 にするだけ(このファイル冒頭の paused の説明を参照)
  const rawDt = clock.getDelta();
  const dt = paused || (chaseMode && chaseRace.finished) ? 0 : Math.min(rawDt, 0.05) * timeScale;

  if (started) {
    let w;
    if (chaseMode) {
      w = stepChaseFlight(dt);
    } else {
      w = stepPhysics(dt);
      stepMarker(dt);
      stepClock(dt);
    }
    if (creativeFleet && !chaseRace.finished) creativeFleet.update(dt);
    updateSounds(w.kt);
    // 2号車・3号車(参考動作)。carAutopilot.js の単純な追尾で、道路グラフは見ない
    if (raceCar2) {
      raceCar2.update(dt, carAutopilotControl(
        raceCar2.info(), TARGET_XZ.x, TARGET_XZ.z, RACE_CAR2_STANDOFF_M));
    }
    if (raceCar3) {
      raceCar3.update(dt, carAutopilotControl(raceCar3.info(), state.pos.x, state.pos.z));
    }

    balloon.group.position.copy(state.pos);
    balloon.flame.visible = input.burner && state.fuel > 0;
    balloon.flameLight.intensity = balloon.flame.visible ? 40 : 0;

    // バーナー点火で球皮内面がふわっと暖色に明るくなる(点滅ではなく滑らかな変化)
    const glowTarget = balloon.flame.visible ? 1 : 0;
    envGlow += (glowTarget - envGlow) * Math.min(1, dt * 2.5);
    balloon.envInnerMat?.color.setRGB(1 + 0.3 * envGlow, 1 + 0.12 * envGlow, 1);
    // リップラインを引いている間はロープが引き下がる
    const pullTarget = input.rip ? 1 : 0;
    ripPull += (pullTarget - ripPull) * Math.min(1, dt * 6);
    if (balloon.rope) balloon.rope.position.y = balloon.ropeBaseY - 0.18 * ripPull;

    if (chaseMode && raceCar) {
      // ?mode=chase: 気球ではなく、プレイヤーが操縦する車にカメラを合わせる
      const c = raceCar.info();
      if (raceOverview || Math.abs(c.speedMps) > 0.05) raceStoppedCamera?.reset();
      if (raceOverview) {
        raceOverviewCamera.update(state.pos, c);
      } else if (!raceStoppedCamera?.active) {
        placeRaceFollowCamera();
      }
    } else if (fpv) {
      // ゴンドラ視点: 目の位置は気球に固定し、視線方向だけドラッグで回す。
      // 立ち位置は中心から少し横(実機のパイロット位置。真上の炎が正しく見える)
      camera.position.set(state.pos.x - 0.45, state.pos.y + EYE_HEIGHT, state.pos.z);
      const cy = Math.cos(fpvPitch), sy = Math.sin(fpvPitch);
      const dir = new THREE.Vector3(Math.sin(fpvYaw) * cy, sy, -Math.cos(fpvYaw) * cy);
      camera.lookAt(camera.position.x + dir.x, camera.position.y + dir.y, camera.position.z + dir.z);
    } else if (carView && viewCar()) {
      // チェイスカーの車内から。**既定では気球を見る**(地上クルーは気球を目で追っている)。
      // ドラッグ量はそこからの相対角なので、ずらせば進行方向の道路も見られる
      const c = viewCar().info();
      const headRad = (c.headingDeg * Math.PI) / 180;
      // 車体の中心より少し前に目を置く(ボンネット越しの視界にならないように)
      camera.position.set(
        c.x + Math.sin(headRad) * 0.8,
        c.y + CAR_EYE_ABOVE_FLOOR,
        c.z - Math.cos(headRad) * 0.8,
      );
      // 見る基準。'balloon' なら気球の方向(車が曲がっても気球を見続ける)、
      // 'forward' なら車の進行方向(道路の繋がりや経路の選び方が見える)
      let baseYaw = headRad, basePitch = 0;
      if (carAim === 'balloon') {
        const dx = state.pos.x - camera.position.x;
        const dz = state.pos.z - camera.position.z;
        const dy = state.pos.y - camera.position.y;
        baseYaw = Math.atan2(dx, -dz);
        basePitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
      const yaw = baseYaw + carYaw;
      const pitch = THREE.MathUtils.clamp(basePitch + carPitch, -PITCH_LIMIT, PITCH_LIMIT);
      const cy = Math.cos(pitch), sy = Math.sin(pitch);
      const dir = new THREE.Vector3(Math.sin(yaw) * cy, sy, -Math.cos(yaw) * cy);
      camera.lookAt(camera.position.x + dir.x, camera.position.y + dir.y, camera.position.z + dir.z);
    } else if (orbitCar) {
      // 外部視点でチェイスカーを回る(Shift+V)。気球のときと同じく、
      // 回る中心を車に合わせ、カメラも同じだけ平行移動させる。
      // OrbitControls はそのままなので、ドラッグで回す・寄る はいつもどおり効く
      const c = orbitCar.info();
      const tgt = new THREE.Vector3(c.x, c.y + CAR_ORBIT_LIFT, c.z);
      if (hasPrevOrbitPos) camera.position.add(tgt.clone().sub(prevOrbitPos));
      controls.target.copy(tgt);
      prevOrbitPos.copy(tgt);
      hasPrevOrbitPos = true;
    } else {
      // カメラは気球に追従(ターゲット+同じ分だけ平行移動)
      const delta = new THREE.Vector3().subVectors(state.pos, prevPos);
      camera.position.add(delta);
      controls.target.copy(state.pos).add(new THREE.Vector3(0, 12, 0));
    }
    prevPos.copy(state.pos);

    updateHud(w);
    if (chaseMode) updateRaceHud();
    // コンパスは気球基準のターゲット方位を描くため、chaseMode では隠した上で描画自体も省く
    if (!chaseMode) drawCompass();

    // 気球の近くの地面を段階的に高解像度化(1.5秒おきに1枚ずつ)。
    // 低高度では直下の1タイルだけさらにz17(≒1m/px)へ
    if (performance.now() - lastDetailCheck > 1500) {
      lastDetailCheck = performance.now();
      terrain.updateDetail(state.pos.x, state.pos.z);
      const agl = state.pos.y - terrain.getHeight(state.pos.x, state.pos.z);
      if (agl < 1000) terrain.requestUltra(state.pos.x, state.pos.z);
    }
  }

  if (!chaseMode && !fpv && !carView) controls.update();
  updateCreativeTeamLabels();
  renderer.render(scene, camera);
});
