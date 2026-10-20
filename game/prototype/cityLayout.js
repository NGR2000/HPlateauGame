// Shared city data for the editor and the game. Coordinates are metres, Y is MSL.
export const CITY_KEY = 'creative-city-v1';
export const CITY_LIMIT = 240;
export const CITY_BOUNDS = { minX: -4500, maxX: 3500, minZ: -3000, maxZ: 5000 };
export const CATALOG = {
  station: { name: '東京駅', width: 335.58, depth: 38.52, height: 35, file: 'tokyo_station.glb', pz: 300, radius: 230 },
  tower: { name: '東京タワー', width: 88.22, depth: 88.22, height: 334, file: 'tokyo_tower.glb', pz: 450, radius: 210 },
  sports: { name: 'スポーツ施設', width: 28.6, depth: 45.8, height: 15.7, file: 'sports_center.glb' },
  exterior: { name: '提供ビル', width: 8, depth: 9, height: 36.2, file: 'exterior.glb', pz: 120, radius: 65 },
  house: { name: '切妻屋根の家', width: 16, depth: 13, height: 10 },
  shop: { name: '街角の店', width: 23, depth: 16, height: 9 },
  warehouse: { name: '倉庫', width: 28, depth: 20, height: 12 },
  temple: { name: 'お寺', width: 76, depth: 120, height: 22, yellow: true },
  park: { name: '木立の公園', width: 100, depth: 110, height: 12 },
  plaza: { name: '広場', width: 130, depth: 100, height: 0.2 },
  road: { name: '通り', width: 24, depth: 160, height: 0.2 },
  tree: { name: '木', width: 8, depth: 8, height: 12 },
};
export function creativeLaunch() {
  // Same 1500 ft wind interpolation as the existing default flight (205° FROM).
  const bearing = 25 * Math.PI / 180;
  return { x: -3000 * Math.sin(bearing), z: 3000 * Math.cos(bearing) };
}
export function routePoint(t, offset = 0) {
  const launch = creativeLaunch();
  const dx = -launch.x / 3000, dz = -launch.z / 3000;
  return { x: launch.x * (1-t) - dz * offset, z: launch.z * (1-t) + dx * offset };
}
export function defaultCity() {
  const items = [];
  const yaw = -25;
  const add = (type, t, offset, extra = {}) => {
    const p = routePoint(t, offset);
    items.push({ id: `initial-${items.length}`, type, ...p, rotation: yaw, scale: 1, color: '#d7c5a5', ...extra });
  };
  // A broken avenue: plazas and green gaps remain open for joining from either side.
  for (let i = 0; i < 19; i++) {
    const t = .03 + i*.049;
    const a = routePoint(t,Math.sin(t*Math.PI*3)*35), b = routePoint(t+.049,Math.sin((t+.049)*Math.PI*3)*35);
    add('road',t,0,{x:(a.x+b.x)/2,z:(a.z+b.z)/2,length:Math.hypot(a.x-b.x,a.z-b.z)+2,rotation:Math.atan2(b.x-a.x,b.z-a.z)*180/Math.PI});
  }
  for (const offset of [155,455,755]) add('road',.66,offset,{rotation:65,length:302});
  add('road',.48,75,{rotation:65,length:150});
  add('road',.64,515,{rotation:-25,length:124});
  add('plaza', 0.02, 0, { scale: 1.6 });
  add('station', 0.48, 245, { rotation: -115 });
  add('plaza', 0.48, 125, { scale: 1.6 });
  add('tower', 0.62, 850);
  add('park', 0.62, 650, { scale: 1.8 });
  add('temple', .62, 610, {rotation:-115});
  add('park', .57, 560);
  add('plaza', .62, 515, {rotation:65,scale:.8});
  add('sports', 0.83, -155, { scale: 1.4 });
  add('plaza', 0.83, -80);
  for (const [t, offset, scale] of [[.40,170,1],[.43,160,1.4],[.55,190,1.6],[.56,260,1.2]]) {
    add('exterior', t, offset, { scale });
  }
  const colors = ['#e0c4a1','#c9d3bf','#d8b6a5','#e9d7b4','#a9c2c1'];
  for (const [start, type] of [[.10,'house'],[.24,'shop'],[.59,'house'],[.73,'house']]) {
    for (let i = 0; i < 4; i++) {
      add(type, start + i * .013, -65 - (i%2)*12, { color: colors[i] });
      if (i < 3) add(type === 'shop' ? 'shop' : 'house', start + .016 + i * .014, 65, { color: colors[4-i] });
    }
  }
  add('warehouse', .09, 100);
  for (const [t, o] of [[.19,-100],[.34,100],[.60,-100],[.90,100]]) add('park', t, o);
  for (let i = 0; i < 16; i++) add('tree', .08 + .05*i, i%2 ? -42 : 43);
  return { version: 1, ceiling: 600, items, zones: [] };
}
export function validateCity(value) {
  if (!value || value.version !== 1 || !Number.isFinite(value.ceiling)
    || value.ceiling < 200 || value.ceiling > 1500 || !Array.isArray(value.items)
    || value.items.length > CITY_LIMIT || !Array.isArray(value.zones) || value.zones.length > 40) {
    throw new Error('街のデータ形式が正しくありません。');
  }
  const ids = new Set();
  for (const item of [...value.items, ...value.zones]) {
    if (!item || typeof item.id !== 'string' || item.id.length > 100 || ids.has(item.id)) throw new Error('街のIDが重複しています。');
    ids.add(item.id);
    if (!Number.isFinite(item.x) || !Number.isFinite(item.z)
      || item.x < CITY_BOUNDS.minX || item.x > CITY_BOUNDS.maxX
      || item.z < CITY_BOUNDS.minZ || item.z > CITY_BOUNDS.maxZ) throw new Error('街の配置範囲を越えています。');
  }
  for (const item of value.items) {
    if (!Object.hasOwn(CATALOG,item.type) || !Number.isFinite(item.rotation) || Math.abs(item.rotation)>360
      || !Number.isFinite(item.scale) || item.scale<.5 || item.scale>2
      || !/^#[\da-f]{6}$/i.test(item.color)
      || (item.length !== undefined && (!Number.isFinite(item.length) || item.length<20 || item.length>500))) {
      throw new Error('建物の種類・大きさ・色を確認してください。');
    }
  }
  for (const z of value.zones) {
    if (!['red','yellow','blue'].includes(z.type) || !Number.isFinite(z.radius) || z.radius<30 || z.radius>1000
      || !Number.isFinite(z.altitude) || z.altitude<0 || z.altitude>2000) throw new Error('PZの設定を確認してください。');
  }
  return structuredClone(value);
}
export function loadCity(storage) {
  try {
    storage ??= globalThis.localStorage;
    const raw = storage.getItem(CITY_KEY);
    return { city: raw ? validateCity(JSON.parse(raw)) : defaultCity(), warning: '' };
  } catch {
    return { city: defaultCity(), warning: '保存した街を読めなかったため、初期の街を表示しています。保存データは上書きしていません。' };
  }
}
export function saveCity(city, storage = localStorage) {
  const clean = validateCity(city);
  storage.setItem(CITY_KEY, JSON.stringify(clean));
}
export function cityZones(city, getHeight = () => 0) {
  const generated = city.items.flatMap(item => {
    const c = CATALOG[item.type];
    if (!c.pz && !c.yellow) return [];
    return [{
      id: `pz-${item.id}`, name: c.name, type: c.yellow ? 'yellow' : 'red',
      x:item.x, z:item.z,
      radius: c.radius ? c.radius * item.scale : Math.hypot(c.width,c.depth)*item.scale/2 + 20,
      altitude: c.yellow ? 0 : Math.max(c.pz, getHeight(item.x,item.z) + c.height*item.scale + 80),
    }];
  });
  return [...generated, ...city.zones.map(z => ({...z, name: `${z.type.toUpperCase()} PZ`}))];
}
export function cityWarnings(city, getHeight = () => 0) {
  const zones = cityZones(city,getHeight), launch = creativeLaunch(), warnings = [];
  for (const z of zones) {
    if (z.type === 'red' && z.altitude+55 >= city.ceiling-50) warnings.push(`${z.name}：最高高度内では余裕を持って上空通過できません。周囲を回避します。`);
    if (Math.hypot(z.x-launch.x,z.z-launch.z) < z.radius+30 && z.type !== 'blue') warnings.push(`${z.name}が離陸広場に重なっています。移動してください。`);
    if (z.type === 'blue' && z.altitude < getHeight(z.x,z.z)+60) warnings.push(`${z.name}の下に飛行できる高さがありません。`);
  }
  for (const item of city.items) {
    if (['road','park','plaza','tree'].includes(item.type)) continue;
    const c=CATALOG[item.type], radius=Math.hypot(c.width,c.depth)*item.scale/2+35;
    if (Math.hypot(item.x-launch.x,item.z-launch.z)<radius || Math.hypot(item.x,item.z)<radius) {
      warnings.push(`${c.name}が離陸地またはターゲットの空間に重なっています。`);
    }
  }
  return [...new Set(warnings)];
}
