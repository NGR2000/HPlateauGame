import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTerrain } from './terrain.js';
import { CATALOG, CITY_LIMIT, loadCity, saveCity, validateCity, defaultCity, cityWarnings } from './cityLayout.js';
import { loadCityModels, createCityView } from './cityView.js';

const $=id=>document.getElementById(id);
let {city,warning}=loadCity(),selected=null,mode='select',placing=null,dirty=false,cityView=null,outline=null;
const history=[],view=$('view');
const scene=new THREE.Scene();scene.background=new THREE.Color('#bfd4d6');
scene.add(new THREE.HemisphereLight(0xe8f4ed,0x758461,1.5));
const sun=new THREE.DirectionalLight(0xffedcf,1.9);sun.position.set(-2000,3500,1500);scene.add(sun);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));view.append(renderer.domElement);
const camera=new THREE.PerspectiveCamera(48,1,1,30000);
const controls=new OrbitControls(camera,renderer.domElement);controls.maxPolarAngle=Math.PI*.48;controls.minDistance=35;controls.maxDistance=10000;
controls.screenSpacePanning=true;controls.mouseButtons={LEFT:THREE.MOUSE.PAN,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.ROTATE};
const errors=[];
let terrain,models;
try {
  [terrain,models]=await Promise.all([
    buildTerrain(130.25,33.27,2,(done,total)=>{$('loading').textContent=`街の地形を準備しています ${done}/${total}`;},
      {imagery:false,lowMemory:true,maxTextureSize:renderer.capabilities.maxTextureSize,onStatus:s=>{if(s.missingDem||s.missingPhotos)errors.push('一部の地形を取得できず簡易表示になっています。再読み込みで再試行できます。');}}),
    loadCityModels(text=>errors.push(text)),
  ]);
} catch(e) {
  $('loading').textContent='街を読み込めませんでした。通信を確認して再読み込みしてください。';
  throw e;
}
scene.add(terrain.group);
$('loading').hidden=true;
$('status').textContent=warning||errors.join(' ');
function mark(){history.push(JSON.stringify(city));if(history.length>30)history.shift();dirty=true;$('undo').disabled=false;}
function message(text){$('status').textContent=text;}
function setMode(next,type=null){
  mode=next;placing=type;
  $('mode').textContent=next==='place'?`${CATALOG[type].name}：置く場所をクリック`:
    next==='move'?'移動先の地面をクリック':next==='pz'?'PZの中心をクリック':'建物をクリックして選択 · ドラッグで移動';
  for(const b of $('palette').children)b.classList.toggle('active',next==='place'&&b.dataset.type===type);
}
function syncProperties(){
  const item=city.items.find(i=>i.id===selected);
  $('properties').disabled=!item;
  $('selection').value=item?.id||'';
  if(!item)return;
  for(const k of ['x','z','rotation','scale','color'])$(`item-${k}`).value=typeof item[k]==='number'?Math.round(item[k]*10)/10:item[k];
  $('length-field').hidden=item.type!=='road';
  $('item-length').value=item.length||160;
  $('color-field').hidden=!!CATALOG[item.type].file||['road','park','plaza','tree','temple'].includes(item.type);
}
function highlight(){
  if(outline){outline.geometry.dispose();outline.material.dispose();scene.remove(outline);outline=null;}
  const root=cityView.roots.find(o=>o.userData.cityId===selected);
  if(root){outline=new THREE.BoxHelper(root,0xf2c55f);scene.add(outline);}
}
function rebuild(){
  cityView?.dispose();
  cityView=createCityView(city,terrain.getHeight,models);scene.add(cityView.group);
  cityView.pzGroup.visible=$('zones').getAttribute('aria-pressed')==='true';
  $('selection').replaceChildren(new Option('選択してください',''));
  for(const [i,item] of city.items.entries())$('selection').add(new Option(`${i+1}. ${CATALOG[item.type].name}`,item.id));
  $('ceiling').value=city.ceiling;
  const warnings=cityWarnings(city,terrain.getHeight);
  $('warnings').replaceChildren(...warnings.map(text=>{const p=document.createElement('div');p.textContent=text;return p;}));
  $('zone-list').replaceChildren();
  for(const z of cityView.zones){
    const li=document.createElement('li');
    li.textContent=`${z.name} · ${z.type==='red'?'低空禁止':z.type==='blue'?'高空禁止':'離着陸禁止'}${z.type==='yellow'?'':` ${Math.round(z.altitude)}m MSL`}`;
    if(city.zones.some(a=>a.id===z.id)){
      const b=document.createElement('button');b.textContent='削除';b.onclick=()=>{mark();city.zones=city.zones.filter(a=>a.id!==z.id);rebuild();};li.append(b);
    }
    $('zone-list').append(li);
  }
  syncProperties();highlight();
}
function overview(){
  controls.target.set(-500,0,1450);camera.position.set(2500,3200,4500);controls.update();
}
function focus(){
  const item=city.items.find(i=>i.id===selected);if(!item)return;
  const c=CATALOG[item.type],d=Math.max(c.width,c.depth,c.height)*item.scale*2+35,y=terrain.getHeight(item.x,item.z);
  controls.target.set(item.x,y+c.height*item.scale/3,item.z);
  const a=item.rotation*Math.PI/180;
  camera.position.set(item.x+d*(.5*Math.cos(a)+Math.sin(a)),y+d*.55,
    item.z+d*(-.5*Math.sin(a)+Math.cos(a)));controls.update();
  terrain.requestDetail(item.x,item.z);
}
for(const [type,c] of Object.entries(CATALOG)){
  const button=document.createElement('button');button.textContent=c.name;button.dataset.type=type;
  button.onclick=()=>setMode('place',type);$('palette').append(button);
}
$('selection').onchange=()=>{selected=$('selection').value;setMode('select');syncProperties();highlight();};
for(const key of ['x','z','rotation','scale','length','color'])$(`item-${key}`).onchange=()=>{
  const item=city.items.find(i=>i.id===selected);if(!item)return;
  const next=structuredClone(city),changed=next.items.find(i=>i.id===selected);
  changed[key]=key==='color'?$(`item-${key}`).value:Number($(`item-${key}`).value);
  try{validateCity(next);mark();city=next;rebuild();}catch(e){message(e.message);syncProperties();}
};
$('move').onclick=()=>setMode('move');
$('delete').onclick=()=>{if(!selected)return;mark();city.items=city.items.filter(i=>i.id!==selected);selected=null;setMode('select');rebuild();};
$('duplicate').onclick=()=>{
  const item=city.items.find(i=>i.id===selected);if(!item||city.items.length>=CITY_LIMIT)return;
  const copy={...item,id:crypto.randomUUID(),x:item.x+25,z:item.z+25};
  try{validateCity({...city,items:[...city.items,copy]});mark();city.items.push(copy);selected=copy.id;rebuild();setMode('move');}catch(e){message(e.message);}
};
$('ceiling').onchange=()=>{
  const next={...city,ceiling:Number($('ceiling').value)};
  try{validateCity(next);mark();city=next;rebuild();}catch(e){message(e.message);$('ceiling').value=city.ceiling;}
};
$('add-pz').onclick=()=>setMode('pz');
$('pz-type').onchange=()=>{$('pz-altitude').disabled=$('pz-type').value==='yellow';};
$('undo').onclick=()=>{if(!history.length)return;city=JSON.parse(history.pop());dirty=true;selected=null;setMode('select');rebuild();$('undo').disabled=!history.length;};
$('reset').onclick=()=>{if(!confirm('編集内容を初期の街に戻しますか？ 保存するまでは保存済みの街は変わりません。'))return;mark();city=defaultCity();selected=null;rebuild();overview();message('初期の街に戻しました。保存すると次のプレイに反映されます。');};
$('save').onclick=()=>{
  try{saveCity(city);dirty=false;message('このブラウザに保存しました。「街で遊ぶ」から入ると反映されます。');}
  catch(e){message(`保存できませんでした。${e.message} 街を書き出して保管できます。`);}
};
$('play-link').onclick=e=>{if(dirty&&!confirm('未保存の変更があります。保存せず、保存済みの街で遊びますか？'))e.preventDefault();else if(dirty)dirty=false;};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
$('export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(city,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='creative-city.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('import').onchange=async()=>{
  try{const f=$('import').files[0];if(!f)return;if(f.size>500000)throw Error('500KB以下の街ファイルを選んでください。');
    const next=validateCity(JSON.parse(await f.text()));mark();city=next;selected=null;rebuild();message('街を読み込みました。保存すると次のプレイに反映されます。');
  }catch(e){message(`読み込めませんでした：${e.message}`);}finally{$('import').value='';}
};
$('overview').onclick=overview;$('focus').onclick=focus;
$('top').onclick=()=>{const t=controls.target;camera.position.set(t.x,t.y+Math.max(300,camera.position.distanceTo(t)),t.z+1);controls.update();};
$('zones').onclick=()=>{const show=$('zones').getAttribute('aria-pressed')!=='true';$('zones').setAttribute('aria-pressed',String(show));cityView.pzGroup.visible=show;};
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();let down=null;
renderer.domElement.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};});
renderer.domElement.addEventListener('pointercancel',()=>{down=null;});
renderer.domElement.addEventListener('pointerup',e=>{
  if(!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>6){down=null;return;}down=null;
  const rect=renderer.domElement.getBoundingClientRect();
  mouse.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(mouse,camera);
  if(mode==='select'){
    let o=ray.intersectObjects(cityView.roots,true)[0]?.object;
    while(o&&!o.userData.cityId)o=o.parent;
    selected=o?.userData.cityId||null;syncProperties();highlight();return;
  }
  const hit=ray.intersectObject(terrain.group,true)[0];if(!hit)return;
  const x=Math.round(hit.point.x/5)*5,z=Math.round(hit.point.z/5)*5,next=structuredClone(city);
  let newId=selected;
  if(mode==='place'){
    newId=crypto.randomUUID();
    next.items.push({id:newId,type:placing,x,z,rotation:0,scale:1,color:'#d7c5a5'});
  }else if(mode==='move'){
    const item=next.items.find(i=>i.id===selected);if(!item)return;Object.assign(item,{x,z});
  }else if(mode==='pz'){
    next.zones.push({id:crypto.randomUUID(),type:$('pz-type').value,x,z,radius:Number($('pz-radius').value),altitude:Number($('pz-altitude').value)});
  }
  try{validateCity(next);mark();city=next;selected=newId;setMode('select');rebuild();}catch(e){message(e.message);}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape')setMode('select');});
new ResizeObserver(()=>{
  const w=view.clientWidth,h=view.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();
}).observe(view);
rebuild();overview();setMode('select');
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
