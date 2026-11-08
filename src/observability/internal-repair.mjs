import {reconcileResolvedSources,reviewDormant,promoteDormant,settleValidatedRepair,repairAttemptLimit} from './repair-review.mjs';
import {createHash} from 'node:crypto';
import {redact} from '../redact.mjs';
import {repairDeliveryState} from './repair-delivery-state.mjs';
import {repairReceipt} from './repair-contract.mjs';
import {writeRepairWorkOrder} from './repair-work-order.mjs';
import {errorStrategy} from '../error-strategy.mjs';

// Durable delivery intents. Delivery acceptance is deliberately not repair success.
export class InternalRepair {
  constructor({store,threadId,send,validate=null,now=Date.now,reconcile=repairDeliveryState,captureBaseline=null,isRunning=()=>false,workOrderRoot=null}) {
    Object.assign(this,{store,threadId,send,validate,now,reconcile,captureBaseline,isRunning,workOrderRoot});this.busy=false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS internal_repairs(
      id TEXT PRIMARY KEY,taskId TEXT,error TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      nextAttempt INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,detail TEXT);
      CREATE TABLE IF NOT EXISTS internal_repair_sources(errorId TEXT PRIMARY KEY,repairId TEXT);`);
    const columns=new Set(store.db.prepare('PRAGMA table_info(internal_repairs)').all().map(r=>r.name));
    for(const column of ['feedback','baseline'])if(!columns.has(column))store.db.exec(`ALTER TABLE internal_repairs ADD COLUMN ${column} TEXT`);
    for(const column of ['reviewAttempts','nextReview'])if(!columns.has(column))store.db.exec(`ALTER TABLE internal_repairs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if(!columns.has('leaderId'))store.db.exec('ALTER TABLE internal_repairs ADD COLUMN leaderId TEXT');
    store.db.prepare("UPDATE internal_repairs SET status='waiting-provider' WHERE status='pending' AND (error LIKE '%prefill_cap_refused%' OR error LIKE '%the cell is at capacity%' OR error LIKE '%insufficient_quota%')").run();
    if(threadId)store.meta(`internal-session:codex:${threadId}`,'automatic-repair');
    store.db.prepare("UPDATE internal_repairs SET status='delivery-uncertain' WHERE status='sending'").run();
    for(const row of store.db.prepare("SELECT id,error FROM internal_repairs WHERE status='pending'").all())if(['rate-limit','quota-exhausted'].includes(errorStrategy(row.error).category))store.db.prepare("UPDATE internal_repairs SET status='waiting-provider' WHERE id=?").run(row.id);
  }
  enqueue(taskId,error,{sourceId=null,occurredAt=null}={}){
    if(!this.threadId)return null;
    const text=redact(String(error?.message||error)).slice(0,1500);
    const base=createHash('sha256').update(`${taskId||'background'}\0${text}`).digest('hex').slice(0,24);
    let id=base;
    const previous=this.store.db.prepare('SELECT status,updatedAt,detail FROM internal_repairs WHERE id=?').get(base);
    if(sourceId&&previous&&['resolved','validated','diagnosis-only','validation-failed'].includes(previous.status)&&!/QQ.*(?:不确定|未知)/.test(text)&&!/用户已确认停止/.test(previous.detail||'')&&Date.parse(occurredAt)>Date.parse(previous.updatedAt)+6*3600000&&this.now()-Date.parse(occurredAt)<3600000){
      const key='internal-repair:recurrence:'+base;let state={};try{state=JSON.parse(this.store.meta(key)||'{}');}catch{}
      const active=state.id&&this.store.db.prepare('SELECT status FROM internal_repairs WHERE id=?').get(state.id);
      if(active&&['pending','needs-action','sending','accepted','delivery-uncertain','result-received'].includes(active.status))return state.id;
      const sameDay=this.now()-Number(state.startedAt||0)<86400000;
      if(!sameDay||Number(state.count||0)<2){
        id=createHash('sha256').update(base+'\0'+sourceId).digest('hex').slice(0,24);
        this.store.meta(key,JSON.stringify({id,startedAt:sameDay?state.startedAt:this.now(),count:sameDay?Number(state.count||0)+1:1}));
        this.store.event(taskId||null,'internal-repair.recurrence',{previousId:base,repairId:id,sourceId});
      }
    }
    const status=['rate-limit','quota-exhausted'].includes(errorStrategy(error).category)?'waiting-provider':'pending';
    this.store.db.prepare("INSERT OR IGNORE INTO internal_repairs(id,taskId,error,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(id,taskId||null,text,status,this.store.now(),this.store.now());
    return id;
  }
  reconcileResolvedSources(){return reconcileResolvedSources(this);}
  reviewDormant(){return reviewDormant(this);}
  receive(value){
    if(value.engine!=='codex'||String(value.sessionId).replace(/^session-/,'')!==this.threadId)return false;
    const id=/\[中控内部修复 ([a-f0-9]{24})\]/.exec(String(value.request||''))?.[1];
    if(!id)return true; // Internal thread traffic never becomes a user notification.
    const row=this.store.db.prepare('SELECT status,attempts FROM internal_repairs WHERE id=?').get(id);
    if(!row||!['sending','accepted','delivery-uncertain','delivery-unresolved'].includes(row.status))return true;
    const round=Number(/\[修复轮次 (\d+)\]/u.exec(String(value.request||''))?.[1]||1);if(round!==Math.max(1,row.attempts))return true;
    const detail=redact(String(value.result||value.error||'')).slice(-12000);
    const receipt=repairReceipt(detail);
    const actionable=receipt&&['fixed','recovered'].includes(receipt.status)&&Array.isArray(receipt.changes)&&Array.isArray(receipt.checks);
    const blocked=receipt?.status==='blocked'&&['credentials','approval','external-access'].includes(receipt.blockedReason);
    const status=blocked?'blocked':value.status==='completed'&&actionable?'result-received':'needs-action';
    const feedback=status==='needs-action'?'上次执行未通过：'+detail.slice(-2200)+'\n请根据实际失败换方案继续修复；测试失败不是人工阻碍。不要只重复诊断或撤回后收尾。':null;
    this.store.db.prepare('UPDATE internal_repairs SET status=?,updatedAt=?,detail=?,feedback=?,nextAttempt=? WHERE id=?').run(status,this.store.now(),detail,feedback,this.now()+30000,id);
    return true;
  }
  async poll(){
    if(this.busy||!this.threadId)return;this.busy=true;
    try{
      this.reconcileResolvedSources();
      promoteDormant(this);
      await this.reviewDormant();
      const outstanding=this.store.db.prepare("SELECT * FROM internal_repairs WHERE status IN ('accepted','delivery-uncertain') ORDER BY createdAt LIMIT 1").get();
      if(outstanding&&!this.isRunning(outstanding.id,Math.max(1,outstanding.attempts))&&this.now()-Date.parse(outstanding.updatedAt)>=60000){
        const evidence=await this.reconcile(this.threadId,outstanding.id,{attempt:Math.max(1,outstanding.attempts)});
        if(evidence.state==='completed')this.receive(evidence);
        else if(evidence.state==='queued'&&!this.store.meta('specialists:reload')){
          // Resume that exact durable message; the engine runner starts its
          // existing queue item instead of adding a duplicate request.
          const baseline=outstanding.baseline|| (this.captureBaseline?JSON.stringify(await this.captureBaseline()):null);
          this.store.db.prepare('UPDATE internal_repairs SET updatedAt=?,baseline=? WHERE id=?').run(this.store.now(),baseline,outstanding.id);
          await this.send(this.threadId,evidence.request);
          this.store.event(outstanding.taskId,'internal-repair.queue-started',{repairId:outstanding.id,attempt:outstanding.attempts});
        }
        else if(evidence.state==='not-found'){
          this.store.db.prepare("UPDATE internal_repairs SET status='delivery-unresolved',updatedAt=?,detail=? WHERE id=? AND status IN ('accepted','delivery-uncertain')").run(this.store.now(),'Native idle state and durable history have no matching request; retained without resend.',outstanding.id);
          this.store.event(outstanding.taskId,'internal-repair.delivery-reconciled',{repairId:outstanding.id,state:'not-found',resent:false});
        }
      }
      const result=this.store.db.prepare("SELECT * FROM internal_repairs WHERE status='result-received' ORDER BY updatedAt LIMIT 1").get();
      if(result&&this.validate){
        this.validating=true;
        try{
          const verification=await this.validate(result);
          if(!settleValidatedRepair(this,result))return;
        }catch(error){if(error.code!=='REPAIR_DEFERRED'){
          this.store.db.prepare("UPDATE internal_repairs SET status='needs-action',updatedAt=?,feedback=?,nextAttempt=? WHERE id=? AND status='result-received'").run(this.store.now(),redact(String(error.message)).slice(-5000),this.now()+30000,result.id);
          this.store.event(result.taskId,'internal-repair.verification-rejected',{repairId:result.id,error:redact(error.message).slice(-1000)});
        }}finally{this.validating=false;}
        return;
      }
      // Include service/background errors as well as task.fail; skip old history
      // on first install, but keep every new source in a durable association.
      const since=this.store.meta('internal-repair:since')||'1970-01-01T00:00:00.000Z';
      this.store.meta('internal-repair:since',since);
      for(const error of this.store.db.prepare('SELECT * FROM errors WHERE createdAt>=? AND id NOT IN (SELECT errorId FROM internal_repair_sources) ORDER BY createdAt LIMIT 20').all(since)){
        const id=this.enqueue(error.taskId,error.message,{sourceId:error.id,occurredAt:error.createdAt});
        this.store.db.prepare('INSERT OR IGNORE INTO internal_repair_sources VALUES(?,?)').run(error.id,id);
      }
      // Serialize diagnostics in the fixed repair conversation, never pile up
      // repeated model runs while its previous report is still outstanding.
      if(this.store.db.prepare("SELECT 1 FROM internal_repairs WHERE status IN ('accepted','delivery-uncertain') LIMIT 1").get())return;
      if(this.store.meta('specialists:reload'))return;
      const row=this.store.db.prepare("SELECT * FROM internal_repairs WHERE status IN ('pending','needs-action') AND nextAttempt<=? ORDER BY CASE status WHEN 'needs-action' THEN 0 ELSE 1 END,createdAt DESC LIMIT 1").get(this.now());
      if(!row)return;
      if(row.attempts>=repairAttemptLimit(this,row)){this.store.db.prepare("UPDATE internal_repairs SET status='blocked',updatedAt=? WHERE id=?").run(this.store.now(),row.id);this.store.event(row.taskId,'internal-repair.exhausted',{repairId:row.id,reason:row.feedback||row.detail});return;}
      const attempt=row.attempts+1;
      const order=this.workOrderRoot?await writeRepairWorkOrder({store:this.store,root:this.workOrderRoot,row,attempt}):null;
      const prompt=`[中控内部修复 ${row.id}] [修复轮次 ${attempt}] `+(order?`读取工单 ${order}，按协议执行修复并针对性验证，完成代码候选后交独立验收。`:`先读 D:/ai中控/docs/自动修复执行协议.md，然后执行修复并验证。错误：${row.error}\n任务引用：${row.taskId||'后台服务'}。${row.feedback?'上一轮独立验收反馈：'+row.feedback.slice(-1800):''}`);
      const baseline=this.captureBaseline?JSON.stringify(await this.captureBaseline()):row.baseline;
      this.store.db.prepare("UPDATE internal_repairs SET status='sending',attempts=?,updatedAt=?,baseline=? WHERE id=?").run(attempt,this.store.now(),baseline,row.id);
      try{
        await this.send(this.threadId,prompt);
        this.store.db.prepare("UPDATE internal_repairs SET status='accepted',updatedAt=? WHERE id=? AND status='sending'").run(this.store.now(),row.id);
        this.store.event(row.taskId,'internal-repair.accepted',{repairId:row.id,threadId:this.threadId});
      }catch(error){
        const attempts=row.attempts+1;
        const definiteRejection=error.code==='ENOENT'||/executable missing|thread not found|unknown thread|invalid argument/i.test(String(error.message));
        const uncertain=!definiteRejection;
        this.store.db.prepare('UPDATE internal_repairs SET status=?,attempts=?,nextAttempt=?,updatedAt=?,detail=? WHERE id=?').run(uncertain?'delivery-uncertain':attempts>=3?'delivery-failed':'pending',attempts,this.now()+Math.min(300000,30000*2**attempts),this.store.now(),redact(String(error.message)).slice(0,500),row.id);
      }
    }finally{this.busy=false;}
  }
}
