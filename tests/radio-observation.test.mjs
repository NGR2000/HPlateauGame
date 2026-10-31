import test from 'node:test';
import assert from 'node:assert/strict';
import {createRadioObserver,createWindKnowledge,observationBonus,insideTargetZone,markerLanding} from '../game/prototype/radioObservation.js';
import {creativePoints,confirmationStatus} from '../game/prototype/chaseRules.js';
import {createTeamPilot,predictStep} from '../game/prototype/creativeAirspace.js';

test('live observations require ten seconds; repeats require a fresh interval; movement, disappearance and respawn reset tracks',()=>{
  const observer=createRadioObserver(),car={x:0,z:0,speedMps:0};
  const balloon=t=>({id:'red',name:'赤',x:t,y:100,z:0});
  for(let t=0;t<10;t++)assert.equal(observer.update(t,car,[balloon(t)])[0].ready,false);
  assert.equal(observer.update(10,car,[balloon(10)])[0].ready,true);
  const report=observer.send('red',10);assert.equal(report.vx,1);assert.equal(report.vz,0);
  assert.equal(observer.send('red',10),null);
  for(let t=11;t<=190;t++)assert.equal(observer.update(t,car,[balloon(t)])[0].ready,false);
  const moved={...car,x:300};
  for(let t=191;t<201;t++)assert.equal(observer.update(t,moved,[balloon(t)])[0].ready,false);
  assert.equal(observer.update(201,moved,[balloon(201)])[0].ready,true);
  assert.ok(observer.send('red',201));
  observer.update(202,{...moved,speedMps:1},[balloon(202)]);
  assert.equal(observer.update(203,moved,[balloon(203)])[0].ready,false);
  observer.update(204,moved,[]);
  assert.equal(observer.update(205,moved,[balloon(205)])[0].seconds,0);
  assert.equal(observer.update(206,moved,[{...balloon(206),x:150}])[0].seconds,0);
  assert.equal(observer.update(207,moved,[{...balloon(207),y:150}])[0].seconds,0);
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


test('all balloons share both the 180-second and 300-metre limits, including exact boundaries',()=>{
  const observer=createRadioObserver(),car={x:0,z:0,speedMps:0};
  const balloons=t=>['red','blue'].map(id=>({id,name:id,x:t+150,y:100,z:0}));
  for(let t=0;t<=10;t++)observer.update(t,car,balloons(t));
  assert.ok(observer.send('red',10));
  assert.equal(observer.send('blue',10),null);
  // Moving far enough does not remove the time requirement.
  for(let t=11;t<190;t++)assert.ok(!observer.update(t,{...car,x:300},balloons(t))[1].ready);
  assert.equal(observer.update(190,{...car,x:300},balloons(190))[1].ready,true);
  // Passing enough time does not remove the distance requirement.
  assert.equal(observer.update(190,{...car,x:299.99},balloons(190))[1].ready,false);
  assert.equal(observer.update(191,{...car,x:300},balloons(191))[1].ready,true);
  const report=observer.send('blue',191);
  assert.equal(report.crewX,300);assert.equal(report.crewZ,0);
  assert.equal(observer.send('red',191),null);
  // Returning to the last sending point still requires moving away again.
  for(let t=192;t<=371;t++)assert.equal(observer.update(t,{...car,x:300},balloons(150))[0].ready,false);
});


test('waiting three minutes still reports the most recent ten seconds of movement',()=>{
 const observer=createRadioObserver(),car={x:0,z:0,speedMps:0};
 for(let t=0;t<=10;t++)observer.update(t,car,[{id:'b',name:'b',x:0,y:100,z:0}]);
 assert.ok(observer.send('b',10));
 for(let t=11;t<=190;t++)observer.update(t,{...car,x:300},[{id:'b',name:'b',x:300+Math.max(0,t-180)*2,y:100,z:0}]);
 const report=observer.send('b',190);
 assert.ok(report);assert.equal(report.vx,2);assert.equal(report.x,310);
});
