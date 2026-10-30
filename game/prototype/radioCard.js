// Contextual actions never open the settings menu. Confirmation rules stay in chaseRules.
export function radioCard({finished,confirmation,stationary,balloon,groundReady}) {
  if(finished)return null;
  if(confirmation.drop)return {kind:'drop',label:'投下確認 ＋50点',enabled:true};
  if(confirmation.landing)return {kind:'landing',label:'区域内着地確認 1,000点',enabled:true};
  if(stationary&&balloon?.ready)return {kind:'wind',label:'上空風を報告 ＋20点',enabled:true};
  if(groundReady)return {kind:'ground',label:'地上風を報告 ＋50点',enabled:true};
  if(stationary&&balloon)return {kind:'observing',label:'観測中',enabled:false};
  return null;
}
