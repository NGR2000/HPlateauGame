// PLATEAU(3D都市モデル)の建築物LOD1を読み込み、
// prototype/terrain.js と同じローカル座標系(x:東+, y:標高, z:南+, 単位m)に載せる。
//
// 実データで確認した前提(2026-08-27):
//   - 配信は https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/<spec>/tileset.json
//     認証不要・CORS `*`・Range リクエスト可
//   - b3dm はサイズの約76%が使わない属性JSON(batchTable)。glTF はファイル末尾にあるので
//     先頭28バイトのヘッダだけ先に読んでオフセットを求め、glTF 部分だけを Range で取る
//   - ジオメトリは KHR_draco_mesh_compression で圧縮されている
//   - LOD1 はテクスチャを持たない(仕様上、高さだけの箱)。写真テクスチャが要るなら LOD2。
//     LOD2 は EXT_texture_webp で、タイルごとにアトラス1枚(three の GLTFLoader が対応済み)
//   - 座標は CESIUM_RTC 拡張(中心からの相対値)。Three.js の GLTFLoader はこれを無視するため
//     JSONチャンクから自前で読んで平行移動する
//   - 高さは「楕円体高」。地理院DEMの「標高」とは日本で約30〜40mずれる(ジオイド高)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { fetchResource, fetchJson, assertRemoteUrl, dataError } from './safeFetch.js';
import { tileImageSize } from './tileLoader.js';

const CATALOG = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles';
const DRACO_PATH = new URL('./vendor/three/examples/jsm/libs/draco/', import.meta.url).href;
const MAX_GLB_BYTES = 32 * 1024 * 1024;
const MAX_B3DM_BYTES = 64 * 1024 * 1024;

// WGS84
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

// 経緯度(度)+楕円体高(m) → 地球中心直交座標(ECEF)
export function lonLatToEcef(lonDeg, latDeg, h = 0) {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + h) * cosLat * Math.cos(lon),
    (n + h) * cosLat * Math.sin(lon),
    (n * (1 - WGS84_E2) + h) * sinLat,
  ];
}

// 基準点(lon,lat)を原点とする ECEF → ゲーム内座標(x:東+, y:上+, z:南+) の変換行列。
// y は「基準点の楕円体高0からの高さ」になる。標高に直すにはジオイド高を引く(呼び出し側で調整)。
export function makeEcefToLocalMatrix(lonDeg, latDeg) {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);

  // 基準点における東・北・上の単位ベクトル(ECEF成分)
  const east  = [-sinLon, cosLon, 0];
  const north = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
  const up    = [cosLat * cosLon, cosLat * sinLon, sinLat];
  const o = lonLatToEcef(lonDeg, latDeg, 0);

  // 行 = 各基底との内積。z は南+なので north を反転する
  const m = new THREE.Matrix4();
  m.set(
    east[0],   east[1],   east[2],  0,
    up[0],     up[1],     up[2],    0,
    -north[0], -north[1], -north[2], 0,
    0, 0, 0, 1,
  );
  // 平行移動(原点を基準点へ)を先に適用する
  const t = new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]);
  return m.multiply(t);
}

// --- b3dm の解析 -----------------------------------------------------------

// b3dm ヘッダ(28バイト)から glTF の位置と長さを求める
export function parseB3dmHeader(buf) {
  if (buf.byteLength < 28) throw dataError('b3dmヘッダーが短すぎます');
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'b3dm' || dv.getUint32(4, true) !== 1) throw dataError('b3dmの形式が不正です');
  const byteLength = dv.getUint32(8, true);
  const ftJson = dv.getUint32(12, true);
  const ftBin  = dv.getUint32(16, true);
  const btJson = dv.getUint32(20, true);
  const btBin  = dv.getUint32(24, true);
  const glbOffset = 28 + ftJson + ftBin + btJson + btBin;
  if (byteLength > 512 * 1024 * 1024 || glbOffset > byteLength - 20 || byteLength - glbOffset > MAX_GLB_BYTES) {
    throw dataError('b3dmのデータ範囲が不正です');
  }
  return { byteLength, glbOffset, glbLength: byteLength - glbOffset };
}

