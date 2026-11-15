import {redact} from '../redact.mjs';
import {repairReceipt} from './repair-contract.mjs';
import {Archive} from '../knowledge/archive.mjs';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

export function repairAttemptLimit(service,row){
 for(const record of service.store.db.prepare("SELECT value FROM metadata WHERE key LIKE 'internal-repair:maintenance:%'").all()){
  try{const plan=JSON.parse(record.value);if(plan.leaderId===row.id)return Math.min(3,plan.allocatedAttempts+plan.maintenanceBudget);}catch{}
 }
 return 3;
}

export async function verifyMaintenanceEvidence({store,root,result}){
 const members=[result,...store.db.prepare("SELECT * FROM internal_repairs WHERE leaderId=? AND status='coalesced'").all(result.id)];
 if(maintenanceFamily(result)!=='archive-time-budget')return;
 const archive=new Archive({db:store.db,root:join(root,'runtime','knowledge'),allowedRoots:[join(root,'runtime','workspaces')]});
 for(const member of members){
  const task=store.task(member.taskId),name=/^归档跳过 (.*?)：/.exec(member.error)?.[1];
  if(!task||!name)throw Error('归档修复缺少任务与文件来源');
  const source=resolve(task.cwd,'outputs',task.id,name),hash=createHash('sha256').update(await readFile(source)).digest('hex');
  const record=(await archive.list({taskId:task.id})).find(r=>r.name===name&&r.sourcePath===source&&r.hash===hash);
  if(!record)throw Error('尚未恢复对应任务的归档：'+task.id+'/'+name);
  const archived=await archive.resolveFile(record.id);
  if(createHash('sha256').update(await readFile(archived)).digest('hex')!==hash)throw Error('归档副本与源文件hash不一致');
 }
}

export function maintenanceFamily(row){
 if(/用户已确认停止/.test(row.detail||'')||['approval','credentials','external-access'].includes(repairReceipt(row.detail)?.blockedReason))return null;
 if(/^归档跳过 .+：collection time limit reached/.test(row.error))return 'archive-time-budget';
 if(/^主管同一轮重复输出了 \[HUB-DISPATCH\]$/.test(row.error))return 'duplicate-dispatch';
 if(/^DSH event stream (?:is not connected|reconnect failed: connect ECONNREFUSED 127\.0\.0\.1:3080)$/.test(row.error))return 'dsh-local-stream';
 if(/^中枢人设与记忆插件尚未就绪/.test(row.error))return 'persona-plugin-readiness';
 if(/^维护助手：Command failed: .*node(?:\.exe)? --test test\/\*\.test\.mjs\s*$/.test(row.error))return 'test-runner-glob';
 return null;
}

