const gap=(a,b)=>{const n=Date.parse(b)-Date.parse(a);return a&&b&&Number.isFinite(n)&&n>=0?n:null;};
export function taskLatency(store,t){
 const db=store.db,has=name=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
 const start=db.prepare("SELECT id,createdAt FROM events WHERE taskId=? AND type IN ('task.started','internal-repair.execution-started') ORDER BY id DESC LIMIT 1").get(t.id);
 const events=db.prepare(`SELECT type,min(createdAt) at FROM events WHERE taskId=? AND id>=? AND type IN
   ('session','message','completed','failed','dsh.prompt-submitting','dsh.prompt-received','dsh.model-started','dsh.tool-activity') GROUP BY type`).all(t.id,start?.id||0);
 const at=Object.fromEntries(events.map(e=>[e.type,e.at])),terminal=at.completed||at.failed;
 const visible=db.prepare("SELECT createdAt FROM events WHERE taskId=? AND id>=? AND type='message' AND trim(coalesce(json_extract(data,'$.text'),''))<>'' ORDER BY id LIMIT 1").get(t.id,start?.id||0)?.createdAt;
 const retries=db.prepare("SELECT max(json_extract(data,'$.progress.attempt')) n,group_concat(DISTINCT json_extract(data,'$.progress.code')) codes FROM events WHERE taskId=? AND id>=? AND type='message' AND json_extract(data,'$.progress.kind')='model-retry'").get(t.id,start?.id||0);
 let parts=[];const report=has('return_reports')?db.prepare('SELECT createdAt,manifest FROM return_reports WHERE taskId=? ORDER BY createdAt DESC LIMIT 1').get(t.id):null;
 try{parts=JSON.parse(report?.manifest||'[]').map(p=>db.prepare('SELECT id,status,createdAt,updatedAt FROM outbox WHERE id=?').get(p.id)).filter(Boolean);}catch{}
 if(!parts.length)parts=db.prepare('SELECT id,status,createdAt,updatedAt FROM outbox WHERE deliveryGroup=? ORDER BY partIndex').all(`completed:${t.id}:${t.runVersion}`);
 if(!parts.length&&has('companion_message_parts'))parts=db.prepare('SELECT o.id,o.status,o.createdAt,o.updatedAt FROM companion_message_parts p JOIN outbox o ON o.id=p.outboxId WHERE p.batchId=? ORDER BY p.ordinal').all(`completed:${t.id}:${t.runVersion}`);
 const attempts=parts.flatMap(p=>db.prepare('SELECT startedAt,finishedAt,status FROM qq_delivery_attempts WHERE outboxId=? ORDER BY attempt').all(p.id));
 const firstSend=attempts.map(a=>a.startedAt).sort()[0],lastSend=attempts.map(a=>a.finishedAt).filter(Boolean).sort().at(-1),allSent=parts.length>0&&parts.every(p=>p.status==='sent');
 const narration=terminal?db.prepare("SELECT type,min(createdAt) at FROM events WHERE taskId=? AND createdAt>=? AND type IN ('narrator.queued','narrator.started','narrator.completed') GROUP BY type").all(t.id,terminal):[];
 const nr=Object.fromEntries(narration.map(e=>[e.type,e.at]));
 let inputBufferMs=null;const request=db.prepare("SELECT data FROM events WHERE taskId=? AND type='chat.request' ORDER BY id LIMIT 1").get(t.id);
 if(request){try{const key=JSON.parse(request.data).messageKey;if(key&&has('inbox')){const inbound=db.prepare('SELECT createdAt FROM inbox WHERE messageId=?').get(key);inputBufferMs=gap(inbound?.createdAt,t.createdAt);if(!inbound&&has('qq_input_batches')){const batch=db.prepare('SELECT createdAt FROM qq_input_batches WHERE id=?').get(key);if(batch)inputBufferMs=gap(new Date(batch.createdAt).toISOString(),t.createdAt);}}}catch{}}
 return {reference:t.id,role:t.role,status:t.status,inputBufferMs,queueMs:gap(t.createdAt,start?.createdAt),sessionSetupMs:gap(start?.createdAt,at.session),preflightMs:gap(start?.createdAt,at['dsh.prompt-submitting']),promptReceiptMs:gap(at['dsh.prompt-submitting'],at['dsh.prompt-received']),modelWaitMs:gap(at['dsh.prompt-received'],at['dsh.model-started']),firstEngineMessageMs:gap(start?.createdAt,at.message),firstVisibleMs:gap(start?.createdAt,visible),executionMs:gap(start?.createdAt,terminal),toolExecutionMs:null,toolFirstActivityMs:gap(start?.createdAt,at['dsh.tool-activity']),retryCount:Number(retries.n)||0,retryCodes:retries.codes?.split(',')||[],narratorQueueMs:gap(nr['narrator.queued'],nr['narrator.started']),narratorMs:gap(nr['narrator.started'],nr['narrator.completed']),reportPreparationMs:gap(terminal,parts.map(p=>p.createdAt).sort().at(-1)),sendQueueMs:gap(parts.map(p=>p.createdAt).sort()[0],firstSend),deliveryMs:allSent?gap(report?.createdAt||parts[0]?.createdAt,lastSend):null,qqDeliveryMs:allSent?gap(firstSend,lastSend):null};
}
export function latencyStatus(store,{taskId}={}){
 if(taskId!==undefined&&(typeof taskId!=='string'||!/^t-[\w-]{1,100}$/.test(taskId)))throw Error('任务查询参数无效');
 const rows=taskId?store.db.prepare('SELECT id,role,status,createdAt,updatedAt,runVersion FROM tasks WHERE id=?').all(taskId):store.db.prepare('SELECT id,role,status,createdAt,updatedAt,runVersion FROM tasks ORDER BY createdAt DESC LIMIT 30').all();
 return {note:'按最近一次启动计时；首个引擎消息不等于可见输出。模型等待只计原生接收至首次模型活动，缺少标记为null；工具总耗时缺证据为null，首次活动不代表工具总时长。',tasks:rows.map(t=>taskLatency(store,t))};
}