// glb の JSONチャンクを読んで CESIUM_RTC の中心座標(ECEF)を取り出す。無ければ null
// GLBの外部URIを受け付けず、展開前に頂点・画像数と画像寸法を検査する。
export function readRtcCenter(glb) {
  if (glb.byteLength < 20 || glb.byteLength > MAX_GLB_BYTES) throw dataError('GLBの大きさが不正です');
  const dv = new DataView(glb);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2
      || dv.getUint32(8, true) !== glb.byteLength || dv.getUint32(16, true) !== 0x4e4f534a) {
    throw dataError('GLBヘッダーが不正です');
  }
  const jsonLength = dv.getUint32(12, true);
  if (jsonLength > 4 * 1024 * 1024 || 20 + jsonLength > glb.byteLength || jsonLength % 4) throw dataError('GLBのJSON範囲が不正です');
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(glb, 20, jsonLength)));
  if (!json || json.asset?.version !== '2.0') throw dataError('GLBのバージョンが不正です');
  const stack = [[json, 0]];
  let nodes = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++nodes > 100000 || depth > 32) throw dataError('GLBの構造が大きすぎます');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'uri') throw dataError('GLBの外部リソースは許可されていません');
        stack.push([child, depth + 1]);
      }
    }
  }
  let counts = 0;
  for (const accessor of json.accessors || []) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > 2000000) throw dataError('GLBの要素数が不正です');
    counts += accessor.count;
  }
  if (counts > 20000000 || (json.images?.length || 0) > 256 || (json.meshes?.length || 0) > 10000) throw dataError('GLBの要素数が上限を超えています');
  const binHeader = 20 + jsonLength;
  const binStart = binHeader + 8;
  if ((json.buffers?.length || 0) > 1 || (json.buffers?.length && (
      binStart > glb.byteLength || dv.getUint32(binHeader + 4, true) !== 0x004e4942
      || binStart + dv.getUint32(binHeader, true) !== glb.byteLength
      || json.buffers[0].byteLength > glb.byteLength - binStart))) throw dataError('GLBのバッファが不正です');
  for (const image of json.images || []) {
    const view = json.bufferViews?.[image.bufferView];
    const start = view?.byteOffset || 0;
    if (!view || view.buffer !== 0 || !Number.isSafeInteger(start) || start < 0
        || !Number.isSafeInteger(view.byteLength) || view.byteLength < 24
        || binStart + start + view.byteLength > glb.byteLength) throw dataError('GLB画像の範囲が不正です');
    const bytes = new Uint8Array(glb, binStart + start, view.byteLength);
    let size;
    if (image.mimeType === 'image/webp') {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57454250) throw dataError('WebP画像が不正です');
      const kind = v.getUint32(12);
      if (kind === 0x56503858 && bytes.length >= 30) {
        size = { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
      } else if (kind === 0x56503820 && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        size = { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
      } else if (kind === 0x5650384c && bytes.length >= 25 && bytes[20] === 0x2f) {
        const bits = v.getUint32(21, true);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else throw dataError('WebP画像の寸法が不正です');
    } else size = tileImageSize(bytes);
    if (!size.width || !size.height || size.width > 4096 || size.height > 4096) throw dataError('GLB画像が大きすぎます');
  }
  const rtc = json.extensions?.CESIUM_RTC?.center;
  if (rtc !== undefined && (!Array.isArray(rtc) || rtc.length !== 3 || !rtc.every(Number.isFinite))) throw dataError('GLBの位置が不正です');
  return rtc ?? null;
}

// --- tileset.json のツリー走査 --------------------------------------------

function resolveUri(baseUrl, uri) {
  if (typeof uri !== 'string' || uri.length > 2048) throw dataError('タイルのURIが不正です');
  const url = assertRemoteUrl(new URL(uri, baseUrl).href);
  if (new URL(url).hostname !== 'api.plateauview.mlit.go.jp') throw dataError('PLATEAUの取得先が不正です');
  return url;
}

// region [west, south, east, north, minH, maxH] (経緯度はラジアン、高さはm)
function regionInfo(region) {
  if (!Array.isArray(region) || region.length !== 6 || !region.every(Number.isFinite)
      || region[0] < -Math.PI || region[2] > Math.PI || region[1] < -Math.PI / 2 || region[3] > Math.PI / 2
      || region[0] > region[2] || region[1] > region[3] || region[4] > region[5]) throw dataError('タイルの範囲が不正です');
  const [w, s, e, n, minH, maxH] = region;
  const toDeg = 180 / Math.PI;
  return {
    lon: ((w + e) / 2) * toDeg,
    lat: ((s + n) / 2) * toDeg,
    west: w * toDeg, south: s * toDeg, east: e * toDeg, north: n * toDeg,
    minH, maxH,
  };
}

// 矩形(度)と region が重なるか。region が無いノードは判定できないので通す
function regionIntersects(region, bbox) {
  if (!region || !bbox) return true;
  const r = regionInfo(region);
  return !(r.east < bbox.west || r.west > bbox.east
        || r.north < bbox.south || r.south > bbox.north);
}

// tileset を再帰的にたどり、実データ(b3dm)を持つ末端タイルの一覧を返す。
// 外部 tileset (.json を content に持つノード) は展開する。
//
// bbox で範囲外の枝を切ることが重要。全国版 (all-bldg-...) は市区町村ごとの
// 外部 tileset を441件ぶら下げているので、絞らないと441回 fetch することになる。
async function collectLeafTiles(tilesetUrl, bbox, depth = 0, out = [], budget = { files: 0, nodes: 0, visited: new Set() }) {
  if (depth > 6 || ++budget.files > 64) throw dataError('タイル一覧の取得件数が上限を超えています');
  if (budget.visited.has(tilesetUrl)) return out;
  budget.visited.add(tilesetUrl);
  const tileset = await fetchJson(tilesetUrl, { maxBytes: 2 * 1024 * 1024 });

  const walk = async (node, treeDepth = 0) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || ++budget.nodes > 20000 || treeDepth > 24) throw dataError('タイル一覧の構造が不正です');
    if (!regionIntersects(node.boundingVolume?.region, bbox)) return;
    const uri = node.content?.uri ?? node.content?.url;
    const children = node.children ?? [];
    if (!Array.isArray(children) || children.length > 4096) throw dataError('タイルの子要素が不正です');
    if (uri && /\.json(\?|$)/.test(uri)) {
      // 外部 tileset。そちらを開いて続きを拾う
      await collectLeafTiles(resolveUri(tilesetUrl, uri), bbox, depth + 1, out, budget);
      return;
    }
    if (children.length === 0) {
      // 末端。ここが実際に描く対象
      if (uri && node.boundingVolume?.region) {
        if (out.length >= 10000) throw dataError('建物タイルが多すぎます');
        out.push({
          url: resolveUri(tilesetUrl, uri),
          region: regionInfo(node.boundingVolume.region),
        });
      }
      return;
    }
    // 中間ノードは refine:REPLACE で子に置き換わるため、自身の content は使わない
    for (const c of children) await walk(c, treeDepth + 1);
  };

  await walk(tileset.root);
  return out;
}

