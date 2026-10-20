import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCity, validateCity, cityZones, creativeLaunch, saveCity, loadCity } from '../game/prototype/cityLayout.js';
import { limitsAt, flightViolation, segmentViolation, createTeamPilot, predictStep, BALLOON_HEIGHT } from '../game/prototype/creativeAirspace.js';

test('saved city is independent of defaults and a corrupt save is preserved',()=>{
  const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
  const city=defaultCity();city.items[0].x+=100;saveCity(city,storage);
  assert.equal(loadCity(storage).city.items[0].x,city.items[0].x);
  assert.notEqual(defaultCity().items[0].x,city.items[0].x);
  data.set('creative-city-v1','broken');
  assert.ok(loadCity(storage).warning);
  assert.equal(data.get('creative-city-v1'),'broken');
  assert.throws(()=>validateCity({...city,ceiling:NaN}));
  assert.throws(()=>validateCity({...city,items:[...city.items,city.items[0]]}));
});
test('moving and scaling a tall building updates its red PZ in MSL',()=>{
  const city=defaultCity(),tower=city.items.find(i=>i.type==='tower');
  tower.x+=100;tower.scale=2;
  const z=cityZones(city,()=>100).find(z=>z.id===`pz-${tower.id}`);
  assert.equal(z.x,tower.x);assert.equal(z.altitude,100+334*2+80);
  assert.equal(z.radius,420);
});
test('red floor, blue ceiling and yellow landing restrictions intersect correctly',()=>{
  const airspace={ceiling:600,zones:[
    {type:'red',x:0,z:0,radius:100,altitude:300},
    {type:'blue',x:0,z:0,radius:100,altitude:500},
    {type:'yellow',x:300,z:0,radius:40,altitude:0},
  ]};
  assert.equal(limitsAt(0,0,airspace).floor,300);
  assert.equal(limitsAt(0,0,airspace).top,500-BALLOON_HEIGHT);
  assert.ok(flightViolation({x:0,z:0,y:299},airspace));
  assert.equal(flightViolation({x:0,z:0,y:350},airspace),null);
  assert.ok(flightViolation({x:0,z:0,y:480},airspace));
  assert.equal(flightViolation({x:300,z:0,y:50},airspace),null);
  assert.ok(flightViolation({x:300,z:0,y:0},airspace));
  assert.ok(segmentViolation({x:-200,y:100,z:0},{x:200,y:100,z:0},airspace));
});
test('pilot climbs before a red PZ and does not exceed the region ceiling',()=>{
  const airspace={ceiling:600,zones:[{type:'red',name:'駅',x:1200,z:0,radius:200,altitude:300}]};
  const windAt=()=>({vx:3,vz:0,kt:6}),getHeight=()=>10;
  const pilot=createTeamPilot({windAt,getHeight,airspace,targetX:2000,targetZ:0});
  let s={x:0,y:10,z:0,vy:0,heat:.5,grounded:true},crossed=false;
  for(let t=0;t<700;t+=.1){
    const ctrl=pilot.control(s,s.vy,.1,s.heat);
    assert.ok(!ctrl.blocked,`unexpected blocked route at ${t}`);
    const next=predictStep(s,.1,ctrl,windAt,getHeight);
    assert.equal(segmentViolation(s,next,airspace,getHeight),null,`violation at ${t}`);
    if(Math.abs(next.x-1200)<200){crossed=true;assert.ok(next.y>=300);}
    assert.ok(next.y+BALLOON_HEIGHT<=600);s=next;
  }
  assert.ok(crossed);
});
test('no vertical gap: pilot refuses route instead of exceeding ceiling',()=>{
  const airspace={ceiling:250,zones:[{type:'red',x:200,z:0,radius:100,altitude:300}]};
  const pilot=createTeamPilot({windAt:()=>({vx:3,vz:0,kt:6}),getHeight:()=>0,airspace,targetX:1000,targetZ:0});
  assert.equal(pilot.control({x:0,y:100,z:0},0,.1,.5).blocked,true);
});
test('default launch and initial city permit a flight using the preset wind',()=>{
  const city=defaultCity(),lp=creativeLaunch(),getHeight=()=>5;
  const airspace={ceiling:city.ceiling,zones:cityZones(city,getHeight)};
  const rows=[[0,140,3],[500,160,5],[1000,190,7],[2000,220,10],[3000,240,13],[5000,260,17]];
  const windAt=y=>{
    const ft=y*3.28084;
    let a=rows[0],b=rows.at(-1);
    if(ft<=a[0])b=a;else for(let i=0;i<rows.length-1;i++)if(ft>=rows[i][0]&&ft<rows[i+1][0]){a=rows[i];b=rows[i+1];break;}
    const t=a===b?0:(ft-a[0])/(b[0]-a[0]),angle=(a[1]+(b[1]-a[1])*t+180)*Math.PI/180,kt=a[2]+(b[2]-a[2])*t;
    return {vx:Math.sin(angle)*kt*.514444,vz:-Math.cos(angle)*kt*.514444,kt};
  };
  const pilot=createTeamPilot({windAt,getHeight,airspace});
  let s={...lp,y:5,vy:0,heat:.5,grounded:true},best=3000;
  for(let t=0;t<1200;t+=.2){
    const ctrl=pilot.control(s,s.vy,.2,s.heat);
    assert.ok(!ctrl.blocked,`blocked at ${t}, position ${JSON.stringify(s)}`);
    const next=predictStep(s,.2,ctrl,windAt,getHeight);
    assert.equal(segmentViolation(s,next,airspace,getHeight),null);
    s=next;best=Math.min(best,Math.hypot(s.x,s.z));
    if(pilot.shouldDrop(s))break;
  }
  assert.ok(best<=400,`closest approach ${best}m`);
});
