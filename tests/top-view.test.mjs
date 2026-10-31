import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createTopView} from '../game/prototype/topView.js';
import {updateTeamLabel} from '../game/prototype/teamLabels.js';

test('top view aligns horizontal positions across altitude, tracks the car and keeps north up on either aspect',()=>{
  globalThis.window=new EventTarget();
  const element=new EventTarget();
  const view=createTopView({element,isActive:()=>true});
  for(const aspect of [16/9,9/16]){
    const car={x:123,y:15,z:-456};
    view.update(car,aspect,1000);
    const low=new THREE.Vector3(153,15,-396).project(view.camera);
    const high=new THREE.Vector3(153,900,-396).project(view.camera);
    assert.ok(Math.abs(low.x-high.x)<1e-10);
    assert.ok(Math.abs(low.y-high.y)<1e-10);
    assert.ok(new THREE.Vector3(car.x,car.y,car.z).project(view.camera).length()<1.01);
    const north=new THREE.Vector3(car.x,15,car.z-100).project(view.camera);
    assert.ok(north.y>0);
    assert.ok(view.camera.right>=360&&view.camera.top>=360);
    car.x+=100;car.z+=200;view.update(car,aspect,1000);
    const center=new THREE.Vector3(car.x,car.y,car.z).project(view.camera);
    assert.ok(Math.abs(center.x)+Math.abs(center.y)<1e-10);
  }
});
test('zoom only changes the active top view and reset restores the initial field; ortho labels stay readable',()=>{
  globalThis.window=new EventTarget();
  const element=new EventTarget();let active=false;
  const view=createTopView({element,isActive:()=>active});
  const car={x:0,y:0,z:0};
  const wheel=()=>{const e=new Event('wheel',{cancelable:true});e.deltaY=-300;element.dispatchEvent(e);return e;};
  view.update(car,1);wheel();view.update(car,1);assert.equal(view.camera.top,360);
  active=true;assert.equal(wheel().defaultPrevented,true);
  view.update(car,1);assert.ok(view.camera.top<360);
  const label=new THREE.Sprite();label.userData={pixelWidth:28,pixelHeight:30};
  updateTeamLabel(label,view.camera,900);
  assert.ok(Math.abs(label.scale.y/(view.camera.top-view.camera.bottom)*900-30)<1e-10);
  view.reset();view.update(car,1);assert.equal(view.camera.top,360);
});
