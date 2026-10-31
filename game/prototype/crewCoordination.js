// Game rules: all coordinates/altitudes are metres; all timers are simulation seconds.
export const LARGE_CLIMB = 60; // About 200ft. Small altitude corrections need no new request.
export const OVERHEAD_RADIUS = 50;
const ENVELOPE_HEIGHT = 28;
const HEIGHT_MARGIN = 25;
const pzName=z=>z.name?.includes('PZ')?z.name:`${z.name||'前方の'}PZ`;

export function overheadBalloon(pos,goal,balloons) {
  return balloons.filter(b=>b.y>pos.y+1&&b.y<=goal+ENVELOPE_HEIGHT&&
    Math.hypot(b.x-pos.x,b.z-pos.z)<=OVERHEAD_RADIUS)
    .sort((a,b)=>a.y-b.y||Math.hypot(a.x-pos.x,a.z-pos.z)-Math.hypot(b.x-pos.x,b.z-pos.z))[0]||null;
}
function entryTime(pos,velocity,zone) {
  const dx=pos.x-zone.x,dz=pos.z-zone.z,r=zone.radius+32;
  const c=dx*dx+dz*dz-r*r;
  if(c<=0)return 0;
  const a=velocity.vx**2+velocity.vz**2,b=dx*velocity.vx+dz*velocity.vz,disc=b*b-a*c;
  if(a<.01||b>=0||disc<0)return Infinity;
  return c/(-b+Math.sqrt(disc));
}
export function approachingPz(pos,goal,airspace,windAt) {
  let nearest=null;
  for(const z of airspace.zones){
    if(z.type==='yellow')continue; // Yellow alone does not prohibit overflight.
    const change=z.type==='red'?z.altitude+40-pos.y:Math.max(pos.y,goal)+ENVELOPE_HEIGHT-(z.altitude-HEIGHT_MARGIN);
    if(z.type==='red'&&pos.y>=z.altitude+HEIGHT_MARGIN||change<=0)continue;
    const velocities=[pos.y,(pos.y+goal)/2,goal].map(y=>windAt(y,pos.x,pos.z));
    const eta=Math.min(...velocities.map(w=>entryTime(pos,w,z)));
    // Allow for a conservative 2m/s climb/descent, thermal lag, stopping/reply and margin.
    const lead=Math.max(120,change/2+30+45+45);
    if(eta>lead+30)continue; // No distant PZ messages in this release.
    if(!nearest||eta<nearest.eta)nearest={...z,eta,lead,key:z.id||`${z.type}:${z.x}:${z.z}:${z.radius}`};
  }
  return nearest;
}
export function createCrewCoordination({airspace,windAt,getTraffic=()=>[],onRadio=()=>{}}){
  let time=0,scanAt=0,threat=null,climb=null,serial=0,lastPos=null;
  const sharedPz=new Set(),notifiedPz=new Set();
  const announceClimb=()=>onRadio(`パイロット：${threat?`${pzName(threat)}への対応を考え、`:''}約${Math.round(climb.goal*3.28084/50)*50}ftへ上昇したいです。車を止めて上空確認をお願いします。`);
  return {
    update(pos,goal,dt){
      time+=dt;lastPos={...pos};
      if(time>=scanAt){threat=approachingPz(pos,goal,airspace,windAt);scanAt=time+2;}
      if(threat&&threat.eta<=threat.lead&&!notifiedPz.has(threat.key)&&!sharedPz.has(threat.key)){
        notifiedPz.add(threat.key);
        onRadio(`パイロット：${pzName(threat)}（${threat.type==='red'?'低空制限':'高空制限'}）に接近する見込みです。余裕をもって高度と進入経路を確認します。`);
      }
      if(climb&&goal<=pos.y+20){climb=null;}
      if(climb?.approved&&pos.y>=climb.goal-15)climb=null;
      const needsClimb=goal-pos.y>=LARGE_CLIMB;
      if(!climb&&needsClimb){
        climb={id:++serial,goal,holdY:pos.y,pending:true,approved:false,scored:false,requestedAt:time};
        announceClimb();
      }
      if(climb){
        // An approval covers the agreed climb, not an unrelated higher altitude.
        if(climb.approved&&goal>climb.goal+LARGE_CLIMB){
          climb={id:++serial,goal,holdY:pos.y,pending:true,approved:false,scored:false,requestedAt:time};announceClimb();
        }
        if(!climb.approved)climb.goal=goal;
        const other=overheadBalloon(pos,Math.max(goal,climb.goal),getTraffic());
        if(climb.approved&&other){
          climb.approved=false;climb.pending=true;climb.holdY=pos.y;climb.requestedAt=time;
          onRadio('パイロット：上昇方向の状況が変わりました。上昇を控えます。もう一度上空確認をお願いします。');
        }
        if(!climb.approved&&!climb.pending&&!other){
          climb.pending=true;climb.requestedAt=time;
          onRadio('パイロット：上空の状況が変わりました。再確認をお願いします。');
        }
        if(!climb.approved){
          if(threat&&threat.eta<=45)return {blocked:true,reason:'上空確認待ちのままPZへ近づくため、進入前にフライトを終了'};
          return {target:climb.holdY};
        }
      }
      return {target:goal};
    },
    card(stationary){
      if(!stationary||!lastPos)return null;
      if(climb?.pending){
        const other=overheadBalloon(lastPos,climb.goal,getTraffic());
        return {kind:'overhead',id:climb.id,label:other?`上空に${other.name}がいます。`:'上空クリアです。',
          context:`パイロットから上空確認の依頼${threat?` · ${pzName(threat)}に備えて`:''}${climb.scored?' · 再確認':' · 報告＋50点'}`,enabled:true};
      }
      if(threat&&!sharedPz.has(threat.key))return {kind:'pz',id:threat.key,
        label:notifiedPz.has(threat.key)?`${pzName(threat)}を確認しました。`:`前方の${pzName(threat)}に注意してください。`,context:notifiedPz.has(threat.key)?'パイロットからPZの注意 · 確認報告＋50点':'PZへの早めの注意喚起 · 報告＋50点',enabled:true};
      return null;
    },
    reply(stationary){
      const card=this.card(stationary);if(!card)return null;
      if(card.kind==='pz'){
        sharedPz.add(threat.key);
        return {points:50,message:`1号車：${card.label} パイロット：了解、PZと通過できる高度を確認しました。`};
      }
      // Recheck live traffic on click; a previously displayed clear answer cannot become stale.
      const other=overheadBalloon(lastPos,climb.goal,getTraffic());
      const points=climb.scored?0:50;climb.scored=true;climb.pending=false;
      if(threat)sharedPz.add(threat.key);
      if(other)return {points,message:`1号車：上空に${other.name}がいます。 パイロット：了解。上昇を待ちます。`};
      climb.approved=true;
      return {points,message:'1号車：上空クリアです。 パイロット：了解。PZと最高高度を守って上昇します。'};
    },
  };
}