// --- 読み込み本体 ----------------------------------------------------------

let gltfLoader = null;
function getLoader() {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(draco);
  return gltfLoader;
}

// b3dm を Range で「glTF部分だけ」取得する。Range が使えない場合は全体を取りに行く
async function fetchGlb(url, stats) {
  const head = await fetchResource(url, { headers: { Range: 'bytes=0-27' }, maxBytes: MAX_B3DM_BYTES });
  let full = head.bytes;
  if (head.status === 206) {
    if (head.bytes.byteLength !== 28) throw dataError('b3dmヘッダー範囲が一致しません');
    const { byteLength, glbOffset, glbLength } = parseB3dmHeader(head.bytes.buffer);
    const body = await fetchResource(url, {
      headers: { Range: `bytes=${glbOffset}-${glbOffset + glbLength - 1}` }, maxBytes: MAX_B3DM_BYTES,
    });
    if (body.status === 206) {
      if (body.bytes.byteLength !== glbLength) throw dataError('GLBの受信量が一致しません');
      stats.fullBytes += byteLength;
      stats.fetchedBytes += glbLength + 28;
      return body.bytes.buffer;
    }
    full = body.bytes;
  }
  const { byteLength, glbOffset, glbLength } = parseB3dmHeader(full.buffer);
  if (full.byteLength !== byteLength) throw dataError('b3dmの受信量が一致しません');
  stats.fullBytes += byteLength;
  stats.fetchedBytes += full.byteLength;
  stats.rangeMisses++;
  return full.buffer.slice(glbOffset, glbOffset + glbLength);
}

