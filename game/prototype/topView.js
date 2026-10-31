import * as THREE from 'three';

// 平行投影で高さによる水平位置のずれをなくす。北(-Z)が画面の上。
export function createTopView({element,isActive}) {
  const camera=new THREE.OrthographicCamera(-360,360,360,-360,0.5,40000);
  camera.up.set(0,0,-1);
  let zoom=1;
  const pointers=new Map();
  const change=factor=>{zoom=THREE.MathUtils.clamp(zoom*factor,.2,6);};
  element.addEventListener('wheel',event=>{
    if(!isActive())return;
    event.preventDefault();
    change(Math.exp(THREE.MathUtils.clamp(event.deltaY,-300,300)*.002));
  },{passive:false});
  element.addEventListener('pointerdown',event=>{
    if(!isActive()||event.pointerType!=='touch')return;
    element.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  });
  element.addEventListener('pointermove',event=>{
    if(!isActive()){pointers.clear();return;}
    const previous=pointers.get(event.pointerId);
    if(!previous)return;
    const next={x:event.clientX,y:event.clientY};
    if(pointers.size===2){
      const other=[...pointers.entries()].find(([id])=>id!==event.pointerId)[1];
      const before=Math.hypot(previous.x-other.x,previous.y-other.y);
      const after=Math.hypot(next.x-other.x,next.y-other.y);
      if(before>5&&after>5)change(before/after);
    }
    pointers.set(event.pointerId,next);
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])
    element.addEventListener(name,event=>pointers.delete(event.pointerId));
  window.addEventListener('blur',()=>pointers.clear());
  return {
    camera,
    reset(){zoom=1;pointers.clear();},
    update(car,aspect,highest=car.y){
      const half=360*zoom;
      camera.left=-half*Math.max(1,aspect);
      camera.right=-camera.left;
      camera.top=half*Math.max(1,1/aspect);
      camera.bottom=-camera.top;
      camera.updateProjectionMatrix();
      camera.position.set(car.x,Math.max(car.y,highest)+2000,car.z);
      camera.lookAt(car.x,car.y,car.z);
      camera.updateMatrixWorld();
    },
  };
}