export function promoteDormant(service){
 const {store}=service;
 if(store.meta('specialists:reload')||store.db.prepare("SELECT 1 FROM internal_repairs WHERE status IN ('pending','needs-action','sending','accepted','delivery-uncertain','result-received') LIMIT 1").get())return;
 const rows=store.db.prepare("SELECT id,taskId,error,status,attempts,detail FROM internal_repairs WHERE status IN ('diagnosis-only','validation-failed','blocked') ORDER BY createdAt").all();
 const groups=new Map();for(const row of rows){const family=maintenanceFamily(row);if(family){if(!groups.has(family))groups.set(family,[]);groups.get(family).push(row);}}
 for(const [family,members] of [...groups].sort(([a],[b])=>(a==='archive-time-budget'?-1:0)-(b==='archive-time-budget'?-1:0))){
  const key='internal-repair:maintenance:'+family;if(store.meta(key))continue;
  const leader=members.find(row=>row.attempts<3);if(!leader)continue;
  const instruction=`这是合并后的能力维护，不是重做历史业务。类别 ${family}，关联记录 ${members.map(r=>r.id).join(',')}。保留旧任务失败状态、原话、凭据、模型与个人历史，不重发QQ/邮件、不执行原桌面操作、不做临时模型探测或调用业务工作席。对归档超时只使用现有Archive.collect复制各任务cwd/outputs/taskId中的产物，逐条核实源文件与归档hash；不得重跑产物生成。对连接故障使用现有内部验收器；对派单/测试入口/插件问题核实现行源码与针对性回归及真实能力证据。已恢复要交付有来源的recovered回执；仍存在就实际修复；没有证据或外部阻碍明确保留，不以在线冒充历史任务完成。`;
  store.transaction(()=>{
   store.meta(key,JSON.stringify({leaderId:leader.id,members:members.map(r=>r.id),allocatedAttempts:leader.attempts,maintenanceBudget:1,allocatedAt:store.now(),terminalCondition:'one maintenance round; independent validation required; no budget reset'}));
   store.db.prepare("UPDATE internal_repairs SET status='pending',feedback=?,nextAttempt=0,updatedAt=? WHERE id=? AND status=?").run(instruction,store.now(),leader.id,leader.status);
   for(const row of members)if(row.id!==leader.id)store.db.prepare("UPDATE internal_repairs SET status='coalesced',leaderId=?,updatedAt=? WHERE id=? AND status=?").run(leader.id,store.now(),row.id,row.status);
   store.event(leader.taskId,'internal-repair.maintenance-promoted',{repairId:leader.id,family,members:members.map(r=>r.id),oldAttempts:leader.attempts,maintenanceBudget:1});
  });
  return leader.id;
 }
}

export function settleRepairFamily(service,leaderId){
 const {store}=service;
 const leader=store.db.prepare('SELECT * FROM internal_repairs WHERE id=?').get(leaderId);
 if(leader?.status!=='validated')return;
 if(maintenanceFamily(leader)==='archive-time-budget'){
  for(const row of [leader,...store.db.prepare('SELECT taskId FROM internal_repairs WHERE leaderId=?').all(leaderId)])if(row.taskId)store.collection(row.taskId,'done');
 }
 for(const member of store.db.prepare("SELECT id FROM internal_repairs WHERE leaderId=? AND status='coalesced'").all(leaderId)){
  const ids=store.db.prepare('SELECT errorId FROM internal_repair_sources WHERE repairId=?').all(member.id).map(r=>r.errorId);
  if(ids.length)store.clearErrors(ids,{reason:'recovered'});
  store.db.prepare("UPDATE internal_repairs SET status='resolved',updatedAt=? WHERE id=? AND status='coalesced'").run(store.now(),member.id);
  store.event(null,'internal-repair.family-resolved',{repairId:member.id,leaderId,evidence:'independently validated shared maintenance; original task not replayed'});
 }
}

export function settleValidatedRepair(service,row){
 const {store}=service;
 const changed=store.db.prepare("UPDATE internal_repairs SET status='validated',updatedAt=? WHERE id=? AND status=? AND attempts=? AND detail IS ?").run(store.now(),row.id,row.status,row.attempts,row.detail);
 if(!changed.changes)return false;
 const ids=store.db.prepare('SELECT errorId FROM internal_repair_sources WHERE repairId=?').all(row.id).map(r=>r.errorId);
 if(ids.length)store.clearErrors(ids,{reason:'recovered'});
 settleRepairFamily(service,row.id);
 store.event(row.taskId,'internal-repair.validated',{repairId:row.id});
 return true;
}

export function codexWriterRecovery(store, row) {
 const task=store.task(row.taskId);
 if(task?.engine!=='codex'||!task.sessionId)return null;
 const terminal=store.db.prepare(`SELECT e.id,e.createdAt,e.type FROM events e JOIN tasks t ON t.id=e.taskId
   WHERE t.engine='codex' AND t.sessionId=? AND e.createdAt>=? AND (
     (e.type='completed' AND NULLIF(json_extract(e.data,'$.nativeTurnId'),'') IS NOT NULL) OR
     (e.type='failed' AND json_extract(e.data,'$.error') LIKE '%already has an active writer%'))
   ORDER BY e.id DESC LIMIT 1`).get(task.sessionId,row.createdAt);
 return terminal?.type==='completed'?terminal:null;
}

