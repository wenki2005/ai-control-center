import { createHash, randomUUID } from 'node:crypto';
import { enqueueTaskEvent } from './event-chain.mjs';
import { conversationalParts, userFacingTaskText } from '../delivery.mjs';
import { redact } from '../redact.mjs';

const role = 'codex-direct';
const restartReason = '中控曾退出；请显式继续，防止重复执行。';
const recoveryReason = 'Codex 连接中断，等待核对原回合。';
const recoveryEvent = 'codex-direct.reconcile';
const recoveryBudgetMs = 120_000;
const digest = value => createHash('sha256').update(value).digest('hex');

export class CodexDirect {
  constructor(hub) {
    this.hub = hub;
    this.store = hub.store;
    this.inputs = new Map();
    this.current = null;
  }

  enqueue(text, { source, messageKey } = {}) {
    const { hub, store } = this;
    const id = `t-codex-direct-${messageKey ? digest(String(messageKey)).slice(0, 24) : randomUUID()}`;
    if (store.task(id)) return {ok:true,repair:true,duplicate:true};
    store.transaction(()=>{
      store.createTask({id,engine:'codex',role,sessionId:hub.codexRepairThreadId,cwd:hub.workspaceRoot,prompt:text});
      store.event(id,'codex-direct.enqueued',{fingerprint:digest(text),qq:source!=='web'});
    });
    this.inputs.set(id,text);
    hub.emit();
    this.pump();
    return {ok:true,repair:true};
  }

  pump() {
    const { hub, store } = this;
    if(this.current||hub.stopping||!hub.codexRepairThreadId||!hub.adapters.codex?.start)return;
    const task=store.db.prepare(`SELECT t.*,e.data AS queueData FROM tasks t JOIN events e ON e.taskId=t.id AND e.type='codex-direct.enqueued'
      WHERE t.role=? AND t.sessionId=? AND (t.status='queued' OR (t.status='interrupted' AND t.error IN (?,?)))
      ORDER BY t.createdAt,t.rowid LIMIT 1`).get(role,hub.codexRepairThreadId,restartReason,recoveryReason);
    if(!task)return;
    const data=JSON.parse(task.queueData);
    const recovering=task.status==='interrupted';
    const prompt=this.inputs.get(task.id)??task.prompt;
    this.inputs.delete(task.id);
    if(!recovering&&digest(prompt)!==data.fingerprint){
      this.finish(task,data,{type:'failed',error:'中枢无法恢复这条直连原文，请在原 Codex 会话检查。'});
      return;
    }
    this.current=task.id;
    if(recovering&&this.recoveryBlocked(task.id)){
      this.finish(task,data,{type:'failed',error:'这条消息有未结审批或停止请求，请在原 Codex 会话查看。'});
      return;
    }
    const checkpoint=recovering?this.reconciliation(task.id):null;
    const runVersion=task.runVersion+1;
    const isCurrent=()=>this.current===task.id&&!hub.stopping&&store.task(task.id)?.runVersion===runVersion;
    store.update(task.id,{status:'running',runVersion,error:null});
    const onEvent=event=>enqueueTaskEvent(hub,task.id,async()=>{
      if(!isCurrent())return;
      if(event.type==='approval')return hub.handle(task.id,event);
      if(event.type==='progress'&&event.kind==='codex-direct-queued'){
        this.progress(task,data,'queued',{},'原话已进入 Codex 队列，我会在后台启动这个回合。');
      }
      if(event.type==='progress'&&event.kind==='codex-direct-started'){
        this.progress(task,data,'started',{nativeTurnId:event.nativeTurnId},'Codex 已开始处理这条消息。');
      }
      if(event.type==='failed'&&this.reconcile(task.id,event))return;
      if(event.type==='completed'||event.type==='failed')this.finish(task,data,event);
    },error=>{
      if(!isCurrent())return;
      if(event.type==='completed'||event.type==='failed')return this.finish(task,data,event);
      store.error(task.id,'Codex 直连状态记录失败：'+error.message);
    });
    // Recovery only recognizes an existing native ID. A redacted snapshot
    // can identify that record and must never be sent as a new prompt.
    void Promise.resolve().then(()=>hub.adapters.codex.start({...task,prompt:recovering?'':prompt,preserveNativeSession:true,
      nativeQueue:{clientUserMessageId:task.id,existingOnly:recovering,...checkpoint}},onEvent)).catch(error=>onEvent({type:'failed',error:error.message}));
  }

  reconciliation(id) {
    const row=this.store.db.prepare('SELECT data FROM events WHERE taskId=? AND type=? LIMIT 1').get(id,recoveryEvent);
    return row?JSON.parse(row.data):null;
  }

  recoveryBlocked(id) {
    return this.store.db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM approvals WHERE taskId=? AND status IN ('pending','resolving','recovery_required'))
      OR EXISTS(SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested')`).get(id,id);
  }

  reconcile(id,event) {
    if(event.kind!=='codex-direct-transport-lost'||!event.originalTurnId||this.reconciliation(id)||this.recoveryBlocked(id))return false;
    const {hub,store}=this;
    store.transaction(()=>{
      store.event(id,recoveryEvent,{followTurnId:event.originalTurnId,followDeadlineAt:Date.now()+recoveryBudgetMs});
      store.update(id,{status:'interrupted',error:recoveryReason});
    });
    this.current=null;
    hub.emit();
    queueMicrotask(()=>this.pump());
    return true;
  }

  persistNotice(task,data,stage,text) {
    const parts=data.qq
      ?this.hub.notification(text,`codex-direct:${task.id}:${stage}`,{deferNotify:true}).map(row=>row.text)
      :conversationalParts(userFacingTaskText(text));
    for(const part of parts)this.store.say('assistant',part,{source:'codex-repair'});
  }

  progress(task,data,stage,detail,notice) {
    const {hub,store}=this;
    const type=`codex-direct.${stage}`;
    if(store.db.prepare('SELECT 1 FROM events WHERE taskId=? AND type=? LIMIT 1').get(task.id,type))return;
    store.transaction(()=>{
      store.event(task.id,type,detail);
      this.persistNotice(task,data,stage,notice);
    });
    hub.emit();
    if(data.qq)void hub.notify();
  }

  finish(task,data,event) {
    const { hub, store }=this;
    const success=event.type==='completed';
    const result=String(redact(event.text||'')).trim();
    const error=success?null:String(redact(event.error||'执行状态未确认')).slice(0,500);
    const notice=success?(result||'Codex 回合已完成，原会话没有返回文字。')
      :event.nativeTurnId?`Codex 回合未完成。${error}`
      :`这条直连消息的执行状态尚未确认。${error}`;
    store.transaction(()=>{
      store.update(task.id,{status:success?'completed':event.nativeTurnId?'failed':'interrupted',result:result||null,error});
      store.event(task.id,success?'completed':'failed',{nativeTurnId:event.nativeTurnId||null,source:'codex-direct',error});
      store.db.prepare("UPDATE approvals SET status='interrupted',updatedAt=? WHERE taskId=? AND status IN ('pending','resolving')").run(store.now(),task.id);
      this.persistNotice(task,data,'result',notice);
    });
    this.current=null;
    hub.emit();
    if(data.qq)void hub.notify();
    queueMicrotask(()=>this.pump());
  }

  cancelled(id) {
    this.inputs.delete(id);
    if(this.current===id)this.current=null;
    queueMicrotask(()=>this.pump());
  }
}
