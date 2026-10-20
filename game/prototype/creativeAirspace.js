// Game airspace only. All numeric altitudes are MSL metres.
export const BALLOON_HEIGHT = 28;
export const BALLOON_RADIUS = 12;
export const ALTITUDE_MARGIN = 25;
export function limitsAt(x,z,{ceiling,zones},padding=BALLOON_RADIUS) {
  let floor=-Infinity, top=ceiling-BALLOON_HEIGHT, yellow=false, name='';
  for(const zone of zones){
    if(Math.hypot(x-zone.x,z-zone.z)>zone.radius+padding)continue;
    if(zone.type==='red' && zone.altitude>floor){floor=zone.altitude;name=zone.name;}
    if(zone.type==='blue')top=Math.min(top,zone.altitude-BALLOON_HEIGHT);
    if(zone.type==='yellow')yellow=true;
  }
  return {floor,top,yellow,name};
}
export function flightViolation(pos,airspace,getHeight=()=>0) {
  const lim=limitsAt(pos.x,pos.z,airspace);
  if(pos.y>lim.top+1e-6)return '最高高度またはブルーPZの上限';
  if(pos.y<lim.floor-1e-6)return `${lim.name || 'レッドPZ'}の下限`;
  if(lim.yellow && pos.y<=getHeight(pos.x,pos.z)+.1)return 'イエローPZの離着陸制限';
  return null;
}
export function segmentViolation(a,b,airspace,getHeight=()=>0){
  const n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z)/5));
  for(let i=0;i<=n;i++){
    const t=i/n;
    const reason=flightViolation({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t},airspace,getHeight);
    if(reason)return reason;
  }
  return null;
}
// The pilot plans using the same heat/vertical motion as main.js, not teleportation.
export function heightControl(y,vy,heat,target){
  const desiredVy=Math.max(-2.5,Math.min(2.5,(target-y)*.10));
  const desiredHeat=.5+(desiredVy*.5+(desiredVy-vy)*.8)/7;
  return {burner:heat<desiredHeat+.006,rip:heat>desiredHeat+.04};
}
export function predictStep(state,dt,control,windAt,getHeight){
  const heat=Math.max(0,Math.min(1,state.heat+(control.burner ? .055 : 0)*dt-(control.rip ? .16 : 0)*dt-.012*dt));
  let vy=state.vy+(7*(heat-.5)-.5*state.vy)*dt;
  let y=state.y+vy*dt;
  const wind=windAt(y,state.x,state.z),grounded=state.grounded;
  const x=state.x+(grounded?0:wind.vx*dt),z=state.z+(grounded?0:wind.vz*dt);
  const ground=getHeight(x,z);
  if(y<=ground){y=ground;vy=Math.max(0,vy);}
  return {x,y,z,vy,heat,grounded:y<=ground+.05};
}
export function createTeamPilot({windAt,targetX=0,targetZ=0,airspace,getHeight=()=>0,onRadio=()=>{}}){
  let target=null,untilScan=0,drop=false,notified=false,previousMessage='',clearance=false;
  function pick(pos,vy,heat){
    const current=limitsAt(pos.x,pos.z,airspace);
    const candidates=new Set([80,120,160,210,260,310,360,410,460,510,550,target,current.top-50]);
    for(const z of airspace.zones) {
      if(z.type==='red')candidates.add(z.altitude+ALTITUDE_MARGIN+15);
      if(z.type==='blue')candidates.add(z.altitude-BALLOON_HEIGHT-50);
    }
    let best=null,bestScore=-Infinity;
    for(const alt of candidates){
      if(!Number.isFinite(alt)||alt<getHeight(pos.x,pos.z)+45||alt>current.top-25||alt<current.floor+ALTITUDE_MARGIN)continue;
      let s={...pos,vy,heat,grounded:pos.y<=getHeight(pos.x,pos.z)+.05},valid=true;
      // 150 seconds includes the climb and the downwind crossing, sampled at 0.5 s.
      for(let t=0;t<150;t+=.5){
        const next=predictStep(s,.5,heightControl(s.y,s.vy,s.heat,alt),windAt,getHeight);
        if(segmentViolation(s,next,airspace,getHeight) || next.y<getHeight(next.x,next.z)+1 && t>25){
          valid=false;break;
        }
        s=next;
      }
      if(!valid)continue;
      const gain=Math.hypot(pos.x-targetX,pos.z-targetZ)-Math.hypot(s.x-targetX,s.z-targetZ);
      const score=gain-Math.abs(alt-pos.y)*.10-(target!==null&&alt!==target?8:0);
      if(score>bestScore){best=alt;bestScore=score;}
    }
    if(best!==null){
      const msg=best>pos.y+40?'PZと最高高度を確認して、上の層の風へ移ります。'
        :best<pos.y-40?'最高高度とPZを確認して、低い層の風に移ります。':'この高度の風でターゲットを目指します。';
      if(msg!==previousMessage){onRadio(`パイロット：${msg}`);previousMessage=msg;}
    }
    clearance=best!==null;
    return best;
  }
  return {
    control(pos,vy,dt,heat=.5){
      untilScan-=dt;
      if(untilScan<=0||target===null){target=pick(pos,vy,heat);untilScan=4;}
      if(target===null)return {burner:false,rip:true,blocked:true};
      return heightControl(pos.y,vy,heat,target);
    },
    shouldDrop(pos){return !drop&&clearance&&Math.hypot(pos.x-targetX,pos.z-targetZ)<=400;},
    markDropped(){drop=true;},
    dropNotice(pos){
      if(drop||notified)return null;
      const w=windAt(pos.y,pos.x,pos.z),dx=targetX-pos.x,dz=targetZ-pos.z;
      const speed=Math.hypot(w.vx,w.vz),dist=Math.hypot(dx,dz);
      const seconds=(dist-400)/speed;
      if(speed<.1||dx*w.vx+dz*w.vz<=0||seconds>60)return null;
      notified=true;return Math.max(0,seconds);
    },
    cruiseFt:()=>target===null?null:target*3.28084,
  };
}
