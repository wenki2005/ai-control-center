// Read canonical records. Neither message text nor proximity proves delivery.
export function requestTraces(store,{limit=20}={}){
 const db=store.db,has=name=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
 return db.prepare(`SELECT id,prompt,createdAt FROM tasks t WHERE CASE role WHEN 'director' THEN 1 WHEN 'worker' THEN
   NOT EXISTS(SELECT 1 FROM events e WHERE e.type='director.worker-created' AND json_valid(e.data) AND json_extract(e.data,'$.workerId')=t.id) ELSE 0 END
   AND prompt NOT LIKE '[内部工作回报]%' ORDER BY createdAt DESC LIMIT ?`).all(Math.max(1,Math.min(50,Number(limit)||20))).map(root=>{
  const tasks=[],seen=new Set(),pending=[root.id];
  while(pending.length&&seen.size<20){
   const id=pending.shift();if(seen.has(id))continue;seen.add(id);
   const task=db.prepare('SELECT id,engine,role,status,sessionId,runVersion FROM tasks WHERE id=?').get(id);if(!task)continue;
   const events=db.prepare("SELECT type,data,createdAt FROM events WHERE taskId=? AND type IN ('chat.request','director.interjection-accepted','director.worker-created','completed','failed','session') ORDER BY id").all(id).map(e=>{let data={};try{data=JSON.parse(e.data||'{}');}catch{}return {...e,data};});
   for(const e of events)if(e.type==='director.worker-created'&&e.data.workerId)pending.push(e.data.workerId);
   const groups=new Set([`completed:${id}:${task.runVersion}`,`failed:${id}:${task.runVersion}`]);
   const reports=has('return_reports')?db.prepare('SELECT key,status,manifest FROM return_reports WHERE taskId=? ORDER BY createdAt').all(id):[];
   for(const r of reports)groups.add(`task-report:${r.key}`);
   if(has('report_notifications'))for(const r of db.prepare('SELECT key FROM report_notifications WHERE taskId=?').all(id))groups.add(r.key);
   const parts=new Map();
   if(has('companion_message_parts'))for(const p of db.prepare(`SELECT o.id,p.ordinal partIndex,o.status,o.error,p.batchId deliveryGroup
     FROM companion_message_parts p JOIN outbox o ON o.id=p.outboxId WHERE p.batchId=? ORDER BY p.ordinal`).all(`completed:${id}:${task.runVersion}`))parts.set(p.id,p);
   for(const g of groups)for(const p of db.prepare('SELECT id,partIndex,status,error,deliveryGroup FROM outbox WHERE deliveryGroup=? ORDER BY partIndex').all(g))parts.set(p.id,p);
   for(const r of reports){let manifest=[];try{manifest=JSON.parse(r.manifest||'[]');}catch{}for(const m of manifest){const p=db.prepare('SELECT id,partIndex,status,error,deliveryGroup FROM outbox WHERE id=?').get(m.id);if(p)parts.set(p.id,p);}}
   const delivery=[...parts.values()].map(p=>({...p,attempts:db.prepare('SELECT attempt,status,platformMessageId FROM qq_delivery_attempts WHERE outboxId=? ORDER BY attempt').all(p.id)}));
   const stage=delivery.some(p=>p.status==='uncertain')?'发送结果未知':delivery.length&&delivery.every(p=>p.status==='sent')?'平台已确认':delivery.length?'等待发送':task.status==='failed'?'生成或执行失败':task.status==='completed'?'等待回传或无独立回复':'等待引擎终态';
   tasks.push({...task,stage,requests:events.filter(e=>e.type==='chat.request'||e.type==='director.interjection-accepted').map(e=>e.data),turns:events.filter(e=>['completed','failed','session'].includes(e.type)).map(e=>({type:e.type,at:e.createdAt,nativeTurnId:e.data.nativeTurnId||null,sessionId:e.data.sessionId||task.sessionId})),reports:reports.map(({key,status})=>({key,status})),delivery});
  }
  return {request:root.prompt.slice(0,240),createdAt:root.createdAt,tasks};
 });
}