/**
 * PLATEAU の建築物 LOD1 を読み込む。
 *
 * @param {object} opts
 * @param {string} [opts.cityCode] 5桁市区町村コード(例 '13101' = 千代田区)。
 *   省略すると全国版(`all`)を使い、基準点の座標から自動でその市区町村のタイルを引き当てる。
 *   通常はエリアの座標から選ぶため省略する
 * @param {number} opts.centerLon  基準点の経度(terrain と同じ値を渡すこと)
 * @param {number} opts.centerLat  基準点の緯度
 * @param {number} opts.radiusM    この距離内のタイルを読む(m)
 * @param {number} opts.maxTiles   読み込むタイル数の上限(負荷の保険)
 * @param {number} [opts.lod=1]    1 = 箱のみ(テクスチャ無し) / 2 = 写真テクスチャ付き
 * @param {boolean} [opts.texture=true] LOD2 のときテクスチャ付きの配信を選ぶか
 * @param {(done:number,total:number,msg:string)=>void} [opts.onProgress]
 * @returns {Promise<{group:THREE.Group, stats:object}>}
 *   group.position.y にジオイド高の補正を入れると標高基準に揃う
 */
export async function loadBuildings({
  cityCode, centerLon, centerLat, radiusM = 3000, maxTiles = 6,
  lod = 1, texture = true, onProgress,
}) {
  if ((cityCode && !/^\d{2}(?:\d{3})?$/.test(cityCode)) || ![1, 2].includes(lod)
      || ![centerLon, centerLat, radiusM].every(Number.isFinite) || centerLon < 122 || centerLon > 148
      || centerLat < 24 || centerLat > 46 || radiusM <= 0 || radiusM > 10000
      || !Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > 24) throw dataError('建物の取得範囲が不正です');
  const stats = {
    tilesInTileset: 0, tilesLoaded: 0, buildings: 0, vertices: 0, textured: 0,
    fullBytes: 0, fetchedBytes: 0, rangeMisses: 0, ms: 0,
  };
  const t0 = performance.now();
  const report = (done, total, msg) => onProgress && onProgress(done, total, msg);

  // 配信の spec は <範囲>-bldg-lod<N>[-texture|-notexture]-latest。
  // <範囲> は 'all'(全国) / 2桁都道府県コード / 5桁市区町村コード。
  // LOD1 はテクスチャ指定を受け付けない(そもそも持っていない)
  const area = cityCode || 'all';
  const spec = lod >= 2
    ? `${area}-bldg-lod${lod}-${texture ? 'texture' : 'notexture'}-latest`
    : `${area}-bldg-lod${lod}-latest`;
  stats.spec = spec;

  const mPerDegLat = 111132;
  const mPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  // 走査を絞る矩形。全国版でも、ここで範囲外の市区町村を切るので fetch は数回で済む
  const bbox = {
    west:  centerLon - radiusM / mPerDegLon,
    east:  centerLon + radiusM / mPerDegLon,
    south: centerLat - radiusM / mPerDegLat,
    north: centerLat + radiusM / mPerDegLat,
  };

  report(0, 1, 'tileset.json を取得中');
  const all = await collectLeafTiles(`${CATALOG}/${spec}/tileset.json`, bbox);
  stats.tilesInTileset = all.length;

  // 基準点からの距離でタイルを絞る(緯度の縮尺を考慮した簡易距離)
  const withDist = all.map((t) => ({
    ...t,
    dist: Math.hypot((t.region.lon - centerLon) * mPerDegLon, (t.region.lat - centerLat) * mPerDegLat),
  })).sort((a, b) => a.dist - b.dist);

  const targets = withDist.filter((t) => t.dist <= radiusM).slice(0, maxTiles);

  // PLATEAU は全国が整備されているわけではない。範囲外は「建物が無い」だけで、
  // 飛行そのものは成立する。エラーにせず空の group を返す
  stats.covered = targets.length > 0;
  stats.nearestM = withDist.length > 0 ? Math.round(withDist[0].dist) : null;
  if (!stats.covered) {
    report(1, 1, 'この範囲に PLATEAU の整備データがありません');
    stats.ms = Math.round(performance.now() - t0);
    return { group: new THREE.Group(), stats };
  }

  const toLocal = makeEcefToLocalMatrix(centerLon, centerLat);
  // 3D Tiles の glTF は Y-up。ECEF(Z-up)に合わせるため X 軸まわりに +90度回す
  const yUpToZUp = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const loader = getLoader();
  const group = new THREE.Group();
  group.name = 'plateau-buildings';

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    report(i, targets.length, `建物タイル ${i + 1}/${targets.length}`);
    try {
      const glb = await fetchGlb(t.url, stats);
      const rtc = readRtcCenter(glb);
      const gltf = await loader.parseAsync(glb, '');

      // CESIUM_RTC 中心を足してから、ECEF→ローカルへ落とす
      const place = new THREE.Matrix4().copy(toLocal);
      if (rtc) place.multiply(new THREE.Matrix4().makeTranslation(rtc[0], rtc[1], rtc[2]));
      place.multiply(yUpToZUp);

      gltf.scene.applyMatrix4(place);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        stats.vertices += o.geometry.attributes.position.count;
        // GLTFLoader は未知の属性名を小文字化するため、両方の綴りを見る
        const batchId = o.geometry.attributes._batchid || o.geometry.attributes._BATCHID;
        if (batchId) stats.buildings += new Set(batchId.array).size;

        // テクスチャを持つマテリアル(LOD2)はそのまま使う。上書きすると写真が消える。
        // 持たないもの(LOD1、LOD2の一部の面)だけ、見やすい単色に差し替える
        if (o.material?.map) {
          stats.textured++;
        } else {
          o.material = new THREE.MeshLambertMaterial({
            color: 0xc8c8c0,
            vertexColors: !!o.geometry.attributes.color,
          });
        }
        o.castShadow = false;
        o.receiveShadow = false;
      });
      group.add(gltf.scene);
      stats.tilesLoaded++;
    } catch (err) {
      console.warn('建物タイルの読み込みに失敗:', t.url, err);
    }
  }

  report(targets.length, targets.length, '完了');
  stats.ms = Math.round(performance.now() - t0);
  return { group, stats };
}