export function reconcileResolvedSources(service){
    const {store}=service;
    for(const row of store.db.prepare("SELECT * FROM internal_repairs WHERE status='blocked' AND error LIKE '%already has an active writer%'").all()){
      if(/用户已确认停止/.test(row.detail||''))continue;
      const proof=codexWriterRecovery(store,row);
      if(proof)store.transaction(()=>{
        const ids=store.db.prepare('SELECT errorId FROM internal_repair_sources WHERE repairId=?').all(row.id).map(item=>item.errorId);
        if(ids.length)store.clearErrors(ids,{reason:'recovered'});
        store.db.prepare("UPDATE internal_repairs SET status='resolved',updatedAt=? WHERE id=? AND status='blocked'").run(store.now(),row.id);
        store.event(row.taskId,'internal-repair.codex-writer-recovered',{repairId:row.id,completedEventId:proof.id});
      });
    }
    // A terminal completion of this exact task after this exact incident is
    // stronger evidence than a later unrelated task or HTTP/model readiness.
    for(const row of service.store.db.prepare(`SELECT r.id,r.taskId,r.error,r.status,r.detail FROM internal_repairs r JOIN tasks t ON t.id=r.taskId
      WHERE t.status='completed' AND r.status IN ('diagnosis-only','validation-failed','blocked')`).all()){
      if(/用户已确认停止/.test(row.detail||'')||!/fetch failed|\bTIMEOUT\b|DSH event stream|\bTRANSPORT\b/.test(row.error))continue;
      const proof=service.store.db.prepare(`SELECT c.id,c.createdAt FROM events c WHERE c.taskId=? AND c.type='completed'
        AND (EXISTS(SELECT 1 FROM events f WHERE f.taskId=c.taskId AND f.type='failed' AND json_extract(f.data,'$.error')=? AND f.id<c.id)
          OR EXISTS(SELECT 1 FROM internal_repair_sources s JOIN errors e ON e.id=s.errorId WHERE s.repairId=? AND e.taskId=c.taskId AND e.createdAt<c.createdAt))
        ORDER BY c.id DESC LIMIT 1`).get(row.taskId,row.error,row.id);
      if(!proof)continue;
      const ids=service.store.db.prepare('SELECT errorId FROM internal_repair_sources WHERE repairId=?').all(row.id).map(x=>x.errorId);
      if(ids.length)service.store.clearErrors(ids,{reason:'recovered'});
      const changed=service.store.db.prepare("UPDATE internal_repairs SET status='resolved',updatedAt=? WHERE id=? AND status=?").run(service.store.now(),row.id,row.status);
      if(changed.changes)service.store.event(row.taskId,'internal-repair.exact-task-resolved',{repairId:row.id,completedEventId:proof.id,completedAt:proof.createdAt,replayed:false});
    }
    // Only the existing Hub audit written after a verified recovery can settle
    // a legacy repair. Missing/deleted errors alone are deliberately ignored.
    const candidates=service.store.db.prepare(`SELECT r.id,r.createdAt,r.status,r.detail
      FROM internal_repairs r WHERE r.status IN ('pending','needs-action','diagnosis-only','validation-failed','accepted','delivery-uncertain','blocked','waiting-provider','delivery-unresolved')
        AND EXISTS(SELECT 1 FROM internal_repair_sources s WHERE s.repairId=r.id)`).all();
    const recovery=new Map();
    if(candidates.length)for(const row of service.store.db.prepare("SELECT data,createdAt FROM events WHERE type='error.cleared'").all()){
      try{const audit=JSON.parse(row.data);if(!['recovered','native-sync-completed'].includes(audit.reason))continue;
        const at=Date.parse(row.createdAt);if(Number.isFinite(at)&&at>(recovery.get(audit.errorId)??-Infinity))recovery.set(audit.errorId,at);
      }catch{}
    }
    let changed=0;
    for(const repair of candidates){
      if(/用户已确认停止/.test(repair.detail||''))continue;
      if(service.isRunning(repair.id,Math.max(1,service.store.db.prepare('SELECT attempts FROM internal_repairs WHERE id=?').get(repair.id)?.attempts||1)))continue;
      const sources=service.store.db.prepare('SELECT errorId FROM internal_repair_sources WHERE repairId=?').all(repair.id);
      const proven=sources.every(({errorId})=>recovery.has(errorId)&&recovery.get(errorId)>=Date.parse(repair.createdAt));
      if(!proven)continue;
      const stillOpen=service.store.db.prepare(`SELECT 1 FROM errors e JOIN internal_repair_sources s ON s.errorId=e.id WHERE s.repairId=? LIMIT 1`).get(repair.id);
      if(stillOpen)continue;
      const detail=JSON.stringify({previousDetail:repair.detail||null,resolution:'all source errors have verified recovery audit',sources:sources.map(x=>x.errorId)});
      const result=service.store.db.prepare("UPDATE internal_repairs SET status='resolved',detail=?,updatedAt=? WHERE id=? AND status=?").run(detail,service.store.now(),repair.id,repair.status);
      if(result.changes){changed++;service.store.event(null,'internal-repair.resolved',{repairId:repair.id,sources:sources.map(x=>x.errorId),evidence:'error.cleared audit'});}
    }
    return changed;
  }
