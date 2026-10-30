import test from 'node:test';
import assert from 'node:assert/strict';
import {createRadioObserver,createWindKnowledge,observationBonus,insideTargetZone,markerLanding} from '../game/prototype/radioObservation.js';
import {creativePoints,confirmationStatus} from '../game/prototype/chaseRules.js';
import {createTeamPilot} from '../game/prototype/creativeAirspace.js';

test('live observations require ten seconds; repeats require a fresh interval; movement, disappearance and respawn reset tracks',()=>{
  const observer=createRadioObserver(),car={x:0,z:0,speedMps:0};
  const balloon=t=>({id:'red',name:'赤',x:t,y:100,z:0});
  for(let t=0;t<10;t++)assert.equal(observer.update(t,car,[balloon(t)])[0].ready,false);
  assert.equal(observer.update(10,car,[balloon(10)])[0].ready,true);
  const report=observer.send('red',10);assert.equal(report.vx,1);assert.equal(report.vz,0);
  assert.equal(observer.send('red',10),null);
  for(let t=11;t<40;t++)assert.equal(observer.update(t,car,[balloon(t)])[0].ready,false);
  assert.equal(observer.update(40,car,[balloon(40)])[0].ready,true);
  assert.ok(observer.send('red',40));
  observer.update(41,{...car,speedMps:1},[balloon(41)]);
  assert.equal(observer.update(42,car,[balloon(42)])[0].ready,false);
  observer.update(43,car,[]);
  assert.equal(observer.update(44,car,[balloon(44)])[0].seconds,0);
  assert.equal(observer.update(45,car,[{...balloon(45),x:150}])[0].seconds,0);
  assert.equal(observer.update(46,car,[{...balloon(46),y:150}])[0].seconds,0);
});
test('wind knowledge is local to altitude, location and time; useful reports actually change pilot altitude',()=>{
  let time=10;
  const base=y=>({vx:y<200?2:1,vz:0});
  const knowledge=createWindKnowledge(base,()=>time);
  const pilot=createTeamPilot({windAt:base,forecastWindAt:knowledge.windAt,getHeight:()=>0,airspace:{ceiling:600,zones:[]},targetX:2000});
  const p={x:0,y:100,z:0};pilot.control(p,0,.1,.5);const original=pilot.cruiseFt();
  const report={source:'red',x:0,y:300,z:0,vx:6,vz:0,time,confidence:.9};
  const before=knowledge.snapshot();knowledge.add(report);pilot.suggestAltitude(300);pilot.control(p,0,.1,.5);
  assert.ok(pilot.cruiseFt()>200*3.28084);assert.notEqual(pilot.cruiseFt(),original);
  assert.equal(before(300,0,0).vx,1);assert.ok(knowledge.windAt(300,0,0).vx>5);
  assert.equal(knowledge.windAt(0,0,0).vx,2);assert.equal(knowledge.windAt(300,1600,0).vx,1);
  time=191;assert.equal(knowledge.windAt(300,0,0).vx,1);
});
test('bonus uses a subsequent measurement; redundant, wrong and unusable information earns no bonus',()=>{
  const actual={vx:3,vz:0},before={vx:1,vz:0};
  assert.equal(observationBonus({before,after:{vx:2.9,vz:0},actual,useful:true}),100);
  assert.equal(observationBonus({before:{vx:2.6,vz:0},after:{vx:2.8,vz:0},actual,useful:true}),50);
  assert.equal(observationBonus({before,after:before,actual,useful:true}),0);
  assert.equal(observationBonus({before,after:{vx:-1,vz:0},actual,useful:true}),0);
  assert.equal(observationBonus({before,after:actual,actual,useful:false}),0);
});
test('100m zone is inclusive; drop and landing are independent confirmations, never requiring a car inside',()=>{
  assert.ok(insideTargetZone({x:100,z:0}));assert.ok(!insideTargetZone({x:100.01,z:0}));
  const input={active:true,stopped:true,carDistance:150,dropped:true,landed:false,dropDistance:500};
  assert.ok(confirmationStatus(input).drop);
  assert.ok(!confirmationStatus({...input,carDistance:100}).drop);
  assert.ok(!confirmationStatus({...input,dropConfirmed:true}).drop);
  assert.ok(!confirmationStatus({...input,stopped:false}).drop);
  const landed={...input,landed:true,landingInZone:true};
  assert.ok(confirmationStatus(landed).landing);
  assert.ok(!confirmationStatus({...landed,landingConfirmed:true}).landing);
  assert.ok(!confirmationStatus({...landed,landingInZone:false}).landing);
  assert.ok(!confirmationStatus({...landed,carDistance:401}).landing);
  assert.equal(creativePoints({caught:true,dropConfirmed:true}).total,1050);
  assert.equal(creativePoints({caught:true}).total,1000);
  assert.equal(creativePoints({windPoints:140,reported:true,dropConfirmed:true}).total,240);
});
test('marker forecast follows the real terminal speed and horizontal drag instead of basket proximity',()=>{
  const wind=()=>({vx:3,vz:0});
  const landing=markerLanding({x:0,y:300,z:0},0,wind,()=>0);
  let x=0,y=300.8,vy=0;
  for(let t=0;t<100;t+=1/60){vy+=(-9.81-.981*vy)/60;y+=vy/60;x+=3/60;if(y<=0)break;}
  assert.ok(Math.abs(landing.x-x)<4);assert.equal(landing.z,0);
});