/**
 * 建物の底面と地形の標高を突き合わせて、ジオイド高(楕円体高 - 標高)を推定する。
 *
 * 建物は地面に建っているので「格子内で最も低い頂点 ≒ その場所の地面の楕円体高」とみなし、
 * 地理院DEMの標高との差の中央値をとる。中央値なので一部の外れ値には影響されない。
 *
 * @param {THREE.Group} group      loadBuildings が返した group(まだ y をずらしていない状態)
 * @param {(x:number,z:number)=>number} getHeight  terrain.js の getHeight
 * @param {number} [cell=100]      格子の一辺(m)
 * @returns {{offset:number, samples:number, spread:number}|null}
 *   offset: 推定ジオイド高(m)。group.position.y = -offset で標高基準に揃う
 *   spread: サンプルのばらつき(四分位範囲)。大きいときは推定を信用しない
 */
export function estimateGeoidOffset(group, getHeight, cell = 100) {
  const lowest = new Map(); // "gx_gz" -> {x, z, y}
  const v = new THREE.Vector3();

  group.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const key = `${Math.floor(v.x / cell)}_${Math.floor(v.z / cell)}`;
      const cur = lowest.get(key);
      if (!cur || v.y < cur.y) lowest.set(key, { x: v.x, z: v.z, y: v.y });
    }
  });

  const diffs = [];
  for (const p of lowest.values()) {
    const ground = getHeight(p.x, p.z);
    if (Number.isFinite(ground)) diffs.push(p.y - ground);
  }
  if (diffs.length < 4) return null;

  diffs.sort((a, b) => a - b);
  const q = (f) => diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * f))];
  return { offset: q(0.5), samples: diffs.length, spread: q(0.75) - q(0.25) };
}