export async function reviewDormant(service){
    // A review reads evidence; it never resets execution attempts or resends work.
    // Reserve the budget before I/O so restarts cannot recreate a retry loop.
    const candidate=service.store.db.prepare(`SELECT id,detail FROM internal_repairs WHERE status IN
      ('diagnosis-only','validation-failed','blocked','waiting-provider','delivery-unresolved')
      AND reviewAttempts<3 AND nextReview<=? AND instr(coalesce(detail,''),'用户已确认停止')=0
      ORDER BY nextReview,createdAt`).all(service.now()).find(candidate=>!['approval','credentials','external-access'].includes(repairReceipt(candidate.detail)?.blockedReason));
    if(!candidate)return;
    const row=service.store.db.prepare('SELECT * FROM internal_repairs WHERE id=?').get(candidate.id);
    if(/用户已确认停止/.test(row.detail||'')||repairReceipt(row.detail)?.blockedReason==='approval')return;
    const claimed=service.store.db.prepare(`UPDATE internal_repairs SET reviewAttempts=reviewAttempts+1,nextReview=?
      WHERE id=? AND status=? AND reviewAttempts=?`).run(service.now()+6*3600000,row.id,row.status,row.reviewAttempts);
    if(!claimed.changes)return;
    let evidence='no-new-proof';
    try{
      if(row.status==='delivery-unresolved'){
        const native=await service.reconcile(service.threadId,row.id,{attempt:Math.max(1,row.attempts)});
        evidence=native.state;
        if(native.state==='completed')service.receive(native);
      }
      // Source recovery audits are checked for every category above. A valid
      // existing receipt may also be independently checked without native replay.
      else if(/QQ.*(?:发送|通知|send|回执)/i.test(row.error)){
        // Later QQ success proves current connectivity, not delivery of this
        // historical message. Retain it until its exact receipt is reconciled.
        evidence='exact-delivery-proof-required';
      }
      else if(service.validate&&['fixed','recovered'].includes(repairReceipt(row.detail)?.status)){
        service.validating=true;
        await service.validate(row);
        if(settleValidatedRepair(service,row))evidence='independently-validated';
      }
    }catch(error){evidence=redact(String(error.message)).slice(-1000);}
    finally{service.validating=false;}
    service.store.event(row.taskId,'internal-repair.reviewed',{repairId:row.id,review:row.reviewAttempts+1,evidence,resent:false});
  }
