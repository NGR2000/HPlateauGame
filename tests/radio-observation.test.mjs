import test from 'node:test';
import assert from 'node:assert/strict';
import {createRadioObserver as createObserver,createWindKnowledge,observationBonus,insideTargetZone,markerLanding} from '../game/prototype/radioObservation.js';
import {creativePoints,confirmationStatus} from '../game/prototype/chaseRules.js';
import {createTeamPilot,predictStep} from '../game/prototype/creativeAirspace.js';

// Existing capture/physics cases run in the outside-target observation area.
function createRadioObserver(options){
  const observer=createObserver(options),update=observer.update;
  observer.update=(time,car,balloons)=>update(time,car,balloons,{x:10000,z:0});
  return observer;
}
test('outside observations require three seconds and reset on movement, disappearance, respawn and altitude changes',()=>{
  const observer=createRadioObserver(),car={x:0,z:0,speedMps:0};
  const balloon=t=>({id:'red',name:'赤',x:t,y:100,z:0});
  for(let t=0;t<3;t++)assert.equal(observer.update(t,car,[balloon(t)])[0].ready,false);
  assert.equal(observer.update(3,car,[balloon(3)])[0].ready,true);
  const report=observer.send('red',3);assert.equal(report.vx,1);assert.equal(report.vz,0);
  assert.equal(observer.send('red',3),null);
  assert.deepEqual(observer.update(11,car,[balloon(11)]),[]);
  const other=t=>({...balloon(t),id:'blue'});
  observer.update(12,{...car,speedMps:1},[other(12)]);
  assert.equal(observer.update(13,car,[other(13)])[0].ready,false);
  observer.update(14,car,[]);
  assert.equal(observer.update(15,car,[other(15)])[0].seconds,0);
  assert.equal(observer.update(16,car,[{...other(16),x:150}])[0].seconds,0);
  assert.equal(observer.update(17,car,[{...other(17),y:150}])[0].seconds,0);
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

test('fresh live wind reports improve an actual marker landing in a paired approach with identical physics',()=>{
  const base=y=>({vx:y<180?3:1,vz:y<180?.5:2,kt:6});
  const actual=y=>y<180?base(y):({vx:6,vz:0,kt:12});
  function fly(sendReports){
    let time=0,nextReport=0;
    const knowledge=createWindKnowledge(base,()=>time);
    const pilot=createTeamPilot({windAt:actual,forecastWindAt:knowledge.windAt,planMarker:true,
      getHeight:()=>0,airspace:{ceiling:600,zones:[]},targetX:1200});
    let state={x:0,y:300,z:0,vy:0,heat:.5,grounded:false};
    for(;time<600;time+=.2){
      if(sendReports&&time+1e-6>=nextReport){
        nextReport+=180;const w=actual(300);
        knowledge.add({source:'observed-balloon',x:state.x,z:state.z,y:300,time,vx:w.vx,vz:w.vz,confidence:.9});
        pilot.suggestAltitude(300);
      }
      const control=pilot.control(state,state.vy,.2,state.heat);
      assert.ok(!control.blocked);
      state=predictStep(state,.2,control,actual,()=>0);
      assert.ok(state.y+28<=600);
      if(pilot.shouldDrop(state)){
        const landing=markerLanding(state,state.vy,actual,()=>0);
        return Math.hypot(landing.x-1200,landing.z);
      }
    }
    throw Error('No marker drop in the approach');
  }
  const without=fly(false),withReports=fly(true);
  assert.ok(withReports<100,`reported approach misses by ${withReports}m`);
  assert.ok(withReports<without-30,`report ${withReports}m versus no report ${without}m`);
});


test('each balloon can report once in each area, in either order, without shared cooldown or travel',()=>{
 for(const first of ['target','near']){
  const observer=createObserver(),car={x:first==='target'?200:201,z:0,speedMps:0};
  const balloons=['red','blue'].map(id=>({id,name:id,x:200,y:100,z:0}));
  const duration=3;
  for(let t=0;t<=duration;t++)observer.update(t,car,balloons);
  assert.equal(observer.send('red',duration).mode,first);
  // A different balloon remains eligible without waiting three minutes or moving.
  for(let t=duration+1;t<=duration*2+1;t++)observer.update(t,car,balloons);
  assert.equal(observer.send('blue',duration*2+1).mode,first);
  assert.deepEqual(observer.update(duration*2+2,car,balloons),[]);
  car.x=first==='target'?201:200;
  const secondDuration=3;
  for(let t=100;t<=100+secondDuration;t++)observer.update(t,car,balloons);
  assert.ok(observer.send('red',100+secondDuration));
  for(let t=200;t<=200+secondDuration;t++)observer.update(t,car,balloons);
  assert.ok(observer.send('blue',200+secondDuration));
  assert.deepEqual(observer.update(250,car,balloons),[]);
  car.x=first==='target'?200:201;
  assert.deepEqual(observer.update(251,car,balloons),[]);
 }
});
test('200m boundary selects one area; both ranges are 200m and crossing restarts observation',()=>{
 const observer=createObserver(),car={x:200,z:0,speedMps:0};
 const balloons=[{id:'edge',x:400,y:100,z:0},{id:'far',x:400.01,y:100,z:0}];
 for(let t=0;t<3;t++){
  const choices=observer.update(t,car,balloons);
  assert.equal(choices.length,1);assert.equal(choices[0].ready,false);
  assert.equal(choices[0].requiredSeconds,3);assert.equal(choices[0].mode,'target');
 }
 assert.equal(observer.update(3,car,balloons)[0].ready,true);
 car.x=200.01;
 const near=[{id:'edge',x:400.01,y:100,z:0},{id:'far',x:400.02,y:100,z:0}];
 for(let t=4;t<7;t++){
  const choices=observer.update(t,car,near);
  assert.equal(choices.length,1);assert.equal(choices[0].ready,false);
  assert.equal(choices[0].requiredSeconds,3);
 }
 assert.equal(observer.update(7,car,near)[0].ready,true);
 car.x=200;
 assert.equal(observer.update(10,car,balloons)[0].seconds,0);
 assert.equal(observer.update(10,car,balloons)[0].mode,'target');
});
test('captured target report retains its area and data across the boundary; expiry consumes no quota',()=>{
 let wall=0;const observer=createObserver({now:()=>wall}),car={x:200,z:0,speedMps:0};
 const b={id:'red',name:'赤',x:300,y:100,z:0};
 for(let t=0;t<=20;t++)observer.update(t,car,[b]);
 const captured=observer.capture('red');assert.equal(captured.mode,'target');
 observer.update(21,{...car,x:201},[]);
 assert.equal(observer.send('red',21).mode,'target');
 for(let t=22;t<=32;t++)observer.update(t,{...car,x:201},[b]);
 assert.equal(observer.capture('red').mode,'near');
 wall=5000;assert.equal(observer.pending(),null);
 for(let t=33;t<=43;t++)observer.update(t,{...car,x:201},[b]);
 assert.equal(observer.send('red',43).mode,'near');
});

test('a completed observation is held without rejudging traffic and transmits the captured data',()=>{
 let wall=0;
 const observer=createRadioObserver({now:()=>wall}),car={x:0,z:0,speedMps:0};
 for(let t=0;t<=3;t++)observer.update(t,car,[{id:'red',name:'赤',x:t,y:100+t,z:0}]);
 const pending=observer.capture('red');
 assert.ok(pending);assert.equal(pending.report.vx,1);
 wall=4000;
 observer.update(200,{x:900,z:0,speedMps:1},[]);
 assert.equal(observer.pending(),pending);
 assert.equal(observer.choices()[0].name,'赤');assert.equal(observer.choices()[0].y,101.5);
 assert.equal(observer.send('red',200),null); // A parked car is still required to transmit.
 observer.update(201,{x:900,z:0,speedMps:0},[{id:'red',name:'別名',x:2000,y:900,z:0}]);
 const report=observer.send('red',201);
 assert.equal(report.name,'赤');assert.equal(report.y,101.5);assert.equal(report.vx,1);
 assert.equal(report.crewX,0);assert.equal(report.time,201);
 assert.equal(observer.pending(),null);assert.equal(observer.send('red',201),null);
});
test('the held button expires after five real seconds, even without advancing the simulation',()=>{
 let wall=0;
 const observer=createRadioObserver({now:()=>wall}),car={x:0,z:0,speedMps:0};
 for(let t=0;t<=3;t++)observer.update(t,car,[{id:'red',name:'赤',x:t,y:100,z:0}]);
 observer.capture('red');wall=4999;assert.ok(observer.pending());
 wall=5000;assert.equal(observer.pending(),null);assert.equal(observer.send('red',10),null);
 assert.equal(observer.update(10,car,[{id:'red',name:'赤',x:10,y:100,z:0}])[0].ready,false);
 for(let t=11;t<=20;t++)observer.update(t,car,[{id:'red',name:'赤',x:t,y:100,z:0}]);
 assert.ok(observer.capture('red')); // Expiry without sending did not consume the report quota.
});
