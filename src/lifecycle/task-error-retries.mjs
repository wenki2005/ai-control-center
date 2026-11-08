import {errorStrategy} from '../error-strategy.mjs';

// One durable owner of whole-turn retries; DSH's in-flight llm/retry stays native.
export class TaskErrorRetries {
 constructor(hub,{now=Date.now,random=Math.random}={}){
  Object.assign(this,{hub,now,random});
  hub.store.db.exec(`CREATE TABLE IF NOT EXISTS task_error_retries(taskId TEXT PRIMARY KEY,runVersion INTEGER NOT NULL,attempts INTEGER NOT NULL,
   category TEXT NOT NULL,nextAt INTEGER NOT NULL,startedAt INTEGER NOT NULL,status TEXT NOT NULL)`);
 }
 pending(id){return !!this.hub.store.db.prepare("SELECT 1 FROM task_error_retries WHERE taskId=? AND status='pending'").get(id);}
 guarded(task){
  const {store}=this.hub;
  return !!store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type IN ('task.stop-requested','director.worker-created','task.native-linked') LIMIT 1").get(task.id)
   ||!!store.db.prepare(`SELECT 1 FROM events WHERE taskId=? AND id>COALESCE((SELECT max(id) FROM events WHERE taskId=? AND type='task.started'),0)
    AND (type='dsh.tool-activity' OR type='message' AND length(COALESCE(json_extract(data,'$.text'),''))>0) LIMIT 1`).get(task.id,task.id)
   ||!!store.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status IN ('pending','resolving','recovery_required') LIMIT 1").get(task.id);
 }
 schedule(task,error){
  if(!['worker','director','coordinator'].includes(task.role)||error?.automaticRetriesExhausted===true||this.guarded(task))return false;
  const {store}=this.hub,row=store.db.prepare('SELECT * FROM task_error_retries WHERE taskId=?').get(task.id);
  if(row?.status==='pending'&&row.runVersion===task.runVersion){
   if(errorStrategy(error,{now:this.now(),random:this.random}).autoRetry)return true;
   store.db.prepare("UPDATE task_error_retries SET status='cancelled' WHERE taskId=?").run(task.id);return false;
  }
  const attempts=row?.attempts||0,now=this.now(),plan=errorStrategy(error,{attempt:attempts,now,random:this.random});
  if(!plan.autoRetry||now+plan.delayMs-(row?.startedAt??now)>600000)return false;
  store.transaction(()=>{
   store.db.prepare(`INSERT INTO task_error_retries VALUES(?,?,?,?,?,?, 'pending') ON CONFLICT(taskId) DO UPDATE SET runVersion=excluded.runVersion,
    attempts=excluded.attempts,category=excluded.category,nextAt=excluded.nextAt,status='pending'`).run(task.id,task.runVersion,attempts+1,plan.category,now+plan.delayMs,row?.startedAt??now);
   store.event(task.id,'task.error-retry-scheduled',{category:plan.category,attempt:attempts+1,maxRetries:3,nextAt:new Date(now+plan.delayMs).toISOString(),runVersion:task.runVersion,sessionId:task.sessionId});
  });
  this.hub.emit();return true;
 }
 poll(){
  const {hub}=this,{store}=hub;if(hub.stopping)return;
  for(const row of store.db.prepare("SELECT * FROM task_error_retries WHERE status='pending' ORDER BY nextAt").all()){
   let task=store.task(row.taskId);
   if(!task||!['running','interrupted'].includes(task.status)||task.runVersion!==row.runVersion||this.guarded(task)){
    store.db.prepare("UPDATE task_error_retries SET status='cancelled' WHERE taskId=?").run(row.taskId);continue;
   }
   // Reserve the original seat across a restart; never follow the failed native turn.
   if(task.status==='interrupted')task=store.update(task.id,{status:'running',error:null});
   if(row.nextAt>this.now())continue;
   const claimed=store.db.prepare("UPDATE task_error_retries SET status='started' WHERE taskId=? AND status='pending' AND runVersion=?").run(task.id,row.runVersion).changes;
   if(!claimed)continue;
   store.event(task.id,'task.error-retry-started',{attempt:row.attempts,category:row.category,previousRunVersion:row.runVersion,sessionId:task.sessionId});
   hub.run(task);
  }
 }
}
