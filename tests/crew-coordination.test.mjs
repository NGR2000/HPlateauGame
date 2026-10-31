import test from 'node:test';
import assert from 'node:assert/strict';
import {overheadBalloon,approachingPz,createCrewCoordination} from '../game/prototype/crewCoordination.js';
import {createTeamPilot,predictStep,segmentViolation} from '../game/prototype/creativeAirspace.js';
const pos={x:0,y:0,z:0},windAt=()=>({vx:3,vz:0,kt:6});
const empty={ceiling:600,zones:[]};

test('overhead reply is a single named nearest balloon; lower, distant and above-goal traffic is excluded',()=>{
  const traffic=[{name:'上',x:0,y:150,z:0},{name:'近い赤',x:10,y:70,z:0},
    {name:'下',x:0,y:-10,z:0},{name:'遠い',x:80,y:20,z:0},{name:'高すぎる',x:0,y:600,z:0}];
  assert.equal(overheadBalloon(pos,200,traffic).name,'近い赤');
  assert.equal(overheadBalloon(pos,20,traffic),null);
});
test('large climb waits for a stopped crew reply; blocked report earns points once and recheck does not farm points',()=>{
  let traffic=[{name:'赤の2号気球',x:0,y:100,z:0}];const messages=[];
  const crew=createCrewCoordination({airspace:empty,windAt,getTraffic:()=>traffic,onRadio:m=>messages.push(m)});
  assert.equal(crew.update(pos,200,.1).target,0);
  assert.equal(crew.card(false),null);assert.equal(crew.reply(false),null);
  assert.match(crew.card(true).label,/赤の2号気球/);
  assert.equal(crew.reply(true).points,50);assert.equal(crew.reply(true),null);
  for(let i=0;i<20;i++)assert.equal(crew.update(pos,200,1).target,0);
  assert.equal(messages.length,1);
  traffic=[];crew.update(pos,200,.1);
  assert.equal(crew.card(true).label,'上空クリアです。');
  assert.equal(crew.reply(true).points,0);
  assert.equal(crew.update(pos,200,.1).target,200);
  crew.update({...pos,y:195},200,1);assert.equal(crew.card(true),null);
  crew.update({...pos,y:195},400,1);assert.equal(crew.reply(true).points,50);
});
test('traffic is rechecked on send and a new obstruction suspends an approved climb',()=>{
  let traffic=[];const crew=createCrewCoordination({airspace:empty,windAt,getTraffic:()=>traffic});
  crew.update(pos,200,.1);assert.equal(crew.card(true).label,'上空クリアです。');
  traffic=[{name:'橙の3号気球',x:0,y:100,z:0}];
  assert.match(crew.reply(true).message,/橙の3号気球/);
  assert.equal(crew.update(pos,200,.1).target,0);
  traffic=[];crew.update(pos,200,.1);crew.reply(true);
  traffic=[{name:'紫の4号気球',x:0,y:130,z:0}];
  assert.equal(crew.update({...pos,y:60},200,.1).target,60);
  assert.match(crew.card(true).label,/紫の4号気球/);
});
test('PZ attention is time-based, early enough for climbing and reply, with no distant or irrelevant messages',()=>{
  const red={id:'red',name:'駅',type:'red',x:1000,z:0,radius:100,altitude:300};
  const near=approachingPz(pos,400,{ceiling:600,zones:[red]},windAt);
  assert.ok(near);assert.ok(near.lead>=300/2+90);assert.ok(near.eta>150);
  assert.equal(approachingPz(pos,400,{...empty,zones:[{...red,x:6000}]},windAt),null);
  assert.equal(approachingPz(pos,400,{...empty,zones:[red]},()=>({vx:-3,vz:0})),null);
  assert.equal(approachingPz({...pos,y:400},400,{...empty,zones:[red]},windAt),null);
  assert.equal(approachingPz(pos,400,{...empty,zones:[{...red,type:'yellow'}]},windAt),null);
  assert.ok(approachingPz({...pos,y:200},200,{...empty,zones:[{...red,type:'blue',altitude:150,x:600}]},windAt));
});
test('PZ warning is shared once and holding cannot continue into a prohibited region',()=>{
  const zone={id:'r',name:'駅',type:'red',x:800,z:0,radius:100,altitude:300};
  const messages=[],crew=createCrewCoordination({airspace:{...empty,zones:[zone]},windAt,onRadio:m=>messages.push(m)});
  crew.update({...pos,y:80},100,.1);assert.equal(crew.card(true).kind,'pz');
  assert.equal(crew.reply(true).points,50);
  for(let i=0;i<10;i++)crew.update({...pos,y:80},100,2);
  assert.equal(crew.card(true),null);assert.equal(messages.length,1);
  const close=createCrewCoordination({airspace:{...empty,zones:[{...zone,x:150}]},windAt});
  assert.ok(close.update(pos,400,.1).blocked);
});
test('team pilot with crew checks still flies the red-PZ route within the ceiling after timely replies',()=>{
  const airspace={ceiling:600,zones:[{id:'r',name:'駅',type:'red',x:1200,z:0,radius:200,altitude:300}]};
  const pilot=createTeamPilot({windAt,getHeight:()=>0,airspace,crewCheck:true,targetX:2200});
  let s={...pos,vy:0,heat:.5,grounded:true},crossed=false,answered=0;
  for(let t=0;t<700;t+=.2){
    const control=pilot.control(s,s.vy,.2,s.heat);assert.ok(!control.blocked,`blocked at ${t}`);
    if(pilot.crewCard(true)&&Math.floor(t)%10===0){pilot.replyCrew(true);answered++;}
    const next=predictStep(s,.2,control,windAt,()=>0);
    assert.equal(segmentViolation(s,next,airspace,()=>0),null);
    if(Math.abs(next.x-1200)<200)crossed=true;
    assert.ok(next.y+28<=600);s=next;
  }
  assert.ok(answered);assert.ok(crossed);
});
