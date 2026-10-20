// Direct tasks describe center-side connections. Closing those records never
// cancels the independent native DSH session, including after a center restart.
export function reconcileDirectBridgeRecords(store) {
  const selected=store.meta('directSessionMode')==='on'?store.meta('directTaskId'):null;
  const orphaned=store.db.prepare("SELECT id,sessionId FROM tasks WHERE role='direct' AND status IN ('queued','running','waiting','interrupted')").all().filter(row=>row.id!==selected);
  if(!orphaned.length)return 0;
  store.transaction(()=>{
    for(const row of orphaned) {
      store.update(row.id,{status:'detached',error:null,result:'中枢直连桥接已关闭；原 DSH 会话保留。'});
      store.event(row.id,'direct.bridge-reconciled',{sessionId:row.sessionId});
    }
  });
  return orphaned.length;
}
