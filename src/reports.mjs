import { isInternalArtifact, isQqShareableArtifact } from './knowledge/share-policy.mjs';
import { ensureDeliverableSchema,isDeclaredDeliverable } from './knowledge/task-deliverables.mjs';
import { isInternalSession } from './observability/internal-sessions.mjs';
import {progressRequestIsCurrent,isProgressReportKind} from './report-progress.mjs';
import {reportFallback} from './report-fallback.mjs';
import {redact} from './redact.mjs';
import {refreshFileDelivery} from './hub/file-delivery.mjs';
import { enqueueReportDelivery,enqueueNamedReportDelivery,reconcileNamedReportDelivery,reconcileAllNamedReportDeliveries,reportChunkRows,
  ensureReportDeliverySchema,persistNamedRequest,claimNamedRequest,settleNamedRequest,failNamedRequest,releaseNamedRequest,pendingNamedRequests } from './report-delivery.mjs';

// Durable return queue: task execution is already terminal before narration starts.
export class Reports {
  constructor({store,hub,narrator=null,archive,personaForTask=()=>null}) {
    Object.assign(this,{store,hub,narrator,archive,personaForTask});
    ensureReportDeliverySchema(store.db);
    this.announcementFlights=new Map();this.announcementBusy=false;
    this.shutdownSignal=new Promise(resolve=>{this.resolveShutdown=resolve;});
    ensureDeliverableSchema(store.db);
    store.db.exec(`CREATE TABLE IF NOT EXISTS return_reports(key TEXT PRIMARY KEY,taskId TEXT NOT NULL,snapshot TEXT NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL,directorTaskId TEXT,attempts INTEGER NOT NULL DEFAULT 0,updatedAt TEXT);
      `);
    store.db.exec('CREATE INDEX IF NOT EXISTS return_reports_task_created ON return_reports(taskId,createdAt)');
    const columns=new Set(store.db.prepare('PRAGMA table_info(return_reports)').all().map(row=>row.name));
    const firstDeliverySchemaMigration=!columns.has('body');
    if(!columns.has('directorTaskId'))store.db.exec('ALTER TABLE return_reports ADD COLUMN directorTaskId TEXT');
    if(!columns.has('attempts'))store.db.exec('ALTER TABLE return_reports ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('updatedAt'))store.db.exec('ALTER TABLE return_reports ADD COLUMN updatedAt TEXT');
    if(!columns.has('body'))store.db.exec('ALTER TABLE return_reports ADD COLUMN body TEXT');
    if(!columns.has('manifest'))store.db.exec('ALTER TABLE return_reports ADD COLUMN manifest TEXT');
    if(!columns.has('nextAttemptAt'))store.db.exec('ALTER TABLE return_reports ADD COLUMN nextAttemptAt TEXT');
    // Pre-manifest rows in these states may already have been narrated. Keep
    // them for evidence-based reconciliation; never regenerate them blindly.
    if(firstDeliverySchemaMigration) {
      for(const legacy of store.db.prepare("SELECT * FROM return_reports WHERE body IS NULL AND status IN ('pending','running')").all()) {
        const director=store.db.prepare("SELECT id,prompt,status,runVersion FROM tasks WHERE role='director' AND prompt LIKE '[内部工作回报]%' ORDER BY createdAt DESC,rowid DESC")
          .all().find(candidate=>this.reportKey(candidate)===legacy.key);
        if(director)store.db.prepare("UPDATE return_reports SET status='queued',directorTaskId=?,updatedAt=? WHERE key=?")
          .run(director.id,store.now(),legacy.key);
        else store.db.prepare("UPDATE return_reports SET status='uncertain',updatedAt=? WHERE key=?").run(store.now(),legacy.key);
      }
    }
    // A running row with a matching persisted director turn can be recovered
    // by following that task; otherwise its model side effects are unknown.
    for(const interrupted of store.db.prepare("SELECT * FROM return_reports WHERE status='running' AND body IS NULL").all()) {
      const director=store.db.prepare("SELECT id,prompt,status,runVersion FROM tasks WHERE role='director' AND prompt LIKE '[内部工作回报]%' ORDER BY createdAt DESC,rowid DESC")
        .all().find(candidate=>this.reportKey(candidate)===interrupted.key);
      if(director)store.db.prepare("UPDATE return_reports SET status='queued',directorTaskId=?,updatedAt=? WHERE key=?")
        .run(director.id,store.now(),interrupted.key);
      else store.db.prepare("UPDATE return_reports SET status='uncertain',updatedAt=? WHERE key=?").run(store.now(),interrupted.key);
    }
    if(this.narrator&&pendingNamedRequests(this.store).length)this.wakeAnnouncementWorker();
  }
  enqueue(task,key) {
    if(this.messageRetracted(task?.id,task))return;
    this.store.db.prepare("INSERT OR IGNORE INTO return_reports(key,taskId,snapshot,status,createdAt) VALUES(?,?,?,'pending',?)").run(key,task.id,JSON.stringify(task),this.store.now());
    // A caller can enqueue the next report in the tiny window after the
    // current run has resolved but before flush() has released `busy`.  In
    // that window a plain flush() call is ignored and `finished` still points
    // at the previous run, so an immediate await can observe no new report.
    // Chain the next flush behind the current one and let the scheduler tick
    // after the release, keeping the durable queue authoritative.
    if(this.busy) {
      const previous=this.finished;
      this.finished=Promise.resolve(previous).then(()=>new Promise(resolve=>{
        const schedule=()=>{
          if(this.stopping){resolve();return;}
          if(this.busy){setTimeout(schedule,0);return;}
          Promise.resolve(this.flush()).then(resolve);
        };
        schedule();
      }));
    } else void this.flush();
  }
  async announce({task,kind='status-update',situation='',dedupe,artifacts=[]}={}) {
    if(this.stopping)throw new Error('汇报服务正在关闭');
    if(kind==='dispatch-confirmation'){this.store.event(task?.id??null,'report.dispatch-hint',{kind});return '';}
    if(!this.narrator || !task)throw new Error('AI 汇报会话当前不可用');
    if(isProgressReportKind(kind)&&!this.progressRequestIsCurrent(task))return '';
    if(this.messageRetracted(task.id,task))return '';
    if(!dedupe) {
      const outcome=await Promise.race([
        Promise.resolve().then(()=>this.narrator.summarize({task,artifacts,persona:this.personaForTask(task),kind,situation})).then(text=>({text})),
        this.shutdownSignal.then(()=>({stopped:true})),
      ]);
      if(outcome.stopped)return '';
      if(this.stopping||this.messageRetracted(task.id,task))return '';
      const text=String(outcome.text||'').trim();
      if(kind==='screen-observation'&&/^NO_MESSAGE[。.!！]?$/i.test(text))throw Error('陪工作每张截图需要回复，请生成自然陪聊内容');
      if(!text)throw new Error('汇报会话没有生成可发送的内容');this.hub.say?.(text);return text;
    }
    const request=persistNamedRequest(this.store,{key:String(dedupe),task,kind,situation,artifacts});
    const existing=reconcileNamedReportDelivery(this.store,String(dedupe));
    if(existing?.body) {if(!this.namedProgressRequestIsCurrent(String(dedupe)))return '';settleNamedRequest(this.store,String(dedupe),existing.status);return existing.body;}
    const flight=this.announcementFlights.get(String(dedupe));
    if(flight)return flight;
    const promise=this.runNamedRequest(String(dedupe)).then(body=>{
      if(isProgressReportKind(kind)&&!this.progressRequestIsCurrent(task))return null;
      if(body&&!this.stopping)this.hub.say?.(body);
      return body;
    }).finally(()=>this.announcementFlights.delete(String(dedupe)));
    this.announcementFlights.set(String(dedupe),promise);
    this.wakeAnnouncementWorker();
    return promise;
  }
  wakeAnnouncementWorker() {
    if(this.announcementTimer||this.stopping||!this.narrator)return;
    this.announcementTimer=setInterval(()=>void this.flushAnnouncements(),1000);
    this.announcementTimer.unref?.();
    queueMicrotask(()=>void this.flushAnnouncements());
  }
  async runNamedRequest(key) {
    if(this.stopping)return null;
    if(this.store.db.prepare('SELECT kind FROM report_requests WHERE key=?').get(key)?.kind==='dispatch-confirmation'){
      settleNamedRequest(this.store,key,'suppressed');return null;
    }
    const committed=reconcileNamedReportDelivery(this.store,key);
    if(committed?.body) {if(!this.namedProgressRequestIsCurrent(key))return null;settleNamedRequest(this.store,key,committed.status);return committed.body;}
    const claimed=claimNamedRequest(this.store,key);
    if(!claimed)return this.waitForNamedBody(key);
    let narrationDone=false;
    try {
      const task=JSON.parse(claimed.request),artifacts=JSON.parse(claimed.artifacts||'[]');
      if(claimed.kind==='screen-observation'&&!this.hub.screenCompanionActive){settleNamedRequest(this.store,key,'suppressed');return null;}
      if(claimed.kind==='agent-completion'&&!this.externalNoticeIsCurrent(key)) {settleNamedRequest(this.store,key,'suppressed');return null;}
      if(this.messageRetracted(task.id,task)){settleNamedRequest(this.store,key,'suppressed');return null;}
      if(isProgressReportKind(claimed.kind)&&!this.progressRequestIsCurrent(task)) {
        this.suppressStaleProgressRequest(key,claimed.taskId);return null;
      }
      const outcome=await Promise.race([
        Promise.resolve().then(()=>this.narrator.summarize({task,artifacts,persona:this.personaForTask(task),kind:claimed.kind,situation:claimed.situation})).then(text=>({text})),
        this.shutdownSignal.then(()=>({stopped:true})),
      ]);
      if(outcome.stopped) {releaseNamedRequest(this.store,key);return null;}
      const text=String(outcome.text||'').trim();
      narrationDone=!!text;
      if(this.stopping) {releaseNamedRequest(this.store,key);return null;}
      if(this.messageRetracted(task.id,task)){settleNamedRequest(this.store,key,'suppressed');return null;}
      if(isProgressReportKind(claimed.kind)&&!this.progressRequestIsCurrent(task)) {
        this.suppressStaleProgressRequest(key,claimed.taskId);return null;
      }
      if(!text)throw new Error('汇报会话没有生成可发送的内容');
      if(claimed.kind==='screen-observation'&&!this.hub.screenCompanionActive){settleNamedRequest(this.store,key,'suppressed');return null;}
      if(claimed.kind==='agent-completion'&&!this.externalNoticeIsCurrent(key)) {settleNamedRequest(this.store,key,'suppressed');return null;}
      if(claimed.kind==='screen-observation'&&/贴给助手|转交给助手|整理成一段.{0,12}(?:贴给|发给|转交)/u.test(text))throw Error('屏幕主管汇报混入内部交接措辞');
      if(claimed.kind==='screen-observation'&&/^NO_MESSAGE[。.!！]?$/i.test(text))throw Error('陪工作每张截图需要回复，请生成自然陪聊内容');
      enqueueNamedReportDelivery({store:this.store,hub:this.hub,key,dedupe:key,text,taskId:claimed.taskId});
      const delivery=reconcileNamedReportDelivery(this.store,key);
      settleNamedRequest(this.store,key,delivery?.status||'queued');
      this.store.event(claimed.taskId,'report.narrated',{kind:claimed.kind,status:delivery?.status||'queued'});
      return delivery?.body||text;
    } catch(error) {
      if(this.stopping) {releaseNamedRequest(this.store,key);return null;}
      if(claimed.kind==='work-companion'&&!reconcileNamedReportDelivery(this.store,key)?.body){
        settleNamedRequest(this.store,key,'suppressed');this.store.event(claimed.taskId,'companion.work-presence-failed',{reason:narrationDone?'delivery-enqueue-failed':'generation-not-completed',error:redact(error.message).slice(0,300)});
        if(narrationDone)this.store.error(claimed.taskId,'工作陪聊投递入队失败：'+redact(error.message).slice(0,300));return null;
      }
      const outcome=failNamedRequest(this.store,key,error);
      this.store.event(claimed.taskId,'narrator.queue-error',{kind:claimed.kind,attempts:outcome?.attempts,status:outcome?.status});
      throw error;
    }
  }
  async waitForNamedBody(key,{timeoutMs=180000}={}) {
    const until=Date.now()+timeoutMs;
    while(Date.now()<until) {
      if(this.stopping)return null;
      const delivery=reconcileNamedReportDelivery(this.store,key);
      if(delivery?.body)return this.namedProgressRequestIsCurrent(key)?delivery.body:null;
      const request=this.store.db.prepare('SELECT status,nextAttemptAt,leaseUntil FROM report_requests WHERE key=?').get(key);
      if(!request||['uncertain','suppressed'].includes(request.status))return null;
      if((request.status==='pending'&&(!request.nextAttemptAt||request.nextAttemptAt<=this.store.now()))
        ||(request.status==='running'&&(!request.leaseUntil||request.leaseUntil<=this.store.now())))return this.runNamedRequest(key);
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    return null;
  }
  async flushAnnouncements() {
    if(this.announcementBusy||this.stopping||!this.narrator)return;
    this.announcementBusy=true;
    try {
      for(const row of pendingNamedRequests(this.store)) {
        if(this.stopping)break;
        if(this.announcementFlights.has(row.key))continue;
        const promise=this.runNamedRequest(row.key).then(body=>{if(body&&!this.stopping)this.hub.say?.(body);}).catch(()=>{})
          .finally(()=>this.announcementFlights.delete(row.key));
        this.announcementFlights.set(row.key,promise);
        await promise;
      }
      if(!this.stopping)reconcileAllNamedReportDeliveries(this.store);
    } finally {this.announcementBusy=false;}
  }
  reportKey(task) {
    if(!String(task?.prompt||'').startsWith('[内部工作回报]\n'))return null;
    try { const data=JSON.parse(String(task.prompt).slice('[内部工作回报]\n'.length).split(/\r?\n/,1)[0]);return typeof data.returnKey==='string'?data.returnKey:null; }
    catch { return null; }
  }
  progressRequestIsCurrent(task) {
    return progressRequestIsCurrent(this.store,task);
  }
  namedProgressRequestIsCurrent(key) {
    const row=this.store.db.prepare('SELECT kind,request,taskId FROM report_requests WHERE key=?').get(key);
    if(!row||!isProgressReportKind(row.kind))return true;
    let task;try{task=JSON.parse(row.request);}catch{}
    if(task?.id===row.taskId&&this.progressRequestIsCurrent(task))return true;
    this.suppressStaleProgressRequest(key,row.taskId);return false;
  }
  messageRetracted(taskId,snapshot=null) {
    if(!taskId)return false;
    if(this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.message-retracted' LIMIT 1").get(taskId))return true;
    const current=this.store.task(taskId);
    if(current?.role==='worker') {
      if(snapshot?.runVersion!==undefined&&current.runVersion!==snapshot.runVersion)return true;
      if(snapshot&&['completed','failed','cancelled'].includes(snapshot.status)&&current.status!==snapshot.status)return true;
      if(current.status!=='failed'&&this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_amendments'").get()&&this.store.db.prepare("SELECT 1 FROM task_amendments WHERE taskId=? AND status IN ('pending','claimed') LIMIT 1").get(taskId))return true;
    }
    return false;
  }
  reportIsCurrent(task) {
    const key=this.reportKey(task);if(!key)return true;
    const row=this.store.db.prepare('SELECT snapshot,status FROM return_reports WHERE key=?').get(key);
    if(!row)return true;
    if(row.status==='suppressed')return false;
    try{const snapshot=JSON.parse(row.snapshot);return !this.messageRetracted(snapshot.id,snapshot);}catch{return false;}
  }
  externalNoticeIsCurrent(key) {
    if(this.store.meta('agent-completions:enabled')!=='true')return false;
    const rows=this.store.db.prepare('SELECT engine,sessionId FROM agent_completion_receipts WHERE batchKey=?').all(key);
    return rows.length>0&&rows.every(row=>!isInternalSession(this.store,row.engine,row.sessionId));
  }
  suppressStaleProgressRequest(key,taskId) {
    settleNamedRequest(this.store,key,'suppressed');
    this.store.event(taskId,'report.progress-suppressed',{reason:'task-finished-or-run-changed'});
  }
  delivered(task) {
    const key=this.reportKey(task);if(!key)return false;
    // The director has finished writing its reply, but QQ may still be offline
    // or may reject the send. Keep this report queued until the durable QQ
    // outbox confirms the notification was actually accepted.
    const changed=this.store.db.prepare("UPDATE return_reports SET status='queued',directorTaskId=?,updatedAt=? WHERE key=? AND status!='suppressed'").run(task.id,this.store.now(),key).changes;
    if(changed)this.store.event(task.id,'report.delivered',{returnKey:key});
    return changed>0;
  }
  failed(task,error) {
    const key=this.reportKey(task);if(!key)return false;
    const row=this.store.db.prepare('SELECT * FROM return_reports WHERE key=?').get(key);if(!row)return false;
    this.recordFailure(row,task.id,error);
    void this.flush();
    return true;
  }
  recordFailure(row,directorTaskId,error) {
    const source=JSON.parse(row.snapshot);
    if(this.messageRetracted(row.taskId,source)){this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);return;}
    const attempts=Number(row.attempts||0)+1;
    if(attempts<2) {
      this.store.db.prepare("UPDATE return_reports SET status='pending',directorTaskId=NULL,attempts=?,updatedAt=? WHERE key=?").run(attempts,this.store.now(),row.key);
      this.store.event(row.taskId,'report.retry-queued',{attempts,message:String(error?.message||error).slice(0,300)});
      return;
    }
    const text=reportFallback(source,this.personaForTask(source));
    // Persist the fallback to the durable QQ outbox before settling the
    // report. The stable key makes this safe if the process dies between the
    // enqueue and the status update.
    this.hub.notification?.(text,`return-fallback:${row.key}`);
    this.store.db.prepare("UPDATE return_reports SET status='fallback',directorTaskId=?,attempts=?,updatedAt=? WHERE key=?").run(directorTaskId||null,attempts,this.store.now(),row.key);
    this.hub.say?.(text);
    this.store.event(row.taskId,'report.fallback-delivered',{directorTaskId:directorTaskId||null});
  }
  queueExhaustedReturn(row,task,attempts) {
    if(this.messageRetracted(row.taskId,task)){this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);return;}
    const text=reportFallback(task,this.personaForTask(task));
    try{
      enqueueReportDelivery({store:this.store,hub:this.hub,key:row.key,text,taskId:task.id});
    }catch(error){
      // Three persistence attempts (3,4,5) after the model budget is exhausted.
      // Do not spend more model calls just because the outbox insert failed.
      const status=attempts>=5?'uncertain':'pending';
      this.store.db.prepare('UPDATE return_reports SET status=?,attempts=?,nextAttemptAt=?,updatedAt=? WHERE key=?')
        .run(status,attempts,status==='pending'?new Date(Date.now()+60000).toISOString():null,this.store.now(),row.key);
      this.store.event(row.taskId,'report.fallback-queue-error',{attempts,status});return;
    }
    this.store.db.prepare('UPDATE return_reports SET attempts=?,updatedAt=? WHERE key=?').run(attempts,this.store.now(),row.key);
    this.hub.say?.(text);
    this.store.event(task.id,'report.narration-exhausted',{attempts});
  }
  reconcile() {
    reconcileAllNamedReportDeliveries(this.store);
    for(const row of this.store.db.prepare('SELECT key,status FROM report_notifications').all()) {
      const delivery=reconcileNamedReportDelivery(this.store,row.key);
      if(delivery?.status==='sent'||delivery?.status==='suppressed')settleNamedRequest(this.store,row.key,delivery.status);
    }
    const rows=this.store.db.prepare("SELECT * FROM return_reports WHERE status IN ('queued','partial','sent','uncertain')").all();
    for(const row of rows) {
      // A sent return is immutable receipt history. Rechecking it on every
      // ten-second pass rewrites updatedAt and makes the receipt look fresh.
      if(row.status==='sent')continue;
      // New narrator reports go straight into the durable QQ outbox and never
      // create a synthetic director task. Keep that delivery state separate
      // from older report turns that still reference a director task.
      if(!row.directorTaskId) {
        const notifications=row.manifest ? JSON.parse(row.manifest) : reportChunkRows(this.store,row.key);
        if(!notifications.length) {
          if(row.status==='sent')continue;
          if(!row.body && row.status!=='uncertain')this.store.db.prepare("UPDATE return_reports SET status='uncertain',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
          continue;
        }
        // Refresh receipt state from the authoritative outbox rows. A manifest
        // is the exact expected set; a legacy prefix scan is accepted only as
        // migration evidence and is never used to resend the report.
        const current=notifications.map(part=>this.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(part.id)).filter(Boolean);
        if(current.length!==notifications.length) {
          this.store.db.prepare("UPDATE return_reports SET status='uncertain',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else if(current.every(item=>item.status==='sent')) {
          this.store.db.prepare("UPDATE return_reports SET status='sent',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else if(current.every(item=>item.status==='sent'||item.status==='suppressed') && current.some(item=>item.status==='suppressed')) {
          this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else if(current.some(item=>item.status==='uncertain')) {
          this.store.db.prepare("UPDATE return_reports SET status='uncertain',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else if(current.some(item=>item.status==='sent') || current.some(item=>item.status==='suppressed')) {
          this.store.db.prepare("UPDATE return_reports SET status='partial',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else if(row.body) {
          this.store.db.prepare("UPDATE return_reports SET status='queued',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else {
          this.store.db.prepare("UPDATE return_reports SET status='uncertain',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        }
        continue;
      }
      const task=row.directorTaskId?this.store.task(row.directorTaskId):null;
      // Old `sent` rows predate directorTaskId and cannot be safely replayed.
      // Keep any sent row without verifiable task/outbox evidence as history.
      if(row.status==='sent' && !task)continue;
      if(!task || ['failed','cancelled','interrupted'].includes(task.status)) {
        if(row.status==='sent')continue;
        this.recordFailure(row,row.directorTaskId,new Error(`主管回报任务${task?.status||'已丢失'}`));
      } else if(task.status==='completed') {
        const prefix=`completed:${task.id}:${task.runVersion}:part:`;
        const notifications=this.store.db.prepare('SELECT status FROM outbox WHERE substr(dedupe,1,?)=? ORDER BY createdAt,rowid').all(prefix.length,prefix);
        if(!notifications.length) {
          if(row.status==='sent')continue;
          // A legacy completed narration with no outbox record cannot be
          // distinguished from an already delivered message whose evidence
          // was pruned. Preserve it for review instead of recreating it.
          this.store.db.prepare("UPDATE return_reports SET status='uncertain',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else if(notifications.every(item=>item.status==='sent')) {
          this.store.db.prepare("UPDATE return_reports SET status='sent',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else if(notifications.every(item=>item.status==='sent'||item.status==='suppressed') && notifications.some(item=>item.status==='suppressed')) {
          this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        } else {
          // Pending/sending rows are owned by QQ's retryable outbox. Retain
          // the report link so a restart can observe the eventual ack.
          this.store.db.prepare("UPDATE return_reports SET status='queued',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
        }
      }
    }
  }
  async flush() {
    if(this.busy || this.stopping)return;
    this.busy=true;
    this.finished=(async()=>{
      this.reconcile();
      while(!this.stopping) {
        const row=this.store.db.prepare("SELECT * FROM return_reports WHERE status='pending' AND (nextAttemptAt IS NULL OR nextAttemptAt<=?) ORDER BY createdAt,rowid LIMIT 1").get(this.store.now());
        if(!row)break;
        this.store.db.prepare("UPDATE return_reports SET status='running' WHERE key=?").run(row.key);
        let task={id:row.taskId,status:'unknown'};
        try {
          task=refreshFileDelivery(this.store,JSON.parse(row.snapshot));
          if(Number(row.attempts)>=3){this.queueExhaustedReturn(row,task,Number(row.attempts)+1);continue;}
          const artifacts=await this.archive.list({taskId:task.id,includeText:true,maxTextLength:50000});
          if(this.stopping)break;
          if(this.messageRetracted(task.id,task)){this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);continue;}
          // hub.create() persists the director task before returning. If the
          // process dies before we persist directorTaskId below, adopt that
          // task on restart instead of creating a duplicate report turn.
          const existing=this.store.db.prepare("SELECT id,prompt,status,runVersion FROM tasks WHERE role='director' AND prompt LIKE '[内部工作回报]%' ORDER BY createdAt DESC,rowid DESC").all()
            .find(candidate=>{
              if(this.reportKey(candidate)!==row.key)return false;
              if(['queued','running','waiting'].includes(candidate.status))return true;
              if(candidate.status!=='completed')return false;
              const prefix=`completed:${candidate.id}:${candidate.runVersion}:part:`;
              return Boolean(this.store.db.prepare('SELECT 1 FROM outbox WHERE substr(dedupe,1,?)=? LIMIT 1').get(prefix.length,prefix));
            });
          if(existing) {
            this.store.db.prepare("UPDATE return_reports SET status='queued',directorTaskId=?,updatedAt=? WHERE key=?").run(existing.id,this.store.now(),row.key);
            this.store.event(row.taskId,'report.return-adopted',{directorTaskId:existing.id,status:existing.status});
            continue;
          }
          // Return worker evidence to the persistent DSH supervisor. It owns
          // the final wording and may select only from the verified, familiar
          // file formats below. The supervisor task is deliberately compact.
          const outcomes=new Set(this.store.db.prepare('SELECT artifactId FROM task_deliverables WHERE taskId=?').all(task.id).map(row=>row.artifactId));
          const shareable=task.role==='worker'&&!task.fileDelivery ? artifacts.filter((artifact)=>
            !String(artifact.sourcePath || '').startsWith('generated://') && !isInternalArtifact(artifact) && isQqShareableArtifact(artifact)
            && (outcomes.has(artifact.id) || isDeclaredDeliverable(task,artifact))
          ).sort((a,b)=>Number(outcomes.has(b.id)||isDeclaredDeliverable(task,b))-Number(outcomes.has(a.id)||isDeclaredDeliverable(task,a))).slice(0,12).map((artifact)=>{
            const {id,name,mimeType,isImage}=artifact;
            return {id,name,mimeType,isImage,...(outcomes.has(id)||isDeclaredDeliverable(task,artifact)?{delivery:'outcome'}:{})};
          }) : [];
          // Explicit, named outcomes are deliveries, not optional narrator
          // suggestions. Their stable key also survives narration retries.
          if(this.hub.queueArtifact)for(const file of shareable.filter(file=>file.delivery==='outcome').slice(0,4)) {
            if(this.stopping)break;
            const artifact=artifacts.find(item=>item.id===file.id);
            try{
              await this.hub.queueArtifact(artifact,{dedupe:`task-deliverable:${file.id}`});
              if(!this.stopping)void this.hub.notify?.();
            }
            catch(error){if(!this.stopping)this.store.event(task.id,'artifact.queue-error',{artifactId:file.id,message:error.message});}
          }
          if(typeof this.narrator?.summarize==='function') {
            const summary=await this.narrator.summarize({
              task,
              artifacts:shareable,
              persona:this.personaForTask(task),
              kind:task.status==='completed'?'task-completion':'task-failure',
              situation:task.fileDelivery
                ? '按fileDelivery与result中的已核验交付状态，用当前人设自然汇报。sent表示QQ平台已确认；pending/sending表示尚待发送确认；unverified表示尚未核实。文件由统一交付流程处理，不再次发送；内部执行规则不要复述给用户。'
                : task.status==='completed'
                ? '工作会话已经结束；根据实际结果说明完成了什么，是否还有未完成部分，以及用户接下来是否需要处理。'
                : '工作会话没有完成；坦白说明失败或停在了哪里、已有的有效结果和是否需要用户决定下一步。',
            });
            if(this.stopping)break;
            if(this.messageRetracted(task.id,task)){this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);continue;}
            const text=String(summary||'').trim();
            if(!text)throw new Error('汇报会话没有生成可发送的内容');
            enqueueReportDelivery({store:this.store,hub:this.hub,key:row.key,text,taskId:task.id});
            this.hub.say?.(text);
            this.store.event(task.id,'report.narrated',{status:task.status,artifactCount:shareable.length});
            continue;
          }
          const report={returnKey:row.key,status:task.status==='completed'?'completed':'failed',request:String(task.prompt||'').slice(0,900),result:String(task.result||'').slice(0,1800),error:String(task.error||'').slice(0,500),files:shareable};
          const prompt=`[内部工作回报]\n${JSON.stringify(report)}\n只整理这份结果，不要再派任务。用当前人设的称呼、语气和自然反应简短告诉用户结论和是否完成。标记 outcome 的成果文档和图片会自动发送；其他值得查看的附件只可从 files 挑选，输出一行 [HUB-FILES] 后接 JSON：{"artifactIds":["候选文件id"]}。不要复述内部编号、日志或长文件清单。`;
          const queued=await this.hub.create({engine:'dsh',prompt,role:'director'});
          if(this.stopping)break;
          this.store.event(row.taskId,'report.returned-to-director',{directorTaskId:queued.id,fileCount:shareable.length});
          this.store.db.prepare("UPDATE return_reports SET status='queued',directorTaskId=?,updatedAt=? WHERE key=?").run(queued.id,this.store.now(),row.key);
        } catch(error) {
          if(this.stopping) {
            break;
          }
          if(this.messageRetracted(row.taskId,task)){this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);continue;}
          this.store.event(row.taskId,'narrator.queue-error',{message:error.message});
          const attempts=Number(row.attempts||0)+1;
          if(attempts>=3){
            this.queueExhaustedReturn(row,task,attempts);
            continue;
          }
          const status='pending';
          const delayMs=Math.min(60000,1000*2**attempts);
          this.store.db.prepare('UPDATE return_reports SET status=?,attempts=?,nextAttemptAt=?,updatedAt=? WHERE key=?')
            .run(status,attempts,status==='pending'?new Date(Date.now()+delayMs).toISOString():null,this.store.now(),row.key);
          break;
        }
      }
    })();
    try {await this.finished;} finally {this.busy=false;}
  }
  async close(){
    if(this.stopping)return;
    this.stopping=true;clearInterval(this.announcementTimer);
    this.resolveShutdown?.();
    // Persist ownership release before returning. Late, non-cancellable
    // archive/model operations must not need the store after this point.
    this.store.db.prepare("UPDATE return_reports SET status='pending',nextAttemptAt=NULL,updatedAt=? WHERE status='running'")
      .run(this.store.now());
    for(const key of this.announcementFlights.keys())releaseNamedRequest(this.store,key);
    // Start narrator shutdown immediately so active model requests are
    // cancelled/resolved before we join their announcement promises.
    const closeNarrator=Promise.resolve().then(()=>this.narrator?.close?.()).catch(()=>{});
    const bounded=(promise,ms=1000)=>Promise.race([promise,new Promise(resolve=>{
      const timer=setTimeout(resolve,ms);timer.unref?.();
    })]);
    await bounded(closeNarrator);
    await bounded(Promise.allSettled([...this.announcementFlights.values()]));
    // An archive or adapter operation may be non-cancellable. Reports are
    // persisted before work starts, so let it finish in the background rather
    // than making service shutdown wait indefinitely.
    await bounded(this.finished);
  }
}
