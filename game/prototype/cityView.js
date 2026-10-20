import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG, cityZones, creativeLaunch } from './cityLayout.js';

const materials = new Map();
const material = color => {
  if (!materials.has(color)) materials.set(color, new THREE.MeshLambertMaterial({ color }));
  return materials.get(color);
};
const boxGeometry = new THREE.BoxGeometry(1,1,1);
const crownGeometry = new THREE.IcosahedronGeometry(1,0);
const roofGeometry = new THREE.CylinderGeometry(0,1,1,4);
const templeRoofGeometry = new THREE.BufferGeometry();
// Hipped roof with a long ridge; reused by the hall and the gate.
const roofVertices=[[-.5,0,-.5],[.5,0,-.5],[.5,0,.5],[-.5,0,.5],[-.28,1,0],[.28,1,0]];
templeRoofGeometry.setAttribute('position',new THREE.Float32BufferAttribute(
  [0,4,5,0,5,1,1,5,2,2,5,4,2,4,3,3,4,0].flatMap(i=>roofVertices[i]),3));
templeRoofGeometry.computeVertexNormals();
function box(g,w,h,d,x,y,z,color) {
  const mesh = new THREE.Mesh(boxGeometry, material(color));
  mesh.scale.set(w,h,d); mesh.position.set(x,y,z); g.add(mesh); return mesh;
}
function tree(g,x,z,size=1) {
  box(g,.65*size,5*size,.65*size,x,2.5*size,z,'#7c6a50');
  const crown = new THREE.Mesh(crownGeometry,material('#6f925c'));
  crown.scale.set(4*size,4.8*size,4*size); crown.position.set(x,8*size,z); g.add(crown);
}
function procedural(type,color) {
  const g=new THREE.Group(), c=CATALOG[type];
  if (type === 'tree') { tree(g,0,0); return g; }
  if (type === 'park') {
    for (const [x,z,s] of [[-34,-32,1],[32,-36,1.1],[-32,30,1.2],[33,29,.9],[-8,38,1],[25,0,.9]]) tree(g,x,z,s);
    box(g,5,.6,1.4,0,.6,14,'#9a7750');
    return g;
  }
  if (type === 'plaza' || type === 'road') return g;
  if (type === 'temple') {
    const roof=(w,d,h,y,z)=>{
      box(g,w,.8,d,0,y,z,'#394744');
      const mesh=new THREE.Mesh(templeRoofGeometry,material('#394744'));
      mesh.scale.set(w,h,d);mesh.position.set(0,y,z);g.add(mesh);
      box(g,w*.56,.6,1,0,y+h,z,'#465550');
    };
    box(g,58,1.8,38,0,.9,-30,'#b8b7a5');
    box(g,50,10,30,0,6.8,-32,'#e0d9c3');
    for(const x of [-23,-15,-7,7,15,23])box(g,1.1,10,1.1,x,6.8,-13,'#9b624b');
    for(const x of [-15,0,15])box(g,7,6,.3,x,4.8,-16.8,'#586460');
    roof(70,44,9,12,-30);
    for(let i=0;i<3;i++)box(g,26-i*2,.5,3,0,.25+i*.5,-8-i*2,'#b8b7a5');
    // The gate has a broad, unobstructed central passage for chase cars.
    for(const x of [-14,14]){
      box(g,7,1,11,x,.5,40,'#b8b7a5');
      for(const z of [36,44])box(g,1.4,10,1.4,x,5,z,'#9b624b');
    }
    box(g,32,1.4,8,0,9.5,40,'#9b624b');
    roof(38,16,5,10.5,40);
    for(const x of [-27,27])for(const z of [-2,16,34])tree(g,x,z,.9);
    return g;
  }
  box(g,c.width,c.height-3,c.depth,0,(c.height-3)/2,0,color);
  if (type === 'house' || type === 'warehouse') {
    const roof=new THREE.Mesh(roofGeometry,material(type==='house'?'#806e61':'#6b7f80'));
    roof.rotation.y=Math.PI/4; roof.scale.set(c.width/Math.SQRT2+1,4,c.depth/Math.SQRT2+1);
    roof.position.y=c.height-2; g.add(roof);
  } else box(g,c.width+1,1,c.depth+1,0,c.height-2.5,0,'#647d79');
  for (const side of [-1,1]) {
    for(let x=-c.width/2+3;x<c.width/2-1;x+=5)box(g,2,2,.15,x,3,side*(c.depth/2+.08),'#63868e');
  }
  box(g,2.4,3,.2,0,1.5,c.depth/2+.15,'#6d6658');
  if(type==='shop')box(g,c.width*.85,.4,3,0,4.7,c.depth/2+1,'#bf8059');
  return g;
}

export async function loadCityModels(onWarning=()=>{}) {
  const loader=new GLTFLoader(), models=new Map();
  await Promise.all(Object.entries(CATALOG).filter(([,c])=>c.file).map(async([type,c])=>{
    try {
      const result=await loader.loadAsync(new URL(`./assets/${c.file}`,import.meta.url).href);
      result.scene.updateMatrixWorld(true);
      const bounds=new THREE.Box3().setFromObject(result.scene), size=bounds.getSize(new THREE.Vector3());
      // Keep source metre units. Exports are already centred at their ground datum.
      CATALOG[type].width=size.x; CATALOG[type].depth=size.z;
      CATALOG[type].height=bounds.max.y;
      models.set(type,result.scene);
    } catch(error) { onWarning(`${c.name}を読み込めませんでした。再読み込みしてください。`); }
  }));
  return models;
}

