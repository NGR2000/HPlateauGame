// Observation uses simulation seconds; button expiry uses real milliseconds. Positions/heights stay in metres.
export const MARKER_DRAG = 9.81/10;
export const MARKER_WIND_TAU = 1.5;
export const OBSERVATION_SECONDS = 3;
export const TARGET_OBSERVATION_SECONDS = OBSERVATION_SECONDS;
export const TARGET_OBSERVATION_RADIUS = 200;
export const REPORT_HOLD_MS = 5000;
export const TARGET_ZONE_RADIUS = 100;
export const insideTargetZone = (p, target={x:0,z:0}) => Math.hypot(p.x-target.x,p.z-target.z)<=TARGET_ZONE_RADIUS;
export function createWindKnowledge(baseWind, now=()=>0) {
  let reports=[];
  const build=records=>(y,x=0,z=0)=>{
    const base=baseWind(y,x,z), t=now();
    let best=null,weight=0;
    for(const r of records){
      const age=t-r.time;
      const w=age>=0&&age<180 ? Math.min(1,(180-age)/120)*Math.max(0,Math.min(1,(120-Math.abs(y-r.y))/90))*Math.max(0,Math.min(1,(1500-Math.hypot(x-r.x,z-r.z))/700))*r.confidence : 0;
      if(w>weight){best=r;weight=w;}
    }
    if(!best)return base;
    const origin=baseWind(best.y,best.x,best.z);
    const vx=base.vx+(best.vx-origin.vx)*weight,vz=base.vz+(best.vz-origin.vz)*weight;
    return {...base,vx,vz,kt:Math.hypot(vx,vz)/.514444,dir:(Math.atan2(-vx,vz)*180/Math.PI+360)%360};
  };
  return {
    windAt:(...args)=>build(reports)(...args),
    snapshot:()=>build(reports.map(r=>({...r}))),
    add(r){reports=reports.filter(v=>now()-v.time<180&&v.source!==r.source);reports.push({...r});},
  };
}
export function createRadioObserver({now=()=>performance.now()}={}){
  const tracks=new Map(), sent={near:new Set(),target:new Set()};
  let choices=[],lastCar=null,pending=null, mode=null;
  function expire(){
    if(pending&&now()>=pending.until){pending=null;tracks.clear();choices=[];}
  }
  function capture(id){
    expire();
    if(pending)return pending.choice.id===id?pending.choice:null;
    const choice=choices.find(b=>b.id===id);
    if(!choice?.ready)return null;
    const report=Object.freeze({...choice.report,crewX:lastCar.x,crewZ:lastCar.z});
    const frozen=Object.freeze({...choice,x:report.x,y:report.y,z:report.z,report});
    pending={choice:frozen,until:now()+REPORT_HOLD_MS};choices=[frozen];
    return frozen;
  }
  return {
    update(time,car,balloons,target={x:0,z:0}){
      lastCar={x:car.x,z:car.z,speedMps:car.speedMps};
      expire();
      if(pending)return [pending.choice];
      const nextMode=Math.hypot(car.x-target.x,car.z-target.z)<=TARGET_OBSERVATION_RADIUS?'target':'near';
      if(mode!==nextMode){tracks.clear();mode=nextMode;}
      const requiredSeconds=mode==='target'?TARGET_OBSERVATION_SECONDS:OBSERVATION_SECONDS;
      const radius=200;
      const ids=new Set(balloons.map(b=>b.id));
      for(const id of tracks.keys())if(!ids.has(id))tracks.delete(id);
      choices=balloons.filter(b=>!sent[mode].has(b.id)&&Math.hypot(car.x-b.x,car.z-b.z)<=radius).map(b=>{
        let track=tracks.get(b.id);
        // Reset on discontinuities (including fleet respawns), motion or altitude changes.
        if(!track||Math.abs(car.speedMps)>.05||time-track.lastTime>1||Math.hypot(car.x-track.carX,car.z-track.carZ)>5||Math.hypot(b.x-track.lastX,b.z-track.lastZ)>25||Math.abs(b.y-track.y)>30){
          track={x:b.x,y:b.y,z:b.z,carX:car.x,carZ:car.z,samples:[],time,lastTime:time,lastX:b.x,lastZ:b.z};tracks.set(b.id,track);
        }
        track.lastTime=time;track.lastX=b.x;track.lastZ=b.z;
        track.samples.push({time,x:b.x,y:b.y,z:b.z});
        while(track.samples.length>2&&track.samples[1].time<=time-requiredSeconds)track.samples.shift();
        const sample=track.samples[0],span=time-sample.time;
        const duration=time-track.time;
        const ready=duration>=requiredSeconds&&Math.abs(car.speedMps)<=.05;
        return {...b,seconds:Math.min(requiredSeconds,duration),requiredSeconds,mode,ready,
          report:ready?{mode,source:b.id,name:b.name,x:(b.x+sample.x)/2,z:(b.z+sample.z)/2,y:(b.y+sample.y)/2,
            vx:(b.x-sample.x)/span,vz:(b.z-sample.z)/span,time,confidence:.9}:null};
      });
      const nearby=new Set(choices.map(b=>b.id));
      for(const id of tracks.keys())if(!nearby.has(id))tracks.delete(id);
      return choices;
    },
    choices:()=>{expire();return choices;},
    capture,
    pending:()=>{expire();return pending?.choice||null;},
    send(id,time){
      expire();
      if(!lastCar||Math.abs(lastCar.speedMps)>.05)return null;
      const choice=capture(id);if(!choice)return null;
      const report=choice.report;
      sent[report.mode].add(id);
      pending=null;tracks.clear();
      // Each balloon has one independent report in each observation area.
      choices=[];
      // The pilot receives the measured vector as a new message, not an observation timestamp.
      return {...report,time};
    },
  };
}
// Judge with a later, independent movement interval, not the sample used to fit the model.
export function observationBonus({before,after,actual,useful}){
  if(!useful)return 0;
  const oldError=Math.hypot(before.vx-actual.vx,before.vz-actual.vz),newError=Math.hypot(after.vx-actual.vx,after.vz-actual.vz);
  const gain=oldError-newError;
  if(gain<.1||oldError<.2||newError>oldError*.8)return 0;
  return gain>=.5?100:50;
}
export function markerLanding(pos,vy,windAt,getHeight){
  let {x,y,z}=pos, wind=windAt(y,x,z),vx=wind.vx,vz=wind.vz;
  y+=.8;
  for(let t=0;t<240;t+=.5){
    wind=windAt(y,x,z);
    vy+=(-9.81-MARKER_DRAG*vy)*.5;
    vx+=(wind.vx-vx)/MARKER_WIND_TAU*.5;vz+=(wind.vz-vz)/MARKER_WIND_TAU*.5;
    x+=vx*.5;z+=vz*.5;y+=vy*.5;
    if(y<=getHeight(x,z))return {x,z};
  }
  return {x,z};
}