// Terrain-following surfaces prevent roads/plazas from disappearing into slopes.
function surface(item,getHeight,color,width,depth,owned,lift=.4) {
  const rows=Math.max(2,Math.ceil(depth/20)), cols=Math.max(2,Math.ceil(width/20));
  const geo=new THREE.PlaneGeometry(width,depth,cols,rows);
  geo.rotateX(-Math.PI/2);
  const p=geo.attributes.position, angle=item.rotation*Math.PI/180, co=Math.cos(angle),si=Math.sin(angle);
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),z=p.getZ(i),wx=item.x+x*co+z*si,wz=item.z-x*si+z*co;
    p.setXYZ(i,wx,getHeight(wx,wz)+lift,wz);
  }
  geo.computeVertexNormals(); owned.push(geo);
  return new THREE.Mesh(geo,material(color));
}
export function createCityView(city,getHeight,models) {
  const group=new THREE.Group(), pzGroup=new THREE.Group(), roots=[], owned=[];
  group.name='creative-city'; pzGroup.name='creative-pz-boundaries';
  for(const item of city.items) {
    const c=CATALOG[item.type], root=new THREE.Group();
    root.userData.cityId=item.id; root.name=`city-${item.type}`;
    if(['road','park','plaza'].includes(item.type)) {
      const w=c.width*item.scale,d=(item.length||c.depth)*item.scale;
      root.add(surface(item,getHeight,item.type==='road'?'#74817b':item.type==='park'?'#91ad79':'#d3cbb6',w,d,owned,
        item.type==='road' ? .7 : item.type==='park' ? .2 : .4));
      if(item.type==='road') {
        // Sparse centre marks, with open ends at every segment.
        for(let z=-d/2+8;z<d/2;z+=18){
          const a=item.rotation*Math.PI/180;
          root.add(surface({...item,x:item.x+Math.sin(a)*z,z:item.z+Math.cos(a)*z},getHeight,'#e9dfbd',.45,6,owned,.8));
        }
      }
    }
    if(item.type==='temple') {
      const a=item.rotation*Math.PI/180;
      root.add(surface({...item,x:item.x+Math.sin(a)*20*item.scale,z:item.z+Math.cos(a)*20*item.scale},
        getHeight,'#d7cfb8',16*item.scale,75*item.scale,owned,.65));
    }
    const body=models.has(item.type)?models.get(item.type).clone(true):procedural(item.type,item.color);
    body.position.set(item.x,getHeight(item.x,item.z),item.z);
    body.rotation.y=item.rotation*Math.PI/180; body.scale.setScalar(item.scale);
    root.add(body); group.add(root); roots.push(root);
  }
  const zones=cityZones(city,getHeight);
  for(const z of zones){
    const points=[];
    for(let i=0;i<=80;i++){
      const a=i/80*Math.PI*2,x=z.x+Math.cos(a)*z.radius,zz=z.z+Math.sin(a)*z.radius;
      points.push(new THREE.Vector3(x,getHeight(x,zz)+2,zz));
    }
    const geo=new THREE.BufferGeometry().setFromPoints(points);owned.push(geo);
    const mat=new THREE.LineBasicMaterial({color:z.type==='red'?0xe06d56:z.type==='blue'?0x639be1:0xe1b956});
    const line=new THREE.Line(geo,mat);line.userData.zone=z;pzGroup.add(line);
  }
  group.add(pzGroup);
  const lp=creativeLaunch();
  for(const [pos,color,r] of [[lp,'#e4c568',55],[{x:0,z:0},'#e8e3b9',65]]) {
    const geo=new THREE.RingGeometry(r-1,r,64);geo.rotateX(-Math.PI/2);owned.push(geo);
    const m=new THREE.Mesh(geo,material(color));m.position.set(pos.x,getHeight(pos.x,pos.z)+.5,pos.z);group.add(m);
  }
  return {group,roots,zones,pzGroup,dispose(){
    owned.forEach(g=>g.dispose());
    pzGroup.traverse(o=>o.material?.dispose());
    group.removeFromParent();
  }};
}

export function buildingBlocks(city,x,z,padding=3) {
  return city.items.some(item=>{
    if(['road','plaza','park','tree','tower'].includes(item.type))return false;
    const c=CATALOG[item.type],a=item.rotation*Math.PI/180,dx=x-item.x,dz=z-item.z;
    const lx=dx*Math.cos(a)-dz*Math.sin(a),lz=dx*Math.sin(a)+dz*Math.cos(a);
    if(item.type==='temple') {
      const hit=(cx,cz,w,d)=>Math.abs(lx-cx*item.scale)<w*item.scale/2+padding && Math.abs(lz-cz*item.scale)<d*item.scale/2+padding;
      return hit(0,-30,58,38)||hit(-14,40,7,11)||hit(14,40,7,11);
    }
    return Math.abs(lx)<c.width*item.scale/2+padding && Math.abs(lz)<c.depth*item.scale/2+padding;
  });
}
