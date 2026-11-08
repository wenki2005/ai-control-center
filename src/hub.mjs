import {qqReplyContext,approvalOptionAnswer} from './qq-reply-context.mjs';
import {dshFollowIdentity} from './lifecycle/dsh-reload.mjs';
import {cleanConversationalStyle} from './speech-style-policy.mjs';
import {prepareQqFileContext} from './qq-file-context.mjs';
import {fileDeliveryContext} from './hub/file-delivery-context.mjs';
import {finishFileDelivery} from './hub/file-delivery.mjs';
import {requestsSharedScreen,requestsScreenPicker} from './prompts/screen-share-request.mjs';
import{parseStopRequest}from'./hub/stop-request.mjs';
import {DirectorContinuity} from './lifecycle/director-continuity.mjs';
import {retryFixedWorkerContext} from './lifecycle/worker-continuity.mjs';
import {taskTitleLookup} from './hub/session-titles.mjs';
import {enqueueTaskEvent} from './hub/event-chain.mjs';
import {InternalRepair} from './observability/internal-repair.mjs';
import {inspectRepairThread,runRepairTurn} from './observability/codex-repair-runner.mjs';
import {repairDeliveryState} from './observability/repair-delivery-state.mjs';
import {repairBaseline} from './observability/repair-contract.mjs';
import {repairValidator} from './observability/repair-acceptance.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, statSync, globSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { realpath, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from './redact.mjs';
import { conversationalParts } from './delivery.mjs';
import { CompanionConversation, conversationMessages } from './companion-conversation.mjs';
import { isMenuCommand, quickMenu, voiceModeCommand } from './quick-menu.mjs';
import { sessionDisplayName } from './session-label.mjs';
import { isInternalArtifact, isQqShareableArtifact } from './knowledge/share-policy.mjs';
import { collectTaskDeliverables } from './knowledge/task-deliverables.mjs';
import { RepairReturns } from './repair-return.mjs';
import { resolveCodexExecutable } from './adapters/codex.mjs';
import { buildTaskPrompt } from './prompts/task.mjs';
import { loadSessionDocuments } from './prompts/session-documents.mjs';
import { recentNativeContinuity, recentNativeControlState, writeNativeContext, directorRequestReferences } from './prompts/native-context.mjs';
import {notificationContext} from './knowledge/notification-context.mjs';
import { allowsEngine,requestedEngine,resolveDispatchEngine,parseExplicitEngineCommand,requiresPhoneResource } from './routing/engine-policy.mjs';
import { parseProtocolObject } from './protocol/director-output.mjs';
import { parseChatOutput } from './protocol/chat-output.mjs';
import { taskFailureDiagnostic } from './observability/task-failure.mjs';
import { reconcileDirectBridgeRecords } from './lifecycle/direct-bridges.mjs';
import { WorkerSupervision } from './hub/worker-supervision.mjs';
import { resolveWorkerContext } from './routing/dispatch-context.mjs';
import { publishSupervisorProgress,stripSupervisorAck,linkedSupervisorTask,supervisorDispatches,stripSupervisorDispatches } from './hub/supervisor-progress.mjs';
import {contextInputTokens} from './prompts/review-context.mjs';
import { retractChatMessage } from './hub/chat-retraction.mjs';
import { fixedWorkerContext,selectFixedWorkerContext,fixedWorkerSlotForTask,fixedWorkerSlotCount,fixedWorkerHasPending,rememberFixedWorker,fixedWorkerBusy } from './routing/fixed-worker.mjs';
import { buildWorkHandoff } from './hub/work-handoff.mjs';
import {compactNativeHandoff} from './prompts/chat-runtime.mjs';
import { guardControlCommand } from './hub/control-confirmation.mjs';
import { TaskAmendments } from './hub/task-amendments.mjs';
import {TaskErrorRetries} from './lifecycle/task-error-retries.mjs';
import {errorStrategy} from './error-strategy.mjs';

const active=new Set(['queued','running','waiting']);
const execFileAsync=promisify(execFile);
const SESSION_GENERIC_TERMS=new Set([
  '只读','只回','回报','任务','结果','项目','文件','创建','修改','运行','命令','执行','实际','当前','检查','完成','使用','进行','一次','返回','系统','问题','工作','报告',
  '不要','调用','工具','回复','仅回','只用','文字','收到','正常','连接','验收','联调','自检','视觉','模型','会话','请求','帮我','请只','请仅','任何','这一','句话','一下','你好',
]);
function sessionTerms(value) {
  const text=String(value||'').toLocaleLowerCase()
    .replace(/(?:请)?(?:仅|只)(?:用)?(?:文字|文本)?回复[“"「][^”"」]{0,180}[”"」]/gu,' ')
    .replace(/不要(?:调用|使用).{0,24}(?:任何)?工具/gu,' ')
    .replace(/不要(?:创建|修改).{0,24}文件/gu,' ')
    .replace(/只回复这一句话/gu,' ');
  const words=new Set((text.match(/[a-z0-9][a-z0-9_-]{1,}/giu)||[]).map(item=>item.toLocaleLowerCase()));
  for(const block of text.match(/[\u4e00-\u9fff]{2,}/gu)||[])for(let i=0;i<block.length-1;i++)words.add(block.slice(i,i+2));
  return new Set([...words].filter(term=>!SESSION_GENERIC_TERMS.has(term)));
}
export function userFacingTaskText(value) {
  return cleanConversationalStyle(String(value ?? '').replace(/(?:任务\s*(?:ID|编号|标识)\s*[:：]?\s*)?\bt-[a-f0-9][a-f0-9-]{7,}\b[。；;]?/gi,'').trim());
}
export function dispatchEngineName(engine) {return engine==='codex'?'Codex':engine==='workbuddy'?'WorkBuddy':engine==='dsh'?'DSH':String(engine || '引擎');}
function bodyText(payload) {
  const content=Array.isArray(payload?.content)?payload.content:[];
  return content.map(part=>part?.text || '').filter(Boolean).join('\n') || String(payload?.text || '');
}
export function dispatchTopicOf(prompt) {
  const clauses=String(prompt || '').split(/[。，,；;！!？?\n\r]+/).map(part=>part.trim()).filter(Boolean);
  for(const clause of clauses) {
    if(/dsh|codex|workbuddy|交给你|交给您|派给你/i.test(clause))continue;
    const cleaned=clause.replace(/^(?:(?:嗯|那个|就是|先|帮我|请|麻烦|你|能不能|可以|能否|去|来))+/u,'').replace(/[了啦呀吧呢嘛啊]+$/u,'').trim();
    if(cleaned.length>=5)return cleaned.slice(0,26);
  }
  return '';
}
/** 派发确认只保留执行引擎和从用户请求提取的短主题。 */
export function dispatchNoticeFor({engine,prompt,sessionName}={}) {
  const topic=dispatchTopicOf(prompt);
  if(sessionName)return `已交给 ${dispatchEngineName(engine)} 会话「${sessionName}」处理，我每 5 分钟看进度，有变化就告诉你。`;
  return `已交给 ${dispatchEngineName(engine)}${topic?'处理：'+topic:'处理'}，我每 5 分钟看进度，有变化就告诉你。`;
}

function parseRequestedPdfPages(value) {
  const text=String(value||''),match=/第\s*(\d+)(?:\s*[-–~至]\s*(\d+))?\s*页/.exec(text);
  if(!match)return {query:text.trim(),pages:null};
  const first=Number(match[1]),last=Number(match[2]||match[1]);
  if(first<1||last<first||last-first>=4)throw Error('一次最多请视觉会话查看 PDF 的 4 页；可以分几次指定页码。');
  return {query:text.replace(match[0],' ').replace(/\s+/g,' ').trim(),pages:Array.from({length:last-first+1},(_,index)=>first+index)};
}
export class Hub {
  constructor({store,archive,adapters,workspaceRoot,visualCacheRoot=join(workspaceRoot,'_visual-cache'),directorProjectPath=null,codexDefaultModel,workbuddyDefaultModel,codexRepairThreadId=null,codexAutoRepairThreadId=null,codexQueuePath=null,codexSessionRoot=null,directorContextLimit=50000,directorHandoffEnabled=true,directorQueueLimit=100,primaryMode=false,fixedWorkers=true,setQqMode,notify=()=>{},onChange=()=>{},contactOnline=()=>true,onEngineOutcome=()=>{}}) {
    Object.assign(this,{store,archive,adapters,workspaceRoot,visualCacheRoot,directorProjectPath,codexDefaultModel,workbuddyDefaultModel,codexRepairThreadId,codexAutoRepairThreadId,codexQueuePath,codexSessionRoot:codexSessionRoot || (process.env.CODEX_SESSION_ROOT || ''),directorContextLimit,directorHandoffEnabled,directorQueueLimit:Math.max(1,Math.min(1000,Math.floor(Number(directorQueueLimit)||100))),primaryMode,setQqMode,notify,onChange,contactOnline});
    this.continuity=new DirectorContinuity(this);
    this.chains=new Map();this.answering=new Set();this.maxConcurrent=8;this.directBridge=null;this.directQueue=Promise.resolve();
    // A reconnect/retry can surface the same completed narration twice within
    // a few milliseconds. Keep the durable history intact, but suppress the
    // second user-facing copy in the short duplicate window.
    this.recentReplies=new Map();
    this.internalRepair=new InternalRepair({store,threadId:codexAutoRepairThreadId,workOrderRoot:resolve(workspaceRoot,'../..'),captureBaseline:()=>repairBaseline(resolve(workspaceRoot,'../..')),validate:repairValidator({store,root:resolve(workspaceRoot,'../..')}),
      isRunning:(id,attempt)=>['running','waiting'].includes(store.task(`t-repair-${id}-${attempt}`)?.status),
      reconcile:(thread,id,options)=>repairDeliveryState(thread,id,{...options,readNative:()=>inspectRepairThread(thread,{command:this.codexQueuePath})}),
      send:(thread,prompt)=>runRepairTurn(this,thread,prompt,{cwd:resolve(workspaceRoot,'../..')})});
    this.sessionDocumentLoads=new Map();
    this.conversation=new CompanionConversation(store);
    this.amendments=new TaskAmendments({store});
    this.errorRetries=new TaskErrorRetries(this);
    this.fixedWorkers=fixedWorkers;
    reconcileDirectBridgeRecords(this.store);
    this.onEngineOutcome=onEngineOutcome;
    this.store.db.exec('CREATE INDEX IF NOT EXISTS tasks_session_origin ON tasks(role,sessionId,createdAt)');
    this.workerSupervision=new WorkerSupervision({store,reports:()=>this.reports,
      sessionTitleForTask:task=>this.sessionTitleForTask(task),createDirector:options=>this.create({...options,role:'director'}),
      stopping:()=>this.stopping,
      paused:task=>this.errorRetries.pending(task.id),
      reconcileTask:task=>this.adapters[task.engine]?.reconcile?.(task),
      nativeSessions:()=>this.nativeTasks?.listSessions?.(),
      failTask:(task,error)=>this.fail(task.id,error)});
    this.repairReturns=this.codexRepairThreadId?new RepairReturns({store,threadId:this.codexRepairThreadId,sessionRoot:this.codexSessionRoot,
      notify:(text,key)=>this.notification(text,key),onReply:text=>this.say(text,{source:'codex-repair'})}):null;
  }
  emit() { this.onChange(); }
  directorEngine() {
    return this.store.meta('directorEngine') === 'codex' ? 'codex' : 'dsh';
  }
  workerEngine() {const value=this.store.meta('workerEngine');return ['dsh','codex','auto'].includes(value)?value:'dsh';}
  setWorkerEngine(engine) {
    if(!['dsh','codex','auto'].includes(engine))throw Error('请选择 DSH、Codex 或自动选择');
    if(engine!=='auto'&&!this.adapters[engine]?.start)throw Error('所选任务引擎当前未接入');
    const previous=this.workerEngine();this.store.meta('workerEngine',engine);
    this.store.event(null,'worker.engine-changed',{from:previous,to:engine});this.emit();return {engine,changed:previous!==engine};
  }
  directorBusy() {
    return Boolean(this.diaryBusy || this.store.db.prepare("SELECT id FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status IN ('queued','running','waiting') LIMIT 1").get());
  }
  setDirectorEngine(engine) {
    if(!['dsh','codex'].includes(engine))throw Error('一级主管会话只支持 DSH 或 Codex');
    if(!this.adapters[engine]?.start)throw Error(`${engine==='codex'?'Codex':'DSH'} 当前没有可用的会话适配器`);
    if(this.directorBusy())throw Error('主管对话正在处理消息，完成后再切换接入引擎');
    const previous=this.directorEngine();
    if(previous===engine)return {engine,changed:false,continuityPending:!!this.pendingDirectorHandoff()};
    const previousSession=this.store.meta('directorSessionId');
    if(previousSession) {
      const payload=this.directorSnapshot({prompt:'主管会话引擎切换'},'engine-switch',{retryCurrentMessage:false});
      const pending=this.pendingDirectorHandoff();
      let handoff;
      if(pending) {
        this.store.db.prepare('UPDATE director_handoffs SET reason=?,payload=?,status=?,updatedAt=? WHERE id=?')
          .run('engine-switch',JSON.stringify(redact(payload)),'prepared',this.store.now(),pending.id);
        handoff=this.store.directorHandoff(pending.id);
      } else handoff=this.store.createDirectorHandoff({parentSessionId:previousSession,reason:'engine-switch',payload,status:'prepared'});
      this.store.meta('directorHandoffPending',JSON.stringify({id:handoff.id}));
      this.companion?.syncHandoff(payload);
    }
    this.store.meta('directorEngine',engine);
    this.store.event(null,'director.engine-changed',{from:previous,to:engine,continuityPending:!!previousSession});
    this.emit();
    return {engine,changed:true,continuityPending:!!previousSession};
  }
  async cleanupVisualCache(directory) {
    if(typeof directory!=='string'||!directory)return;
    try {
      const root=resolve(this.visualCacheRoot),actual=await realpath(resolve(directory)),rel=relative(root,actual);
      if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))return;
      await rm(actual,{recursive:true,force:true});
    } catch { /* Cache cleanup is best-effort and never changes task delivery. */ }
  }
  observeEngineOutcome(task,status,error) {
    try { this.onEngineOutcome({engine:task.engine,status,error,taskCreatedAt:task.createdAt}); }
    catch { /* An optional health observer must never block task delivery. */ }
  }
  fixedWorkerPool() {
    return Object.keys(this.adapters).flatMap(engine=>Array.from({length:fixedWorkerSlotCount(engine)},(_,index)=>{
      const slot=index+1,context=fixedWorkerContext({store:this.store,engine,workspaceRoot:this.workspaceRoot,slot});
      const loads=this.store.db.prepare(`SELECT status,COUNT(*) n FROM tasks t WHERE role='worker' AND engine=? AND cwd=? AND status IN ('queued','running','waiting')
        AND EXISTS(SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker') GROUP BY status`).all(engine,context.cwd);
      const count=status=>loads.find(x=>x.status===status)?.n||0;
      const previous=context.sourceTaskId?this.store.task(context.sourceTaskId):null;
      return {engine,slot,name:`${dispatchEngineName(engine)} · 固定工作会话${slot>1?` ${slot}`:''}`,hasSession:!!context.sessionId,
        busy:loads.length>0,running:count('running')+count('waiting'),queued:count('queued'),
        lastTopic:previous?redact(previous.prompt).replace(/\s+/g,' ').slice(0,100):'',
        sessionUrl:engine==='dsh'&&context.sessionId&&previous?`/api/tasks/${encodeURIComponent(previous.id)}/session`:null};
    }));
  }
  fixedWorkerUsage(context) {
    if(!context?.sessionId) return 0;
    const rows=this.store.db.prepare(`SELECT e.data FROM events e JOIN tasks t ON t.id=e.taskId
      WHERE t.role='worker' AND t.engine='dsh' AND t.sessionId=? AND e.type='message'
      ORDER BY e.id DESC LIMIT 32`).all(context.sessionId);
    for(const row of rows) {
      try {
        const usage=JSON.parse(row.data||'{}').usage||{};
        const tokens=Number(usage.inputTokens||0)+Number(usage.cacheReadTokens||0)+Number(usage.cacheWriteTokens||0);
        if(Number.isFinite(tokens)&&tokens>0)return tokens;
      } catch {}
    }
    return 0;
  }
  fixedWorkerContextLimit() {
    const configured=Number(this.store.meta('workerContextLimit'));
    return Number.isFinite(configured)&&configured>0 ? configured : 120_000;
  }
  sessionTitlesForTasks(tasks) {return taskTitleLookup({store:this.store,workspaceRoot:this.workspaceRoot,tasks,engineName:dispatchEngineName});}
  sessionTitleForTask(task) {return this.sessionTitlesForTasks([task])(task);}
  setEmotion(mood,intensity,reason) {
    try { return this.companion?.setEmotion({mood,intensity,reason}); } catch { return null; }
  }
  workHandoff(task) {
    if(!task?.id)return null;
    const row=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.work-handoff' ORDER BY id DESC LIMIT 1").get(task.id);
    try{
      const value=row?JSON.parse(row.data):null;
      const previous=value?.previousWork?.taskId?this.store.task(value.previousWork.taskId):null;
      if(previous?.role==='worker')value.previousWork={...value.previousWork,goal:redact(String(previous.prompt||'')).slice(0,2000),status:previous.status,result:redact(String(previous.result||'')).slice(0,1600),error:redact(String(previous.error||'')).slice(0,500)};
      return value;
    }catch{return null;}
  }
  isFixedWorker(task) {return !!task?.id&&!!this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.fixed-worker'").get(task.id);}
  kickCoordinator() {
    if(this.stopping||this.store.db.prepare("SELECT 1 FROM tasks WHERE role='coordinator' AND status IN ('running','waiting') LIMIT 1").get())return;
    const task=this.store.db.prepare("SELECT * FROM tasks WHERE role='coordinator' AND status='queued' ORDER BY createdAt,rowid LIMIT 1").get();
    if(!task)return;
    const preset=this.adapters.dsh?.directorPreset||'minimal';
    const sessionId=this.store.meta('coordinatorSessionPreset')===preset?this.store.meta('coordinatorSessionId'):null;
    this.store.update(task.id,{sessionId:sessionId||null});
    this.run({...task,sessionId:sessionId||null});
  }
  async createManaged({id,kind,prompt,cwd,sessionId,engine='dsh'}) {
    if(!['maintenance','librarian'].includes(kind))throw Error('未知专职会话');
    if(!this.adapters[engine])throw Error('未知执行引擎');
    const rel=relative(this.workspaceRoot,cwd);
    if(!rel || rel.startsWith('..') || isAbsolute(rel))throw Error('专职会话目录越界');
    if(this.store.task(id))return this.store.task(id);
    if(this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").get().n>=this.maxConcurrent)throw Error('执行席位暂满');
    mkdirSync(join(cwd,'outputs',id),{recursive:true});
    const task=this.store.createTask({id,engine,prompt,cwd,role:kind,sessionId,model:engine==='codex'?this.codexDefaultModel:null});
    this.store.event(id,'task.created',{engine,role:kind});this.run(task);this.emit();return task;
  }
  say(text,options) {
    const parts=conversationalParts(userFacingTaskText(text)),now=Date.now();
    const fresh=[];
    for(const part of parts){const key=createHash('sha256').update(String(part)).digest('hex');const previous=this.recentReplies.get(key)||0;if(now-previous<5000)continue;this.recentReplies.set(key,now);fresh.push(part);}
    for(const part of fresh)this.store.say('assistant',part,options);
    for(const [key,at] of this.recentReplies)if(now-at>15000)this.recentReplies.delete(key);
    if(fresh.length)this.emit();
  }
  retractChat(id) { return retractChatMessage(this,id); }
  dispatchNotice(task) { return dispatchNoticeFor({engine:task?.engine,prompt:task?.prompt,id:task?.id,sessionName:this.sessionTitleForTask(task)}); }
  notification(text,key,{deferNotify=false}={}) {
    const notificationText=String(text||'');
    // Outbox keys provide durable idempotency and return the original rows
    // on replay, so report manifests remain complete across retries.
    const records=conversationalParts(userFacingTaskText(notificationText)).map((part,index)=>this.store.enqueue(part,key+':part:'+index));
    if(!deferNotify)void this.notify();
    return records;
  }
  report(task,key) {if(this.reports)this.reports.enqueue(task,key);else {this.say(task.result || '这项任务没有完成。');this.notification(task.result || '这项任务没有完成。',key);}}
  async create({engine='dsh',prompt,model,messageKey,role='worker',project,sessionId:requestedSessionId,workerSlot,contextTaskId,nativeSession,imagePaths=[],imageCleanupDirectory,handoff,originalUserText,requestContext,siblingDispatch=false}) {
    const directorRequest=typeof messageKey==='string'?/^(?:director|coordinator):(t-[\w-]+):[a-f0-9]{24}$/.exec(messageKey):null;
    const parent=directorRequest && this.store.task(directorRequest[1]);
    if(role==='coordinator') {engine='dsh';model=null;}
    if(['director','coordinator'].includes(parent?.role)&&role==='worker'&&!nativeSession) {
      const inheritedWork=this.workHandoff(parent),originalRequest=inheritedWork?.userRequest||parent.prompt;
      const previous=contextTaskId?this.store.task(contextTaskId):inheritedWork?.previousWork?.taskId?this.store.task(inheritedWork.previousWork.taskId):null;
      const continuationEngine=previous?.role==='worker'&&Object.hasOwn(this.adapters,previous.engine)?previous.engine:null;
      const selectedEngine=inheritedWork?.executionEngine||this.workerEngine();
      const resolvedEngine=resolveDispatchEngine({parentPrompt:originalRequest,proposedEngine:engine,taskPrompt:prompt,availableEngines:Object.keys(this.adapters),autoRoute:parent.role==='coordinator',selectedEngine,continuationEngine});
      if(engine!==resolvedEngine) {
        engine=resolvedEngine;
        nativeSession=null;
        requestedSessionId=null;
        model=null;
        workerSlot=undefined;
        messageKey='director:'+parent.id+':'+createHash('sha256').update(engine+'\0'+String(prompt||'').trim()+'\0'+(project||'')).digest('hex').slice(0,24);
      }
    }
    if(typeof engine!=='string' || !Object.hasOwn(this.adapters,engine) || typeof this.adapters[engine]?.start!=='function') throw Error('请选择已接入的 dsh、codex 或 workbuddy 引擎');
    if(engine==='codex' && !model&&!nativeSession)model=this.codexDefaultModel;
    if(engine==='workbuddy' && !model&&!nativeSession)model=this.workbuddyDefaultModel;
    if(typeof prompt!=='string' || !prompt.trim() || prompt.length>20000) throw Error('任务内容需要 1–20000 个字符');
    const id='t-'+(messageKey?createHash('sha256').update(messageKey).digest('hex').slice(0,12):randomUUID().slice(0,8));
    const existing=this.store.task(id);if(existing)return existing;
    role=['director','coordinator'].includes(role)?role:'worker';
    if(role==='worker'&&engine!=='dsh'&&Array.isArray(imagePaths)&&imagePaths.length)throw Error('所选工作引擎当前不能直接接收原图；需要先由 DSH 提取图像信息，再安排文字任务，原图未交给不支持的引擎。');
    if(parent&&['director','coordinator'].includes(parent.role)&&['coordinator','worker'].includes(role)) {
      if(!active.has(this.store.task(parent.id)?.status))throw Error('原消息已停止处理，不能继续派单。');
      const linked=linkedSupervisorTask(this,parent);
      if(linked&&!nativeSession&&!(siblingDispatch&&parent.role==='director'&&role==='coordinator'))return linked;
    }
    const phoneResourceTask=role==='worker'&&requiresPhoneResource(`${parent?.prompt||''}\n${prompt}`);
    const phoneResourceBusy=phoneResourceTask&&this.store.db.prepare("SELECT prompt FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting') ORDER BY createdAt").all().some(row=>requiresPhoneResource(row.prompt));
    const executionCount=this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").get().n;
    const capacityBusy=role==='worker'&&executionCount>=this.maxConcurrent;
    let inherited=handoff||this.workHandoff(parent);
    if(contextTaskId&&parent){
      const reference=buildWorkHandoff({store:this.store,userText:inherited?.userRequest||parent.prompt,goal:prompt,sourceTaskId:contextTaskId});
      if(!reference.previousWork)throw Error('指定的前次任务记录不存在或不可用于续接');
      inherited={...inherited,...reference};
    }
    const original=inherited?.userRequest||parent?.prompt||prompt;
    if(role==='coordinator'&&handoff&&/(?:会话|对话)/u.test(original)&&this.nativeTasks?.listSessions) {
      const named=(await this.nativeTasks.listSessions()).filter(item=>item.title?.length>=2&&original.includes(item.title));
      if(named.length===1)handoff={...handoff,requestedSession:{sessionId:named[0].sessionId,title:named[0].title,cwd:named[0].cwd}};
    }
    if(role==='worker'&&this.fixedWorkers&&parent&&!nativeSession) {
      // A model-suggested project/session is not a user override.
      if(project&&!original.includes(project))project=undefined;
      if(requestedSessionId&&!/(?:会话|对话|session)/iu.test(original))requestedSessionId=undefined;
      if(inherited?.requestedSession) {
        if(engine!=='dsh')throw Error('用户指定的会话属于 DSH，不能交给其他引擎。');
        nativeSession=inherited.requestedSession;requestedSessionId=nativeSession.sessionId;
      }
    }
    let resumeTaskId=null,fixedContinuation=null;
    if(role==='worker'&&parent&&!nativeSession&&!requestedSessionId&&!this.requestsFreshSession(prompt)&&inherited?.previousWork?.taskId) {
      const previous=this.store.task(inherited.previousWork.taskId);
      const previousProject=previous?this.projectNameForCwd(previous.cwd):null;
      if(previous?.role==='worker'&&previous.engine===engine&&previous.sessionId&&(!project||project===previousProject)) {
        const slot=fixedWorkerSlotForTask(previous,this.workspaceRoot);
        const seat=fixedWorkerContext({store:this.store,engine,workspaceRoot:this.workspaceRoot,slot});
        if(this.fixedWorkers&&this.isFixedWorker(previous)&&resolve(seat.cwd).toLowerCase()===resolve(previous.cwd).toLowerCase())fixedContinuation=previous;
        else if(['completed','failed','cancelled','interrupted'].includes(previous.status)){
          requestedSessionId=previous.sessionId;resumeTaskId=previous.id;
        }
      }
    }
    const fixed=role==='worker'&&this.fixedWorkers&&!nativeSession&&!requestedSessionId&&!(project&&(!parent||original.includes(project)));
    const fixedContext=fixed?(fixedContinuation?fixedWorkerContext({store:this.store,engine,workspaceRoot:this.workspaceRoot,slot:fixedWorkerSlotForTask(fixedContinuation,this.workspaceRoot)}):selectFixedWorkerContext({store:this.store,engine,workspaceRoot:this.workspaceRoot,preferredSlot:phoneResourceTask&&engine==='dsh'?4:workerSlot,prompt:original})):null;
    let fixedRollover=null;
    if(fixedContext&&fixedContinuation){fixedContext.sessionId=fixedContinuation.sessionId;fixedContext.sourceTaskId=fixedContinuation.id;}
    if(fixed&&engine==='dsh'&&fixedContext?.sessionId) {
      const usageTokens=this.fixedWorkerUsage(fixedContext),limit=this.fixedWorkerContextLimit();
      const staleProvider=!!fixedContinuation?.error && /NO_ADAPTER[\s\S]{0,120}provider\s+["']?command/i.test(fixedContinuation.error);
      if(usageTokens>=limit || staleProvider) {
        fixedRollover={slot:fixedContext.slot,previousSessionId:fixedContext.sessionId,usageTokens,limit,...(staleProvider?{reason:'provider-adapter-missing'}:{reason:'context-limit'})};
        fixedContext.sessionId=null;
        fixedContext.sourceTaskId=null;
      }
    }
    const fixedBusy=fixed&&fixedWorkerHasPending({store:this.store,engine,slot:fixedContext.slot,workspaceRoot:this.workspaceRoot});
    const context=fixed?{cwd:fixedContext.cwd,projectName:null,continuedFrom:fixedContext.sourceTaskId?this.store.task(fixedContext.sourceTaskId):null,coordinatorSessionFallback:null,continuationRoute:engine==='dsh'&&fixedContext.sourceTaskId?this.reusableDshRoute(fixedContext.sourceTaskId):null,continuationContext:null,continuedSessionId:fixedContext.sessionId}:resolveWorkerContext({workspaceRoot:this.workspaceRoot,directorProjectPath:this.directorProjectPath,
      engine,role,parent,project,requestedSessionId,nativeSession,resumeTaskId,prompt,store:this.store,
      projectNameForCwd:cwd=>this.projectNameForCwd(cwd),requestsFreshSession:value=>this.requestsFreshSession(value),
      latestCompletedProjectWorker:(...args)=>this.latestCompletedProjectWorker(...args),
      latestRelatedWorker:(...args)=>this.latestRelatedWorker(...args),sessionIsRelevant:(...args)=>this.sessionIsRelevant(...args),reusableDshRoute:id=>this.reusableDshRoute(id)});
    const {cwd,projectName,continuedFrom,coordinatorSessionFallback,continuationRoute,continuationContext,continuedSessionId}=context;
    let taskPrompt=prompt.trim();
    if(fixedRollover&&fixedContinuation) {
      const previous= fixedContinuation;
      const compact=[
        '固定工作席位的原生会话已达到上下文阈值，现保持原席位创建新会话接续。',
        previous.prompt?`上一项目标：${String(previous.prompt).slice(0,700)}`:'',
        previous.result?`上一项结果：${String(previous.result).slice(0,900)}`:'',
        previous.error?`上一项错误：${String(previous.error).slice(0,400)}`:'',
      ].filter(Boolean).join('\n');
      taskPrompt=`${compact}\n\n本轮要求：\n${taskPrompt}`.slice(0,20000);
    }
    if(continuationContext && !continuationRoute) {
      const context=[
        '续接背景：上次的 DSH 会话不属于当前可确认的服务实例，本轮将在同一项目新建会话。',
        continuationContext.prompt?`上次任务目标：${continuationContext.prompt}`:'',
        continuationContext.result?`上次已有结果：${continuationContext.result}`:'',
        '背景仅用于接续；本轮要求优先。',
      ].filter(Boolean).join('\n');
      const budget=Math.max(0,20000-taskPrompt.length-30);
      const bounded=context.slice(0,budget);
      if(bounded)taskPrompt=`${bounded}\n\n本轮要求：\n${taskPrompt}`;
    }
    mkdirSync(cwd,{recursive:true});
    const projectPath=role==='worker' ? null : this.directorProjectPath;
    const task=this.store.createTask({id,engine,prompt:taskPrompt,cwd,projectPath,model,role,sessionId:role==='director'?this.store.meta('directorSessionId'):role==='worker'?nativeSession?.sessionId || continuedSessionId || null:null});
    if(requestContext)this.store.event(id,'chat.request-context',{text:requestContext});
    if(role==='director'&&typeof originalUserText==='string')this.store.event(id,'chat.original',{text:originalUserText});
    if(fixed)this.store.event(id,'task.fixed-worker',{engine,slot:fixedContext.slot});
    if(nativeSession)this.store.event(id,'task.native-session',{engine,sessionId:nativeSession.sessionId,title:nativeSession.title||nativeSession.sessionId,...(engine==='workbuddy'&&nativeSession.workbuddyConfigDir?{workbuddyConfigDir:nativeSession.workbuddyConfigDir}:{})});
    if(fixedRollover)this.store.event(id,'task.fixed-worker-rollover',{...fixedRollover,reason:'context-limit'});
    if(role==='coordinator')this.store.event(id,'task.fixed-dispatcher',{});
    if(parent&&['coordinator','worker'].includes(role)) {
      const facts={...(inherited||buildWorkHandoff({store:this.store,userText:parent.prompt,goal:prompt})),executionEngine:nativeSession?engine:inherited?.executionEngine||this.workerEngine(),...(role==='worker'?{goal:taskPrompt}:{})};
      this.store.event(id,'task.work-handoff',facts);
      if(role==='worker'&&facts.fileDelivery)this.store.event(id,'file-delivery.requested',{source:'supervisor',messageKey});
    }
    if(['director','coordinator'].includes(parent?.role) && ['coordinator','worker'].includes(role))this.store.event(parent.id,'director.worker-created',{workerId:task.id,engine:task.engine,role});
    this.setEmotion('focused', 55, '已经接下新的任务，正在安排执行。');
    // A direct engine command has no supervisor turn to answer naturally. A
    // director dispatched worker does, so let that director reply carry the
    // conversational acknowledgement instead of adding a second fixed line.
    if(role==='worker' && !parent)this.store.event(task.id,'task.dispatch-hint',{text:this.dispatchNotice(task),sessionName:this.sessionTitleForTask(task)});
    this.store.event(id,'task.created',{engine,role,...(projectName?{project:projectName}:{}),...(continuedFrom?{continuedFromTaskId:continuedFrom.id}:{})});
    if(coordinatorSessionFallback)this.store.event(id,'coordinator.session-fallback',{reason:coordinatorSessionFallback.reason,action:continuedFrom?'continued-related-session':'used-project-or-new-session'});
    if(engine==='dsh' && Array.isArray(imagePaths) && imagePaths.length) this.store.event(id,'task.images',{paths:imagePaths.slice(0,4),...(imageCleanupDirectory?{cleanupDirectory:imageCleanupDirectory}:{})});
    if(continuationRoute)this.store.event(id,'dsh.route',continuationRoute);
    if(continuationContext && !continuationRoute)this.store.event(id,'task.session-continuity-reset',{sourceTaskId:continuedFrom.id,reason:'origin DSH endpoint is unknown or unavailable'});
    if(role==='director')this.kickDirector();
    else if(role==='coordinator')this.kickCoordinator();
    else if(phoneResourceBusy||capacityBusy||fixedBusy) {
      this.store.event(id,'task.execution-queued',{reason:fixedBusy?'fixed-worker-busy':phoneResourceBusy?'exclusive-phone-resource':'execution-capacity',activeExecutions:executionCount,limit:this.maxConcurrent});
      if(phoneResourceBusy)this.store.event(id,'phone.resource-queued',{resource:'android-device'});
      else this.store.event(id,'task.capacity-queued',{activeExecutions:executionCount,limit:this.maxConcurrent});
    }
    else this.run(task,task.prompt,{allowMissingSessionFallback:!fixed&&!!continuationRoute,continuationContext:continuationRoute?continuationContext:null});
    this.emit();return task;
  }
  pumpPhoneQueue() { return this.pumpWorkerQueue(); }
  pumpWorkerQueue() {
    if(this.stopping)return 0;
    let activeCount=this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").get().n;
    if(activeCount>=this.maxConcurrent)return 0;
    const phoneRows=this.store.db.prepare("SELECT prompt FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").all();
    let phoneBusy=phoneRows.some(row=>requiresPhoneResource(row.prompt));
    const queue=this.store.db.prepare("SELECT * FROM tasks AS queued WHERE queued.role='worker' AND queued.status='queued' AND NOT EXISTS (SELECT 1 FROM approvals WHERE approvals.taskId=queued.id AND approvals.status='recovery_required') AND NOT EXISTS (SELECT 1 FROM events WHERE events.taskId=queued.id AND events.type='task.native-linked') ORDER BY queued.createdAt,queued.rowid").all();
    let started=0;
    for(let task of queue) {
      if(activeCount>=this.maxConcurrent)break;
      const phoneTask=requiresPhoneResource([task.prompt,...this.amendments.pending(task.id).map(row=>row.text)].join('\n'));
      if(phoneTask&&phoneBusy)continue;
      if(this.isFixedWorker(task)) {
        const slot=fixedWorkerSlotForTask(task,this.workspaceRoot);
        if(fixedWorkerBusy({store:this.store,engine:task.engine,slot,workspaceRoot:this.workspaceRoot,excludingTaskId:task.id})){
          // Only never-started independent pool work can move. Follow-ups and
          // recovered work retain their original session and context.
          if(this.workHandoff(task)?.previousWork||this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.started' LIMIT 1").get(task.id))continue;
          const idle=selectFixedWorkerContext({store:this.store,engine:task.engine,workspaceRoot:this.workspaceRoot});
          if(fixedWorkerHasPending({store:this.store,engine:task.engine,slot:idle.slot,workspaceRoot:this.workspaceRoot}))continue;
          mkdirSync(idle.cwd,{recursive:true});
          this.store.transaction(()=>{
            this.store.db.prepare("UPDATE tasks SET cwd=?,sessionId=?,updatedAt=? WHERE id=? AND status='queued'").run(idle.cwd,idle.sessionId,this.store.now(),task.id);
            this.store.event(task.id,'task.fixed-worker-reassigned',{fromSlot:slot,toSlot:idle.slot,reason:'idle-seat-available-before-first-start'});
          });
          task=this.store.task(task.id);
        }
      }
      this.store.event(task.id,'task.execution-dequeued',{reason:'execution-capacity-available',activeExecutions:activeCount,limit:this.maxConcurrent});
      this.run(task,task.prompt);activeCount++;started++;
      if(phoneTask)phoneBusy=true;
    }
    return started;
  }
  /**
   * Start a fresh supervisor session while preserving the current session and
   * a compact durable snapshot. Used after a large memory restoration or when
   * the operator explicitly asks for a clean supervisor context.
   */
  startFreshDirector(reason='manual') {
    if(this.store.db.prepare("SELECT id FROM tasks WHERE role='director' AND status IN ('queued','running','waiting') LIMIT 1").get()) {
      throw new Error('主管会话当前仍在处理消息，请等它结束后再换代');
    }
    const previousSession=this.store.meta('directorSessionId');
    const id='t-'+randomUUID().slice(0,8);
    const cwd=join(this.workspaceRoot,'_director');
    mkdirSync(cwd,{recursive:true});
    const engine=this.directorEngine();
    const task=this.store.createTask({id,engine,prompt:'恢复主管会话：读取已合并的长期记忆，继续自然对话和任务分派。',cwd:engine==='codex'&&this.directorProjectPath?this.directorProjectPath:cwd,projectPath:this.directorProjectPath,role:'director',sessionId:null,model:engine==='codex'?this.codexDefaultModel:null});
    const payload=this.directorSnapshot(task,reason);
    const handoff=this.store.createDirectorHandoff({parentSessionId:previousSession || 'unknown',sourceTaskId:id,reason,payload,status:'starting'});
    this.store.linkDirectorHandoff(handoff.id,{targetTaskId:id,status:'starting'});
    this.store.meta('directorHandoffPending',JSON.stringify({id:handoff.id}));
    this.store.event(id,'director.handoff-prepared',{handoffId:handoff.id,reason});
    this.kickDirector();
    this.emit();
    return this.store.task(id);
  }
  kickDirector() {
    this.kickCoordinator();
    this.kickReportDirector();
    if(this.diaryBusy)return;
    if(this.store.db.prepare("SELECT id FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status IN ('running','waiting') LIMIT 1").get())return;
    // Timestamps have millisecond precision. A burst of QQ messages can share
    // createdAt, so use SQLite insertion order as the stable FIFO tie-breaker.
    const next=this.store.db.prepare("SELECT * FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status='queued' ORDER BY createdAt,rowid LIMIT 1").get();
    if(next){
      if(this.directorProjectPath && next.projectPath!==this.directorProjectPath) { this.store.update(next.id,{projectPath:this.directorProjectPath}); next.projectPath=this.directorProjectPath; }
      const previousSession=this.store.meta('directorSessionId');
      const previousSessionEngine=this.store.meta('directorSessionEngine') || (previousSession?'dsh':null);
      let pending=this.pendingDirectorHandoff();
      if(!pending && previousSession && previousSessionEngine!==next.engine) {
        const payload=this.directorSnapshot(this.store.task(next.id),'engine-switch',{retryCurrentMessage:false});
        pending=this.store.createDirectorHandoff({parentSessionId:previousSession,sourceTaskId:next.id,reason:'engine-switch',payload,status:'starting'});
        this.store.linkDirectorHandoff(pending.id,{targetTaskId:next.id,status:'starting'});
        this.store.meta('directorHandoffPending',JSON.stringify({id:pending.id}));
      }
      const previousRoute=next.engine==='dsh'&&previousSessionEngine==='dsh'&&previousSession
        ?this.store.db.prepare("SELECT data FROM events WHERE taskId IN (SELECT id FROM tasks WHERE role='director' AND sessionId=?) AND type='dsh.route' ORDER BY id DESC LIMIT 1").get(previousSession)
        :null;
      let previousEndpoint='';try { previousEndpoint=JSON.parse(previousRoute?.data || '{}').endpoint || ''; } catch {}
      const directorEndpoint=next.engine==='dsh'?this.adapters.dsh.directorEndpoint:null;
      if(!pending && previousSession && this.directorProjectPath && previousEndpoint && directorEndpoint && previousEndpoint!==directorEndpoint) {
        const payload=this.directorSnapshot(this.store.task(next.id),'director-route-migration');
        pending=this.store.createDirectorHandoff({parentSessionId:previousSession,sourceTaskId:next.id,reason:'director-route-migration',payload,status:'starting'});
        this.store.linkDirectorHandoff(pending.id,{targetTaskId:next.id,status:'starting'});
        this.store.meta('directorHandoffPending',JSON.stringify({id:pending.id}));
        this.store.event(next.id,'dsh.route',{endpoint:directorEndpoint,priority:this.adapters.dsh.directorRoutePriority || 'isolated-director-3180'});
      }
      if(!pending && previousSession && previousSessionEngine===next.engine && this.directorSessionNeedsRollover()) {
        const payload=this.directorSnapshot(this.store.task(next.id),'usage-threshold');
        pending=this.store.createDirectorHandoff({parentSessionId:previousSession,sourceTaskId:next.id,reason:'usage-threshold',payload,status:'starting'});
        this.store.linkDirectorHandoff(pending.id,{targetTaskId:next.id,status:'starting'});
        this.store.meta('directorHandoffPending',JSON.stringify({id:pending.id}));
      }
      if(!pending && next.engine==='dsh' && previousSession && previousSessionEngine==='dsh' && this.store.meta('directorSessionPreset')!==(this.adapters.dsh.directorPreset || 'mornye-director')) {
        const payload=this.directorSnapshot(this.store.task(next.id),'preset-upgrade');
        pending=this.store.createDirectorHandoff({parentSessionId:previousSession,sourceTaskId:next.id,reason:'preset-upgrade',payload,status:'starting'});
        this.store.linkDirectorHandoff(pending.id,{targetTaskId:next.id,status:'starting'});
      }
      if(!pending && next.engine==='dsh' && previousSession && previousSessionEngine==='dsh') {
        let previousSelection=null;
        try { previousSelection=JSON.parse(this.store.meta('directorSessionSelection')||'null'); } catch { /* stale metadata */ }
        const currentSelection=this.adapters.dsh.supervisorSelection || null;
        const selectionChanged=!previousSelection || !currentSelection
          ? Boolean(previousSelection||currentSelection)
          : previousSelection.provider!==currentSelection.provider || previousSelection.model!==currentSelection.model;
        if(selectionChanged) {
          const payload=this.directorSnapshot(this.store.task(next.id),'model-switch');
          pending=this.store.createDirectorHandoff({parentSessionId:previousSession,sourceTaskId:next.id,reason:'model-switch',payload,status:'starting'});
          this.store.linkDirectorHandoff(pending.id,{targetTaskId:next.id,status:'starting'});
          this.store.event(next.id,'director.model-rollover',{from:previousSelection,to:currentSelection});
        }
      }
      const sessionId=(pending || previousSessionEngine!==next.engine)?null:previousSession;
      this.store.update(next.id,{sessionId,...(next.engine==='codex'&&!next.model?{model:this.codexDefaultModel}:{})});
      if(pending) {
        this.store.linkDirectorHandoff(pending.id,{targetTaskId:next.id,status:'starting',attempts:pending.attempts});
        this.store.meta('directorHandoffPending','');
        const latest=this.directorSnapshot(this.store.task(next.id),pending.reason);
        const payload={...pending.payload,currentUserGoal:next.prompt,recentTurns:latest.recentTurns,tasks:latest.tasks,activeTaskIds:latest.activeTaskIds};
        this.run(this.store.task(next.id),this.handoffPrompt(payload,next.prompt));
      } else this.run(this.store.task(next.id));
    }
  }
  // Recent real director turns reach roughly seven minutes at p95. A three-
  // minute cutoff killed healthy long replies; only end a turn after ten
  // minutes without any genuine model/tool progress.
  async checkDirectorLiveness({now=Date.now(),warningMs=60000,timeoutMs=10*60*1000}={}) {
    if(this.stopping || this.checkingDirector)return;
    const task=this.store.db.prepare("SELECT * FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status='running' ORDER BY createdAt LIMIT 1").get();
    if(!task||this.errorRetries.pending(task.id))return;
    const started=this.store.meta('director:response-last-progress:'+task.id) || this.store.meta('director:response-start:'+task.id) || this.store.db.prepare("SELECT createdAt FROM events WHERE taskId=? AND type='task.started' ORDER BY id LIMIT 1").get(task.id)?.createdAt || task.createdAt;
    const elapsed=now-Date.parse(started);if(!Number.isFinite(elapsed))return;
    if(elapsed>=timeoutMs) {
      this.checkingDirector=true;
      try {
        const cancelling=Promise.resolve().then(()=>this.adapters[task.engine].cancel(task)).catch(error=>this.store.event(task.id,'director.cancel-error',{error:redact(error.message)}));
        let timer;await Promise.race([cancelling,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);
        const current=this.store.task(task.id);
        if(current?.status!=='running' || current.runVersion!==task.runVersion)return;
        // Keep the failed turn and history, but let queued messages continue in
        // the same project without replaying any tool calls from this turn.
        const payload=this.directorSnapshot(task,'reply-timeout',{retryCurrentMessage:false});
        payload.recovery={sourceTaskId:task.id,originalPrompt:String(task.prompt||'').slice(0,1800),partialResponse:String(task.result||'').slice(0,4000),sessionId:task.sessionId||null,runVersion:task.runVersion,safeToReplay:false};
        this.companion?.syncHandoff(payload);
        const handoff=this.store.createDirectorHandoff({parentSessionId:task.sessionId || 'unknown',sourceTaskId:task.id,reason:'reply-timeout',payload,status:'prepared'});
        this.store.meta('directorHandoffPending',JSON.stringify({id:handoff.id}));
        this.store.event(task.id,'director.reply-timeout',{elapsedMs:elapsed});
        const error=new Error('主管回复超过等待上限，原请求没有重新执行。');error.code='DIRECTOR_REPLY_TIMEOUT';
        await this.fail(task.id,error);
      }finally{this.checkingDirector=false;}
    }else if(elapsed>=warningMs && !this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.wait-notified' AND COALESCE(json_extract(data,'$.runVersion'),1)=? LIMIT 1").get(task.id,task.runVersion)) {
      this.store.event(task.id,'director.wait-notified',{elapsedMs:elapsed,runVersion:task.runVersion});
      const retry=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='message' AND data LIKE '%model-retry%' LIMIT 1").get(task.id);
      const coordinator=linkedSupervisorTask(this,task);
      if(this.reports?.announce)void this.reports.announce({task:{...task,prompt:'仅告知主管回复仍在生成',result:'',progressNotice:{waitingSeconds:Math.floor(elapsed/1000),connectionRetry:!!retry,acceptedSessionName:coordinator?this.sessionTitleForTask(coordinator):null}},kind:'director-delay',dedupe:`director-wait:${task.id}:${task.runVersion}`,
        situation:'本轮只告知已知等待状态，用户问题由原对话主管回答。不能预答、补答或编造角色日常，不要求重发，不重新派单。'})
        .catch(error=>this.store.event(task.id,'director.delay-report-error',{message:redact(error.message)}));
      void this.notify();
    }
  }
  kickReportDirector() {
    if(this.stopping || this.store.db.prepare("SELECT id FROM tasks WHERE role='director' AND prompt LIKE '[内部工作回报]%' AND status IN ('running','waiting') LIMIT 1").get())return;
    const next=this.store.db.prepare("SELECT * FROM tasks WHERE role='director' AND prompt LIKE '[内部工作回报]%' AND status='queued' ORDER BY createdAt,rowid LIMIT 1").get();
    if(!next)return;
    const count=Number(this.store.meta('reportDirector:count') || 0),tokens=Number(this.store.meta('reportDirector:tokens') || 0);
    const rotate=count>=20 || tokens>=100000;
    const sessionId=rotate?null:this.store.meta('reportDirectorSessionId');
    this.store.meta('reportDirector:count',String(rotate?1:count+1));
    if(rotate)this.store.meta('reportDirector:tokens','0');
    this.store.update(next.id,{sessionId,projectPath:this.directorProjectPath});
    this.run(this.store.task(next.id));
  }
  async superviseWorkers(options) { return this.workerSupervision.superviseWorkers(options); }
  pendingDirectorHandoff(...args) {return this.continuity.pendingDirectorHandoff(...args);}
  directorSnapshot(...args) {return this.continuity.directorSnapshot(...args);}
  directorSessionNeedsRollover(...args) {return this.continuity.directorSessionNeedsRollover(...args);}
  handoffPrompt(...args) {return this.continuity.handoffPrompt(...args);}
  retryDirectorAfterContextLimit(...args) {return this.continuity.retryDirectorAfterContextLimit(...args);}
  retryDirectorAfterSafePreflight(...args) {return this.continuity.retryDirectorAfterSafePreflight(...args);}
  isContextLimit(...args) {return this.continuity.isContextLimit(...args);}
  currentTaskContext({routing=false,prompt='',compact=false}={}) {
    if (compact) {
      const running=this.store.db.prepare("SELECT * FROM tasks WHERE role='worker' AND status IN ('queued','running','waiting') ORDER BY createdAt LIMIT 4").all();
      const statusQuery=/进度|进展|结果|状态|做完|成功|失败|(?:任务|邮件).{0,8}(?:怎样|如何|怎么样|哪里|了吗|了没|完成|好了吗)/u.test(prompt);
      const recent=statusQuery?this.store.tasks().filter(task=>task.role==='worker').slice(0,3):[];
      const selected=[...new Map([...running,...recent].map(task=>[task.id,task])).values()];
      return selected.length ? JSON.stringify({work:selected.map(task=>{
        const report=statusQuery?this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type IN ('narrator.completed','narrator.fallback') ORDER BY id DESC LIMIT 1").get(task.id):null;
        let explanation='';try{explanation=JSON.parse(report?.data||'{}').text||'';}catch{}
        return {taskId:task.id,name:this.sessionTitleForTask(task),engine:task.engine,status:task.status,...(statusQuery?{request:task.prompt.slice(0,180),result:String(explanation||task.result||'').slice(0,400),error:task.error?.slice(0,240)||null}:{})};
      })}) : '';
    }
    if(routing&&this.fixedWorkers) {
      const fixed=this.fixedWorkerPool().map(({engine,slot,name,hasSession,busy,queued,lastTopic})=>({engine,slot,name,hasSession,busy,queued,lastTopic}));
      return '先判断是否续接已有任务：有交接previousWork或通过hub_work_recall查明前次任务时，用contextTaskId保留原上下文；原席位忙则等待，不改投。独立任务才从三个DSH席位选空闲或主题相符的workerSlot，全忙排队。工作记忆按需检索，不复制整库。只有用户指定其他会话或项目时才填sessionId/project。\n'+JSON.stringify({engines:Object.keys(this.adapters),fixed});
    }
    if(routing) {
      prompt=String(prompt||'');
      const original=prompt.match(/用户原话\s*[：:]([\s\S]*)$/u);
      if(original)prompt=original[1].trim();
      const sessionRows=this.store.tasks().filter(task=>task.role==='worker'&&task.sessionId);
      const ranked=this.sessionOverlap(prompt,sessionRows);
      const selected=[...ranked.slice(0,8),...sessionRows.filter(task=>!ranked.some(item=>item.id===task.id)).slice(0,4)];
      const sessions=selected.map(task=>{
        const occupied=task.sessionId?!!this.store.db.prepare("SELECT 1 FROM tasks WHERE sessionId=? AND status IN ('queued','running','waiting') LIMIT 1").get(task.sessionId):true;
        const overlap=[...sessionTerms(prompt)].filter(term=>sessionTerms(task.prompt).has(term)).length;
        return {title:this.sessionTitleForTask(task),engine:task.engine,status:task.status,project:this.projectNameForCwd(task.cwd),sessionId:task.sessionId||null,
          canContinue:!!task.sessionId&&!occupied&&['completed','failed','cancelled','interrupted'].includes(task.status),topicMatch:overlap,request:String(task.prompt||'').slice(0,110)};
      });
      const projects=this.store.db.prepare("SELECT data FROM events WHERE type='task.created' ORDER BY id DESC").all().map(row=>{try{return JSON.parse(row.data||'{}').project;}catch{return null;}}).filter((name,index,all)=>name && all.indexOf(name)===index)
        .map(name=>({name,topicMatch:[...sessionTerms(prompt)].filter(term=>sessionTerms(name).has(term)).length})).sort((a,b)=>b.topicMatch-a.topicMatch).slice(0,8);
      return '可用引擎、按当前派单主题相关度排序的会话与项目。topicMatch 越大代表历史任务词汇越相关；只能在主题明确相符且 canContinue=true 时续接。不要因为会话最近、空闲或都在同一项目就复用不相关会话；没有高相关候选时省略 sessionId，并选择主题合适的项目或新项目。\n'+JSON.stringify({engines:Object.keys(this.adapters),sessions,projects});
    }
    const hasSpecialists=!!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='specialist_jobs'").get();
    const tasks=this.store.tasks().filter(task=>!['director','coordinator'].includes(task.role)).slice(0,10).map(task=>{
      const report=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type IN ('narrator.completed','narrator.fallback') ORDER BY id DESC LIMIT 1").get(task.id);
      let explanation;try{explanation=JSON.parse(report?.data || '{}').text;}catch{}
      const job=hasSpecialists?this.store.db.prepare('SELECT status,result,error,nextRetryAt FROM specialist_jobs WHERE taskId=? ORDER BY createdAt DESC LIMIT 1').get(task.id):null;
      return {id:task.id,engine:task.engine,role:task.role,status:task.status,sessionId:task.sessionId||null,sessionTitle:this.sessionTitleForTask(task),project:this.projectNameForCwd(task.cwd),request:String(task.prompt).slice(0,200),collection:this.store.db.prepare('SELECT status FROM collection_jobs WHERE taskId=?').get(task.id)?.status || null,
        explanation:String(explanation || job?.result || '').slice(0,500),error:task.status==='failed'?String(task.error || '').slice(0,300):null,specialist:job?{status:job.status,result:String(job.result||'').slice(0,240),error:String(job.error||'').slice(0,200),nextRetryAt:job.nextRetryAt}:null};
    });
    const projects=this.store.db.prepare("SELECT data FROM events WHERE type='task.created' ORDER BY id DESC").all().map(row=>{try{return JSON.parse(row.data||'{}').project;}catch{return null;}}).filter((name,index,all)=>name && all.indexOf(name)===index).slice(0,12);
    return '本轮从中枢数据库读取的任务状态与可复用项目（只读参考）：\n'+JSON.stringify({tasks,projects});
  }
  directorAllowsEngine(task,engine) {
    return allowsEngine(task?.prompt,engine);
  }
  directorRequestedEngine(task) {
    const context=this.workHandoff(task);
    const selected=context?.executionEngine||this.workerEngine();
    return requestedEngine(context?.userRequest||task?.prompt)||(selected!=='auto'?selected:null);
  }
  requestsFreshSession(prompt) {
    return /(?:新建|新开|另开|独立|单独|全新).{0,8}(?:会话|对话|上下文)|(?:不要|不再|别).{0,12}(?:沿用|复用|继续|接续|继承).{0,8}(?:会话|对话|上下文|历史)?|从头开始|(?:fresh|new|independent|separate)\s+(?:session|conversation)|start\s+(?:a\s+)?fresh/i.test(String(prompt||''));
  }
  latestCompletedProjectWorker(engine,cwd,projectName,prompt='') {
    const candidates=this.store.db.prepare("SELECT * FROM tasks AS previous WHERE previous.role='worker' AND previous.engine=? AND previous.cwd=? AND previous.status='completed' AND previous.sessionId IS NOT NULL AND TRIM(previous.sessionId)!='' AND NOT EXISTS (SELECT 1 FROM tasks AS activeTask WHERE activeTask.sessionId=previous.sessionId AND activeTask.status IN ('queued','running','waiting')) ORDER BY previous.createdAt DESC").all(engine,cwd);
    const related=this.sessionOverlap(prompt,candidates);
    for(const candidate of related) {
      const created=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.created' ORDER BY id LIMIT 1").get(candidate.id);
      try { if(JSON.parse(created?.data || '{}').project===projectName)return candidate; } catch {}
    }
    return null;
  }
  reusableDshRoute(taskId) {
    const row=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='dsh.route' ORDER BY id DESC LIMIT 1").get(taskId);
    let route;try{route=JSON.parse(row?.data||'{}');}catch{return null;}
    if(typeof route?.endpoint!=='string' || !route.endpoint.trim())return null;
    const endpoints=this.adapters.dsh?.endpoints;
    if(endpoints) {
      const target=route.endpoint.replace(/\/$/,'');
      if(!Object.values(endpoints).some(endpoint=>typeof endpoint==='string' && endpoint.replace(/\/$/,'')===target))return null;
    }
    return route;
  }
  projectNameForCwd(cwd) {
    const rel=relative(this.workspaceRoot,cwd).split(/[\\/]+/u);
    return rel[0]==='projects' && rel[1] ? rel[1] : null;
  }
  latestRelatedWorker(engine,prompt) {
    const candidates=this.store.db.prepare("SELECT * FROM tasks AS previous WHERE previous.role='worker' AND previous.engine=? AND previous.status='completed' AND previous.sessionId IS NOT NULL AND TRIM(previous.sessionId)!='' AND NOT EXISTS (SELECT 1 FROM tasks AS activeTask WHERE activeTask.sessionId=previous.sessionId AND activeTask.status IN ('queued','running','waiting')) ORDER BY previous.createdAt DESC LIMIT 80").all(engine);
    return this.sessionOverlap(prompt,candidates)[0] || null;
  }
  promptsRelated(first,second) {
    const continuation=/(?:继续|接着|延续|刚才|上次|原来的|这个任务|同一个|前面|再看|再查|补充|沿用|复用|查看原有|原会话)/u.test(String(first||''));
    const incoming=sessionTerms(first),overlap=[...incoming].filter(term=>sessionTerms(second).has(term)).length;
    return overlap>=(continuation?2:6);
  }
  sessionLineageRelevant(task) {
    let current=task;
    for(let depth=0;depth<20;depth++) {
      const event=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.created' ORDER BY id LIMIT 1").get(current.id);
      let parentId;try{parentId=JSON.parse(event?.data||'{}').continuedFromTaskId;}catch{return false;}
      if(!parentId)return true;
      const parent=this.store.task(parentId);
      if(!parent)return false;
      if(!this.promptsRelated(current.prompt,parent.prompt))return false;
      current=parent;
    }
    return false;
  }
  sessionIsRelevant(prompt,task) {
    return Boolean(task && this.promptsRelated(prompt,task.prompt) && this.sessionLineageRelevant(task));
  }
  sessionOverlap(prompt,candidates) {
    const continuation=/(?:继续|接着|延续|刚才|上次|原来的|这个任务|同一个|前面|再看|再查|补充|沿用|复用|查看原有|原会话)/u.test(String(prompt||''));
    const incoming=sessionTerms(prompt);
    if(!incoming.size)return [];
    const ranked=[];
    for(const candidate of candidates) {
      if(!this.promptsRelated(prompt,candidate.prompt))continue;
      if(!this.sessionLineageRelevant(candidate))continue;
      const overlap=[...incoming].filter(term=>sessionTerms(candidate.prompt).has(term)).length;
      const threshold=continuation?2:6;
      if(overlap<threshold)continue;
      ranked.push({candidate,overlap});
    }
    return ranked.sort((a,b)=>b.overlap-a.overlap).map(item=>item.candidate);
  }
  run(task,prompt=task.prompt,{allowMissingSessionFallback=false,continuationContext=null}={}) {
    if(this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested' LIMIT 1").get(task.id)){
      if(this.store.task(task.id)?.status!=='cancelled')this.store.update(task.id,{status:'waiting',error:'停止状态尚未确认，已禁止自动接续'});
      this.store.event(task.id,'task.resume-blocked',{reason:'user-stop-requested'});return;
    }
    const additions=task.role==='worker'&&!task.reconnectOnly?this.amendments.claim(task.id,{allowQueued:true}):[];
    if(additions.length) {
      this.store.event(task.id,'task.amendment-base',{prompt:task.prompt,runVersion:task.runVersion||0});
      prompt=this.amendmentPrompt(task,additions);
      task={...task,prompt};this.store.update(task.id,{prompt});
    }
    if(this.isFixedWorker(task)&&!task.reconnectOnly&&!task.sessionId && !this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.fixed-worker-rollover' LIMIT 1").get(task.id)) {
      const fixed=fixedWorkerContext({store:this.store,engine:task.engine,workspaceRoot:this.workspaceRoot,slot:fixedWorkerSlotForTask(task,this.workspaceRoot)});
      task={...task,sessionId:fixed.sessionId};this.store.update(task.id,{sessionId:fixed.sessionId});
    }
    if(task.engine==='dsh' && typeof this.adapters.dsh?.endpointFor==='function') {
      const routeRow=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='dsh.route' ORDER BY id DESC LIMIT 1").get(task.id);
      try { const route=routeRow?.data ? JSON.parse(routeRow.data) : null; if(route?.endpoint) task.dshEndpoint=route.endpoint;if(route?.priority)task.dshRoutePriority=route.priority; } catch {}
      const endpoint=task.dshEndpoint || this.adapters.dsh.endpointFor(task);
      if(endpoint) {
        task.dshEndpoint=endpoint;
        this.store.event(task.id,'dsh.route',{endpoint,priority:task.dshRoutePriority || (['director','coordinator'].includes(task.role)?(this.adapters.dsh.directorRoutePriority || 'qq-simulation-primary-3080'):'primary-3080'),phase:'selected-before-start'});
      }
    }
    const runVersion=(this.store.task(task.id).runVersion || 0)+1;
    const carried=task.role==='worker'?this.amendments.list(task.id,{status:'claimed'}):[];
    if(carried.length)this.store.event(task.id,'task.amendments-bound',{runVersion,ids:carried.map(row=>row.id)});
    this.store.update(task.id,{status:'running',error:null,runVersion});
    this.store.event(task.id,'task.started',{sessionId:task.sessionId});
    if(task.role==='director')this.store.meta('director:response-start:'+task.id,this.store.now());
    this.setEmotion('focused', 60, '任务正在执行，我在跟进它的进度。');
    this.emit();
    const director=task.role==='director';
    const projectSupervisor=director||task.role==='coordinator';
    const directorReport=director && String(prompt).startsWith('[内部工作回报]');
    const documentPaths=projectSupervisor?this.companion?.documentPaths():null;
    const documentRole=directorReport?'report':task.role;
    const documentKey=sessionId=>`session-documents:${task.engine}:${documentRole}:${sessionId}`;
    let loaded={};
    try { if(task.sessionId)loaded=JSON.parse(this.store.meta(documentKey(task.sessionId))||'{}'); } catch {}
    const documents=loadSessionDocuments({paths:documentPaths,role:documentRole,loaded});
    if(documentPaths&&!task.reconnectOnly)this.sessionDocumentLoads.set(task.id,{role:documentRole,fingerprints:{...loaded,...documents.fingerprints}});
    let originalUserText;
    if(director&&!directorReport)try{const row=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='chat.original' ORDER BY id LIMIT 1").get(task.id);originalUserText=JSON.parse(row?.data||'{}').text;}catch{}
    const nativeConversation=task.engine==='dsh'&&typeof originalUserText==='string'&&!!documentPaths;
    // This path sends the exact user turn. Do not build a discarded synthetic
    // prompt or scan work/task/episode stores before ordinary native chat.
    const selectedNative=JSON.parse(this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.native-session' ORDER BY id DESC LIMIT 1").get(task.id)?.data||'null');
    const built=selectedNative?{text:prompt}:nativeConversation?{text:originalUserText}:buildTaskPrompt({task,prompt,engines:Object.keys(this.adapters),
      sessionDocuments:documentPaths?documents.text:undefined,
      documentPaths,
      persona:projectSupervisor?this.companion?.state?.().persona:undefined,
      companionGuide:director && !directorReport?this.companion?.guide?.(task.prompt,{maxChars:450,factsOnly:true}):'',
      behaviorPolicy:director&&!directorReport?this.companion?.behaviorSettings?.():null,
      taskContext:()=>this.currentTaskContext({routing:task.role==='coordinator',compact:director,prompt:task.prompt}),
      // The persistent first-level supervisor already has its own chat history
      // and project documents. Injecting task retrieval here turns a user turn
      // into a long, synthetic message; task history belongs on the dispatch
      // boundary only.
      executionContext:task.role==='director'?null:this.workHandoff(task),
      alreadyDispatched:!!linkedSupervisorTask(this,task),
    });
    const instruction=built.text;
    const nativeVerbatim=task.engine==='dsh'&&typeof originalUserText==='string';
    if(!task.reconnectOnly)this.store.event(task.id,'prompt.prepared',{chars:typeof originalUserText==='string'?originalUserText.length:instruction.length,contextChars:0,verbatim:typeof originalUserText==='string',documentChars:nativeVerbatim?0:documents.text.length,documents:nativeVerbatim?[]:documents.files,availableDocumentChars:documents.text.length,documentMode:nativeVerbatim?'native-side-channel':'session-documents',continuation:!!task.sessionId});
    const isCurrentRun=()=>{
      if(this.stopping)return false;
      const current=this.store.task(task.id);
      return current?.runVersion===runVersion && active.has(current.status);
    };
    let imagePaths=[],imageCleanupDirectory=null;
    if(task.engine==='dsh'&&!(task.sessionId&&carried.length))try{const row=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.images' ORDER BY id DESC LIMIT 1").get(task.id);const saved=JSON.parse(row?.data||'{}');imagePaths=saved.paths||[];imageCleanupDirectory=saved.cleanupDirectory||null;}catch{}
    const cleanupImages=()=>this.cleanupVisualCache(imageCleanupDirectory);
    const adapterTask={...task,prompt:instruction,displayTitle:this.sessionTitleForTask(task),imagePaths,
      ...(selectedNative?{preserveNativeSession:true}:{}),
      ...(selectedNative?.workbuddyConfigDir?{workbuddyConfigDir:selectedNative.workbuddyConfigDir}:{}),
      ...(typeof originalUserText==='string'?{userText:originalUserText}:{}),
      ...(director&&!directorReport&&task.engine==='dsh'&&documentPaths?{prepareNativeSessionContext:({sessionId})=>{
        const root=join(dirname(this.workspaceRoot),'native-context','dsh');
        const continuity=loaded.director?'':recentNativeContinuity(this.store,originalUserText);
        const linkedHandoff=loaded.director?null:this.store.directorHandoffs().find(item=>item.targetTaskId===task.id);
        return writeNativeContext({root,sessionId,projectPath:task.projectPath||task.cwd,documents:{...documentPaths,layers:join(task.projectPath||task.cwd,'记忆体系与读取.md')},
          handoff:linkedHandoff?compactNativeHandoff(linkedHandoff.payload):'',
          requestContext:directorRequestReferences(JSON.parse(this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='chat.request-context' ORDER BY id DESC LIMIT 1").get(task.id)?.data||'{}').text||'',notificationContext(this.store,originalUserText)),
          memory:'',continuity,controlState:recentNativeControlState(this.store),
          expression:[this.preferences?.guide(),this.companion?.expressionGuide?.(task.prompt)].filter(Boolean).join('；')});
      }}:{}),
      ...(documentPaths?{sessionBootstrap:()=>loadSessionDocuments({paths:documentPaths,role:documentRole}).text}:{}),
      ...(imageCleanupDirectory?{onImagesLoaded:cleanupImages}:{})};
    if(task.engine==='dsh' && task.role==='worker' && allowMissingSessionFallback)Object.assign(adapterTask,{allowMissingSessionFallback:true,continuationContext});
    Promise.resolve().then(()=>{if(!isCurrentRun())return;return this.adapters[task.engine].start(adapterTask,event=>{
      if(!isCurrentRun())return;
      enqueueTaskEvent(this,task.id,async()=>{
        if(!isCurrentRun())return;
        await this.handle(task.id,event);
        const current=this.store.task(task.id);
        // A successful terminal handler changes status out of the active set.
        // Only a different run or shutdown invalidates its cleanup acknowledgement.
        if(this.stopping||current?.runVersion!==runVersion)return;
        if(['completed','failed','cancelled'].includes(current?.status)&&!this.store.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status IN ('pending','resolving','recovery_required') LIMIT 1").get(task.id))await this.adapters[task.engine].release?.(current);
      },error=>{if(isCurrentRun())return this.fail(task.id,error);});
    });}).catch(async error=>{if(!this.stopping)await cleanupImages();if(isCurrentRun())return this.fail(task.id,error);});
  }
  async resumeInterrupted() {
    this.errorRetries.poll();
    // Specialists have their own durable job scheduler and restart recovery.
    // Replaying them here would bypass the librarian's new-material trigger
    // and could duplicate maintenance runs. This bridge only reconnects user
    // worker tasks and dispatches workers that were queued before shutdown.
    const rows=this.store.db.prepare("SELECT * FROM tasks WHERE role='worker' AND (status='queued' OR (status='interrupted' AND error=?)) AND NOT EXISTS (SELECT 1 FROM approvals WHERE approvals.taskId=tasks.id AND approvals.status='recovery_required') AND NOT EXISTS (SELECT 1 FROM events WHERE events.taskId=tasks.id AND events.type='task.native-linked') ORDER BY createdAt").all('中控曾退出；请显式继续，防止重复执行。');
    for(const task of rows) {
      if(this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested' LIMIT 1").get(task.id)){this.store.update(task.id,{status:'waiting',error:'停止状态尚未确认，已禁止自动接续'});continue;}
      let readyTask=task;
      if(this.isFixedWorker(task)) {
        const preserveSession=!!task.sessionId;
        const slot=fixedWorkerContext({store:this.store,engine:task.engine,workspaceRoot:this.workspaceRoot,slot:fixedWorkerSlotForTask(task,this.workspaceRoot)});
        if(fixedWorkerBusy({store:this.store,engine:task.engine,slot:slot.slot,workspaceRoot:this.workspaceRoot,excludingTaskId:task.id})) {
          if(task.status==='interrupted')this.store.update(task.id,{status:'queued',error:null});
          continue;
        }
        if(!preserveSession&&task.status==='interrupted')readyTask=this.store.update(task.id,{sessionId:slot.sessionId});
      }
      if(this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").get().n>=this.maxConcurrent) break;
      if(requiresPhoneResource(task.prompt) && this.store.db.prepare("SELECT prompt FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").all().some(row=>requiresPhoneResource(row.prompt)))continue;
      try {
        const reconnect=task.status==='interrupted';
        const previousResume=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.auto-resume' ORDER BY id DESC LIMIT 1").get(task.id);
        let previousReason=null;try{previousReason=JSON.parse(previousResume?.data||'{}').reason;}catch{}
        const savedFollow=dshFollowIdentity(this.store,readyTask);
        const needsOriginalPrompt=!task.sessionId || task.status==='queued' || previousReason==='restart-before-session-created'&&!savedFollow.followRequestId&&!savedFollow.followPromptMarker;
        const reason=reconnect?(task.sessionId?(needsOriginalPrompt?'restart-before-session-created':'control-center-restart'):'restart-before-session-created'):'queued-before-control-center-restart';
        this.store.event(task.id,'task.auto-resume',{sessionId:task.sessionId,reason});
        const prompt=needsOriginalPrompt?task.prompt:'中控服务已恢复，请从当前进度继续原任务。';
        const reconnectOnly=readyTask.engine==='dsh' && reconnect && !!readyTask.sessionId && !needsOriginalPrompt;
        this.run(reconnectOnly?{...readyTask,reconnectOnly:true,...savedFollow}:readyTask,prompt);
      } catch(error) {
        this.store.error(task.id,'自动接回原 DSH 会话失败：'+error.message);
      }
    }
    // Coordinators are short lived DSH 3080 sessions. If a worker was already
    // durably linked before shutdown, finish the coordinator without replaying
    // its instruction; otherwise reconnect the same coordinator session.
    const coordinators=this.store.db.prepare("SELECT * FROM tasks WHERE role='coordinator' AND engine='dsh' AND (status='queued' OR (status='interrupted' AND error=?)) AND NOT EXISTS (SELECT 1 FROM approvals WHERE approvals.taskId=tasks.id AND approvals.status='recovery_required') ORDER BY createdAt").all('中控曾退出；请显式继续，防止重复执行。');
    for(const task of coordinators) {
      if(task.status==='queued')continue;
      if(this.store.db.prepare("SELECT 1 FROM tasks WHERE role='coordinator' AND status IN ('running','waiting') AND id<>? LIMIT 1").get(task.id))continue;
      const workerEvent=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 1").get(task.id);
      let workerId=null;try{workerId=JSON.parse(workerEvent?.data||'{}').workerId;}catch{}
      const worker=workerId?this.store.task(workerId):null;
      if(worker) {
        const result=worker.status==='queued'?`任务已登记，正在等待执行席位；计划由会话「${this.sessionTitleForTask(worker)}」处理。`:`任务已交由会话「${this.sessionTitleForTask(worker)}」接手。`;
        this.store.update(task.id,{status:'completed',error:null,result});this.store.collection(task.id,'done');
        this.store.event(task.id,'task.dispatch-hint',{text:result,sessionName:this.sessionTitleForTask(worker),reason:'reconnected'});
        continue;
      }
      try {
        let sessionId=task.sessionId;
        const desiredEndpoint=this.adapters.dsh.directorEndpoint || this.adapters.dsh.endpoints?.primary;
        const routeRow=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='dsh.route' ORDER BY id DESC LIMIT 1").get(task.id);
        let currentEndpoint='';try{currentEndpoint=JSON.parse(routeRow?.data||'{}').endpoint||'';}catch{}
        if(sessionId && desiredEndpoint && currentEndpoint && currentEndpoint!==desiredEndpoint) {
          this.store.event(task.id,'coordinator.route-migration',{from:currentEndpoint,to:desiredEndpoint});
          this.store.update(task.id,{sessionId:null});sessionId=null;
        }
        const reconnect=task.status==='interrupted' && !!sessionId;
        const savedFollow=dshFollowIdentity(this.store,{...task,sessionId});
        this.store.event(task.id,'task.auto-resume',{sessionId,reason:reconnect?'coordinator-reconnect':'coordinator-before-session-created'});
        this.run(reconnect?{...task,sessionId,reconnectOnly:true,...savedFollow}:{...task,sessionId},reconnect?'中枢服务已恢复，请继续本轮协调，并只输出有效的工作会话派单协议。':task.prompt);
      } catch(error) { this.store.error(task.id,'二级主管会话自动恢复失败：'+error.message); }
    }
    const directors=this.store.db.prepare("SELECT * FROM tasks WHERE role='director' AND engine='dsh' AND status='interrupted' AND error=? AND NOT EXISTS (SELECT 1 FROM approvals WHERE approvals.taskId=tasks.id AND approvals.status='recovery_required') AND prompt NOT LIKE '[内部工作回报]%' AND createdAt=(SELECT MAX(createdAt) FROM tasks WHERE role='director' AND status!='queued' AND prompt NOT LIKE '[内部工作回报]%') ORDER BY createdAt").all('中控曾退出；请显式继续，防止重复执行。');
    for(const task of directors) {
      if(!task.sessionId){this.store.update(task.id,{status:'queued',error:null});continue;}
      const desiredEndpoint=this.adapters.dsh.directorEndpoint;
      const routeRow=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='dsh.route' ORDER BY id DESC LIMIT 1").get(task.id);
      let currentEndpoint='';try{currentEndpoint=JSON.parse(routeRow?.data||'{}').endpoint||'';}catch{}
      if(desiredEndpoint && currentEndpoint && currentEndpoint!==desiredEndpoint) {
        this.store.update(task.id,{status:'queued',error:null});
        this.store.event(task.id,'director.route-migration-queued',{from:currentEndpoint,to:desiredEndpoint});
        continue;
      }
      this.store.event(task.id,'task.auto-resume',{sessionId:task.sessionId,reason:'director-reconnect'});
      this.run({...task,reconnectOnly:true,followPromptMarker:task.prompt,...dshFollowIdentity(this.store,task)});
    }
    this.kickDirector();
  }
  async handle(id,event) {
    let task=this.store.task(id);if(!task || !active.has(task.status))return;
    if(this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested' LIMIT 1").get(id))return;
    if(event.type==='completed'&&task.role==='director'&&String(task.prompt).startsWith('[内部工作回报]')&&this.reports?.reportIsCurrent?.(task)===false) {
      this.store.update(id,{status:'completed',result:'用户已补充要求，本轮旧结果回报不再发送。'});
      this.store.event(id,'report.superseded',{reason:'task-amended'});this.emit();this.kickDirector();return;
    }
    if(task.role==='worker'&&['message','completed'].includes(event.type)&&(event.type==='completed'||String(event.text||'').trim())) {
      const bound=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.amendments-bound' ORDER BY id DESC LIMIT 1").get(id);
      try{const value=JSON.parse(bound?.data||'{}');if(value.runVersion===task.runVersion)this.amendments.markApplied(value.ids||[]);}catch{}
    }
    if(task.role==='worker'&&event.type==='completed'&&this.amendments.hasPending(id)) {
      this.store.event(id,'task.amendment-prior-result',{runVersion:task.runVersion,text:String(event.text||'').slice(0,50000)});
      this.store.update(id,{status:'queued',result:String(event.text||'').slice(0,50000),error:null});
      this.scheduleAmendmentContinuation(id);this.emit();return;
    }
    if(event.type==='progress') {
      if(['prompt-submitting','prompt-received','model-started'].includes(event.kind))this.store.event(id,'dsh.'+event.kind,{kind:event.kind});
      // Progress contains no engine payload. Persist only a coarse DSH tool
      // activity marker so recovered tool-runtime failures can be verified.
      if(task.engine==='dsh' && event.kind==='tool-activity')this.store.event(id,'dsh.tool-activity',{kind:'tool-activity'});
      if(task.role==='director' && ['tool-activity','model-activity'].includes(event.kind))this.store.meta('director:response-last-progress:'+id,this.store.now());
      return;
    }
    this.store.event(id,event.type,event.type==='session'?{...event,runVersion:task.runVersion}:event.type==='message'&&event.stream?{...event,stream:{...event.stream,runVersion:task.runVersion}}:event);
    if(event.type==='session'){
      if(task.role==='worker'&&task.engine==='dsh'){
        const key='worker:stop:'+event.sessionId;let stopped;try{stopped=JSON.parse(this.store.meta(key)||'null');}catch{}
        if(stopped&&stopped.taskId!==id)this.store.meta(key,'');
      }
      this.store.update(id,{sessionId:event.sessionId});
      rememberFixedWorker({store:this.store,task,sessionId:event.sessionId});
      if(event.replacedMissingSession) {
        this.store.event(id,'task.session-continuity-reset',{previousSessionId:event.previousSessionId||task.sessionId||null,newSessionId:event.sessionId,reason:'native-session-unavailable'});
        const text=`原来的工作会话这次没有接上，我已在原项目新建会话，并带上此前任务和结果继续处理。`;
        this.say(text);if(this.primaryMode)this.notification(text,`session-continuity-reset:${id}:${event.sessionId}`);
      }
      if(task.role==='coordinator') {this.store.meta('coordinatorSessionId',event.sessionId);this.store.meta('coordinatorSessionPreset',this.adapters.dsh?.directorPreset||'minimal');}
      if(task.engine==='dsh' && typeof this.adapters.dsh?.endpointFor==='function') {
        this.store.event(id,'dsh.route',{endpoint:task.dshEndpoint || this.adapters.dsh.endpointFor(task),priority:task.dshRoutePriority || (['director','coordinator'].includes(task.role)?(this.adapters.dsh.directorRoutePriority || 'qq-simulation-primary-3080'):'primary-3080')});
      }
      this.setEmotion('focused', 62, '执行会话已经接通。');
      if(this.primaryMode && task.role==='worker' && task.engine==='dsh') {
        this.notification(`《${this.sessionTitleForTask(this.store.task(id)||task)}》已经接入 DSH。可以从中控任务卡直接打开对应会话。`, `task-session:${id}:${event.sessionId}`);
      }
      if(task.role==='director' && String(task.prompt||'').startsWith('[内部工作回报]')) {
        this.store.meta('reportDirectorSessionId',event.sessionId);
      } else if(task.role==='director') {
        this.store.meta('directorSessionId',event.sessionId);
        this.store.meta('directorSessionEngine',task.engine);
        if(task.engine==='dsh')this.store.meta('directorSessionPreset',this.adapters.dsh.directorPreset || 'mornye-director');
        if(task.engine==='dsh'&&this.adapters.dsh.supervisorSelection) {
          this.store.meta('directorSessionSelection',JSON.stringify(this.adapters.dsh.supervisorSelection));
        }
        const handoff=this.store.directorHandoffs().find(item=>item.targetTaskId===id && ['starting','retrying','resuming'].includes(item.status));
        if(handoff) {
          this.store.linkDirectorHandoff(handoff.id,{childSessionId:event.sessionId,status:'linked',attempts:handoff.attempts});
          this.store.event(id,'director.handoff-connected',{sessionId:event.sessionId,contextReady:true});
        }
      }
    }
    else if(event.type==='message'){
      const messageText=String(event.text || '');
      // Wait for a complete turn before correcting an unsupported multi-dispatch.
      // Never admit the first directive and silently discard the user's other goal.
      await publishSupervisorProgress(this,task,messageText);
      if(task.role==='director' && messageText.trim() && messageText!==String(task.result||''))this.store.meta('director:response-last-progress:'+id,this.store.now());
      const milestoneLine=messageText.split(/\r?\n/).find(line=>line.trim().startsWith('[HUB-MILESTONE]'));
      if(task.role==='worker' && milestoneLine) {
        try {
          const milestone=JSON.parse(milestoneLine.trim().slice('[HUB-MILESTONE]'.length).trim());
          const summary=typeof milestone.summary==='string'?milestone.summary.trim().slice(0,600):'';
          const digest=summary?createHash('sha256').update(summary).digest('hex').slice(0,16):'';
          const count=this.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId=? AND type='task.milestone'").get(id).n;
          const duplicate=digest && this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.milestone' AND data LIKE ? LIMIT 1").get(id,`%${digest}%`);
          if(summary && count<3 && !duplicate) {
            this.store.event(id,'task.milestone',{summary,digest});
            const title=this.sessionTitleForTask(task),fallback=`《${title}》有一项阶段成果：${summary}`;
            if(this.reports?.announce) {
              void this.reports.announce({task:{...this.store.task(id),result:summary},kind:'milestone',dedupe:`task-milestone:${id}:${digest}`,
                situation:`执行会话「${title}」刚报告一项阶段成果：${summary}。自然告诉用户这代表什么进展；不能把阶段成果说成整个任务已完成。`})
                .catch(()=>{this.say(fallback);if(this.primaryMode)this.notification(fallback,`task-milestone-fallback:${id}:${digest}`);});
            } else {
              this.say(fallback);
              if(this.primaryMode)this.notification(fallback,`task-milestone:${id}:${digest}`);
            }
          }
        } catch { /* malformed milestone markers stay ordinary engine output */ }
      }
      if(String(task.result||'')!==messageText.slice(0,50000))this.store.update(id,{result:messageText.slice(0,50000)});
      if(task.role!=='director') this.setEmotion('focused', 64, '执行会话有新的进展。');
      if(task.role==='director' && String(task.prompt||'').startsWith('[内部工作回报]')) {
        const tokens=contextInputTokens(event.usage);
        if(tokens>0)this.store.meta('reportDirector:tokens',String(tokens));
      } else if(task.role==='director' && this.directorHandoffEnabled && Number.isFinite(this.directorContextLimit)) {
        const usage=event.usage;
        const tokens=contextInputTokens(usage);
        if(Number.isFinite(tokens) && tokens>=this.directorContextLimit) {
          const pending=this.store.directorHandoffs().find(item=>item.sourceTaskId===id && item.reason==='usage-threshold' && item.status==='prepared');
          if(!pending) {
            const handoff=this.store.createDirectorHandoff({parentSessionId:task.sessionId || 'unknown',sourceTaskId:id,reason:'usage-threshold',payload:this.directorSnapshot(task,'usage-threshold')});
            this.store.meta('directorHandoffPending',JSON.stringify({id:handoff.id}));
            this.store.event(id,'director.handoff-prepared',{handoffId:handoff.id,tokens,limit:this.directorContextLimit});
            // Routine rollover stays in the lifecycle audit, outside personal chat.
            // The pending handoff is persisted in
            // director_handoffs. It is intentionally quiet on QQ until the
            // user has an approval or an actionable error.
          }
        }
      }
    }
    else if(event.type==='approval') {
      const approval=this.store.approval(id,event);
      if(approval.status==='pending') {
        this.store.update(id,{status:'waiting'});
        this.setEmotion(this.contactOnline() ? 'concerned' : 'urgent', this.contactOnline() ? 72 : 94, this.contactOnline() ? '任务需要你做一个选择。' : '任务出错并需要选择，但暂时联系不上你。');
        const opts=(approval.options || []).map((o,i)=>`${i+1}. ${typeof o==='string'?o:o.label || o.value || JSON.stringify(o)}`).join('\n');
        const text=`需要你选一下：${approval.question}\n${opts}\n回复 ${this.primaryMode?'':'/中枢 '}选择 ${approval.id} 你的选择（可填序号或自由文字）`;
        this.say(text);this.notification(text,'approval:'+approval.id);
      }
    } else if(event.type==='completed') {
      const documents=this.sessionDocumentLoads.get(id);
      if(documents&&task.sessionId)this.store.meta(`session-documents:${task.engine}:${documents.role}:${task.sessionId}`,JSON.stringify(documents.fingerprints));
      this.sessionDocumentLoads.delete(id);
      let text=String(event.text || task.result || '任务已结束。');
      if(task.role==='director'&&(text.match(/\[HUB-DISPATCH\]/g)||[]).length>1){
        const previous=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.multi-dispatch-repair'").get(id);
        if(!previous&&!linkedSupervisorTask(this,task)){
          this.store.event(id,'director.multi-dispatch-repair',{reason:'multiple directives before work admission'});
          this.run(task,'上轮输出多条派单指令，尚未创建执行任务。请保留用户原话中全部目标和指定引擎，将这些目标合并为一条交给二级主管的 [HUB-DISPATCH] 指令；由二级主管统筹检查，不要漏掉任何目标，也不要声称已经执行。');
          return;
        }
      }
      await publishSupervisorProgress(this,task,text);
      if(task.role==='director')text=stripSupervisorAck(text);
      const frontdeskOnly=task.role==='director' && String(task.prompt||'').startsWith('[前台回应]');
      if(frontdeskOnly && /^\s*\[HUB-/m.test(text)) {
        text=text.split(/\r?\n/).filter(line=>!/^\s*\[HUB-/u.test(line)).join('\n').trim() || '嗯，我听懂了，这件事已经交给协调会话安排，我会继续跟进。';
      }
      const directorReport=task.role==='director' && String(task.prompt||'').startsWith('[内部工作回报]');
      if(task.role==='director'&&!directorReport&&!frontdeskOnly&&text.includes('[HUB-AMEND]')) {
        const parsed=parseProtocolObject(text,'[HUB-AMEND]');
        const reply=typeof parsed.value.reply==='string'?parsed.value.reply.trim().slice(0,600):'';
        text=[text.slice(0,text.indexOf('[HUB-AMEND]')),reply,'补充已记录，会在原工作会话安全接续。',text.slice(parsed.end)].filter(Boolean).join('\n').trim();
      }
      let chatPlan=null;
      if(task.role==='director' && !directorReport && !frontdeskOnly && text.trim().startsWith('[HUB-CHAT]')) {
        const parsed=parseChatOutput(text);
        if(parsed.repaired)this.store.event(id,'director.chat-envelope-repaired',{kind:'extra-object-closer'});
        if(text.slice(parsed.end).trim())throw Error('自然对话消息后不能混入派单或其他协议');
        chatPlan={...parsed.value,messages:conversationMessages(parsed.value.messages)};
        text=chatPlan.messages.join('\n\n');
        this.conversation.remember(chatPlan.topics);
        for(const topic of (Array.isArray(chatPlan.closedTopicIds)?chatPlan.closedTopicIds:[]).slice(0,8))this.conversation.closeTopic(topic);
      }
      let reportAttachmentCount=0;
      if(task.role==='director' && this.companion){const lines=text.split(/\r?\n/),candidates=lines.filter(line=>line.trim().startsWith('[HUB-MEMORY]'));if(candidates.length===1){try{const candidate=JSON.parse(candidates[0].trim().slice('[HUB-MEMORY]'.length).trim());if(Object.keys(candidate).length===1 && typeof candidate.text==='string')this.companion.saveMemory({text:candidate.text,status:'pending',source:'director:'+id});}catch(error){this.store.event(id,'companion.candidate-rejected',{message:error.message});}}text=lines.filter(line=>!line.trim().startsWith('[HUB-MEMORY]')).join('\n');}
      if(directorReport) {
        const lines=text.split(/\r?\n/),directives=lines.filter(line=>line.trim().startsWith('[HUB-FILES]'));
        if(directives.length>1)throw Error('结果回报只能包含一条 [HUB-FILES] 行');
        let report;try{report=JSON.parse(String(task.prompt).slice('[内部工作回报]\n'.length).split(/\r?\n/,1)[0]);}catch{throw Error('内部结果回报数据无效');}
        let selected=[];
        if(directives.length===1) {
          const payloadLine=directives[0].trim().slice('[HUB-FILES]'.length).trim();
          let request;try{request=JSON.parse(payloadLine);}catch{throw Error('主管文件选择格式无效');}
          if(!request || Array.isArray(request) || Object.keys(request).some(key=>key!=='artifactIds') || !Array.isArray(request.artifactIds) || request.artifactIds.length>4 || request.artifactIds.some(value=>typeof value!=='string'))throw Error('主管文件选择只允许最多 4 个候选文件');
          selected=request.artifactIds;
        }
        const outcomes=(report.files||[]).filter(file=>file.delivery==='outcome').map(file=>file.id);
        const allowed=new Set((report.files||[]).map(file=>file.id));
        for(const artifactId of [...new Set([...outcomes,...selected])].slice(0,4)) {
            if(!allowed.has(artifactId))continue;
            const artifact=await this.archive.get(artifactId);
            if(!artifact || String(artifact.sourcePath||'').startsWith('generated://') || isInternalArtifact(artifact) || !isQqShareableArtifact(artifact))continue;
            try{await this.queueArtifact(artifact,{dedupe:`task-deliverable:${artifactId}`});reportAttachmentCount++;}
            catch(error){this.store.event(id,'artifact.queue-error',{artifactId,message:error.message});}
        }
        text=lines.filter(line=>!line.trim().startsWith('[HUB-FILES]')).join('\n').trim();
      }
      if(task.role==='coordinator') {
        // Legacy native-tool dispatches are recorded asynchronously. Reconcile
        // them before coordinator fallback so it cannot create a duplicate.
        const needsNativeCheck=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='dsh.tool-activity' LIMIT 1").get(id);
        const nativeChecked=needsNativeCheck&&this.nativeTasks ? await this.nativeTasks.poll({fresh:true}) : true;
        if(!nativeChecked)throw Error('暂时无法核对 DSH 原生派单记录，已暂停协调器补派以避免重复执行。');
        const workerEvent=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 1").get(id);
        let workerId=null;try{workerId=JSON.parse(workerEvent?.data||'{}').workerId;}catch{}
        const directivePositions=[...text.matchAll(/\[HUB-DISPATCH\]/g)];
        if(directivePositions.length>1)return this.fail(id,Error('二级协调输出了多条派单，已阻止重复执行。'));
        if(directivePositions.length===1 && !workerId) {
          let request,directiveEnd;
          try{const parsed=parseProtocolObject(text,'[HUB-DISPATCH]');request=parsed.value;directiveEnd=parsed.end;}catch{throw Error('二级协调派单格式无效');}
          if(!request||Array.isArray(request)||Object.keys(request).some(key=>!['engine','prompt','project','sessionId','workerSlot','contextTaskId'].includes(key))||typeof request.engine!=='string'||!Object.hasOwn(this.adapters,request.engine)||typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>20000||(request.project!==undefined&&(typeof request.project!=='string'||request.project.length>100))||(request.sessionId!==undefined&&typeof request.sessionId!=='string')||(request.contextTaskId!==undefined&&(typeof request.contextTaskId!=='string'||request.contextTaskId.length>80))||(request.workerSlot!==undefined&&(!Number.isInteger(request.workerSlot)||request.workerSlot<1||request.workerSlot>3)))throw Error('二级协调派单缺少有效引擎或执行要求');
          const requestedEngine=this.directorRequestedEngine(task);
          if(requestedEngine)request.engine=requestedEngine;
          const workerPrompt=request.prompt.trim();
          const messageKey='coordinator:'+id+':'+createHash('sha256').update(request.engine+'\0'+workerPrompt+'\0'+(request.project||'')+'\0'+(request.sessionId||'')).digest('hex').slice(0,24);
          let images=[];try{const saved=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.images' ORDER BY id DESC LIMIT 1").get(id);images=JSON.parse(saved?.data||'{}').paths||[];}catch{}
          await this.create({engine:request.engine,prompt:workerPrompt,messageKey,project:request.project,sessionId:request.sessionId,workerSlot:request.workerSlot,contextTaskId:request.contextTaskId,imagePaths:images});
          text=text.slice(0,directivePositions[0].index)+text.slice(directiveEnd);
        } else if(!workerId) {
          const retries=this.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId=? AND type='coordinator.dispatch-retry'").get(id).n;
          if(retries===0) {
            this.store.event(id,'coordinator.dispatch-retry',{reason:'coordinator did not create a worker'});
            const forcedEngine=this.directorRequestedEngine(task);
            const engineRule=forcedEngine?`engine 必须为 ${forcedEngine}`:'engine 从本轮可用引擎中按任务内容自主选择';
            this.run(task,`你已判断这条请求需要实际执行，但本轮没有创建工作会话。现在只输出一行有效派单协议：[HUB-DISPATCH] ${JSON.stringify({engine:forcedEngine||'dsh',prompt:'忠实保留用户原话中的目标和明确要求'})}。${engineRule}；示例中的 dsh 不是默认要求。不要执行任务、不要输出说明，不要创建第二个工作会话。`);
            return;
          }
          return this.fail(id,Error('二级协调未能创建工作会话，任务没有开始执行。'));
        }
        const latestWorkerEvent=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 1").get(id);
        try{workerId=JSON.parse(latestWorkerEvent?.data||'{}').workerId;}catch{}
        const worker=workerId?this.store.task(workerId):null;
        if(worker)text=`已交由会话「${this.sessionTitleForTask(worker)}」处理。`;
      }
      if(task.role==='director' && !directorReport && !frontdeskOnly) {
        const remoteRequired=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.remote-tool-required'").get(id);
        const remotePerformed=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.remote-operation'").get(id);
        if(remoteRequired&&!remotePerformed){
          const retried=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.remote-tool-retry'").get(id);
          if(retried)return this.fail(id,Error('远端原会话操作尚未提交；没有改派本机工作会话。'));
          this.store.event(id,'director.remote-tool-retry',{});
          this.run(task,'刚才没有创建本机任务。请直接调用 hub_native_session，scope=remote，先 devices/list 再 read/message；使用已确认的远端电脑、引擎和原会话，不输出 HUB-DISPATCH，不转本机工作池。接收凭据与执行完成分别说明。');
          return;
        }

        // Reconcile native DSH dispatches before creating a secondary coordinator.
        const directives=supervisorDispatches(text);
        const needsNativeCheck=!directives.length&&!linkedSupervisorTask(this,task)&&this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='dsh.tool-activity' LIMIT 1").get(id);
        const nativeChecked=needsNativeCheck&&this.nativeTasks ? await this.nativeTasks.poll({fresh:true}) : true;
        if(directives.length) {
          if(/^\s*\[(?:HUB-QUESTION|HUB-RESULT)\]/m.test(text))throw Error('主管派单协议不能与选择请求或任务回执混用；没有创建 worker');
          // publishSupervisorProgress already validated and admitted this
          // directive above; completion only removes the internal envelope.
          text=stripSupervisorDispatches(text);
        } else if(/<｜｜DSML｜｜\s*calls>|<\|\|DSML\|\|\s*calls>|invoke\s+name=["']director_(?:dispatch|message)_task/i.test(text)) {
          const attempts=this.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId=? AND type='director.dispatch-fallback-requested'").get(id).n;
          if(attempts===0) {
            this.store.event(id,'director.dispatch-fallback-requested',{reason:'model returned tool-call markup as plain text'});
            const requiredEngine=this.directorRequestedEngine(task) || 'dsh';
            const example=JSON.stringify({engine:requiredEngine,prompt:'完整任务要求'});
            this.run(task,`上轮没有执行任何工具调用，且没有创建 worker。不要输出 DSML/XML 或自然语言声称成功。若这是普通对话而不是派单需求，请正常回答，不要输出协议；否则立刻只输出一行有效协议：[HUB-DISPATCH] ${example}。其中 engine 必须为 ${requiredEngine}，prompt 必须复述用户原始要求。`);
            return;
          }
          return this.fail(id,Error('主管连续两次输出未执行的 DSML 工具文本；没有创建任务协调会话，也不报告派单成功。'));
        }
        // Do not let the director tell the user that work was delegated when
        // the model returned a conversational claim instead of actually
        // calling the dispatch tool/protocol. Repair that narrow case by
        // creating one worker from the original request and linking it to this
        // director turn. The report still comes back through the director.
        const delegated=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.worker-created' LIMIT 1").get(id);
        const claimsDelegation=/(?:派出(?:去|了|查)?|已派发|已经派|派发完成|让那边(?:去|帮你)|交给.{0,12}(?:查|做|处理|下载|核实)|结果回来告诉你)/u.test(text);
        const amended=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.amended' LIMIT 1").get(id);
        if(!delegated && !amended && !remotePerformed && claimsDelegation) {
          if(!nativeChecked)throw Error('暂时无法核对 DSH 原生派单记录，已暂停补派以避免重复执行；连接恢复后会自动接收任务回报。');
          const engine=this.directorRequestedEngine(task) || 'dsh';
          const prompt=`[二级协调]\n一级主管已经向用户表示会安排执行，推荐引擎：${engine}。\n请根据用户原话安排合适的执行会话。\n用户原话：${task.prompt}`;
          const messageKey='director:'+id+':'+createHash('sha256').update(engine+'\0'+prompt).digest('hex').slice(0,24);
          await this.create({engine:'dsh',role:'coordinator',prompt,messageKey});
          this.store.event(id,'director.dispatch-repaired',{engine,reason:'model claimed delegation without creating a coordinator'});
        }
      }
      // Explicit question protocol works even when engines finish turns instead of suspending.
      const questionLine=text.split(/\r?\n/).find(line=>line.trim().startsWith('[HUB-QUESTION]'));
      if(questionLine) {
        let question;try {question=JSON.parse(questionLine.trim().slice('[HUB-QUESTION]'.length).trim());}catch{throw Error('引擎选择消息 JSON 无效');}
        if(!question.question)throw Error('引擎选择消息缺少问题');
        return this.handle(id,{type:'approval',requestId:'question-'+randomUUID(),kind:'followup',question:question.question,options:question.options || [],raw:{}});
      }
      const receiptLine=text.split(/\r?\n/).find(line=>line.trim().startsWith('[HUB-RESULT]'));
      if(receiptLine) {
        const rawReceipt=receiptLine.trim().slice('[HUB-RESULT]'.length).trim();
        let receipt;try{receipt=JSON.parse(rawReceipt);}catch{
          // Older specialist prompts asked for a bare output path. Accept only
          // their exact, task-local catalog/repair paths, then run the same
          // artifact validation as structured receipts below.
          if(/^outputs\/[A-Za-z0-9._-]+\/(?:catalog|repair)\.json$/.test(rawReceipt))receipt={status:'completed',summary:'专职任务已提交产物并待中控校验。',artifacts:[rawReceipt]};
          else throw Error('引擎任务回执 JSON 无效');
        }
        if(!['completed','failed','blocked'].includes(receipt.status))throw Error('引擎回执缺少有效任务状态');
        this.store.event(id,'task.receipt',receipt);
        if(receipt.status!=='completed'){this.store.update(id,{result:receipt.summary || text});return this.fail(id,Error(receipt.summary || '引擎报告原任务没有完成'));}
        if(!Array.isArray(receipt.artifacts))throw Error('引擎回执缺少产物列表');
        for(const name of receipt.artifacts) {
          if(typeof name!=='string' || isAbsolute(name))throw Error('产物回执需要任务目录内相对路径');
          const absolute=await realpath(resolve(task.cwd,name)),rel=relative(await realpath(task.cwd),absolute);
          if(!rel || rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel) || !(await stat(absolute)).isFile())throw Error('引擎产物回执路径无效或越界');
        }
        text=text.split(/\r?\n/).filter(line=>line!==receiptLine).join('\n').trim() || receipt.summary || '任务完成。';
      }else if(task.role!=='director' && /未能(?:完成|创建|写入)|无法(?:完成|创建|写入|读回验证)|没有完成|尚未写入|unable to (?:complete|create|write)|could not (?:complete|create|write)/i.test(text)) {
        this.store.update(id,{result:text});return this.fail(id,Error('引擎本轮已结束，但原任务未完成：'+text.slice(-600)));
      }
      this.store.transaction(()=>{
        this.store.update(id,{status:'completed',result:text});this.store.collection(id,'pending');
      });
      this.pumpPhoneQueue();
      this.observeEngineOutcome(task,'completed');
      if(task.role==='worker')this.setEmotion('happy',72,'这项工作实际完成了，有一点得意，想把做成的地方讲给你听。');
      let collected=[];
      if(['worker','librarian','maintenance'].includes(task.role))collected=await this.collect(task)||[];else this.store.collection(task.id,'done');
      if(task.role==='director'){
        let userText=reportAttachmentCount?`${text} 我把值得查看的文件也发给你了。`:text;
        // publishSupervisorProgress already delivered the authoritative
        // delegation acknowledgement. The completed turn often echoes the
        // same reply field, which used to create two QQ messages. Remove only
        // that exact acknowledged sentence; keep any new completion content.
        const delegation=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.delegation-announced' ORDER BY id DESC LIMIT 1").get(id);
        if(delegation && String(event.text||'').includes('[HUB-DISPATCH]')){
          userText='';this.store.event(id,'director.reply-owned-by-progress',{reason:'dispatch acknowledgement already published'});
        }else if(delegation){try{const announced=JSON.parse(delegation.data||'{}').text;if(announced&&userText.trim()===announced.trim())userText='';else if(announced&&userText.includes(announced))userText=userText.replace(announced,'').replace(/^\s*[\r\n]+|[\r\n]+\s*$/g,'').trim();}catch{}}
        if(userText.trim()){
        if(chatPlan){
          for(const message of chatPlan.messages)this.store.say('assistant',message);
          const anchor=this.store.db.prepare("SELECT id FROM companion_chat WHERE role='user' AND retractedAt IS NULL AND createdAt<=? ORDER BY id DESC LIMIT 1").get(task.createdAt)?.id || this.conversation.anchor();
          this.conversation.queue(chatPlan.messages,'completed:'+id+':'+task.runVersion,{kind:'reply',anchorUserId:anchor});
          this.emit();void this.notify();
        }else{this.say(userText);this.notification(userText,'completed:'+id+':'+task.runVersion);}
      }if(directorReport)this.reports?.delivered(this.store.task(id));}
      else if(task.role==='coordinator') {
        const row=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 1").get(id);
        let workerId=null;try{workerId=JSON.parse(row?.data||'{}').workerId;}catch{}
        const worker=workerId?this.store.task(workerId):null;
        const result=worker?(worker.status==='queued'?`任务已登记，正在等待执行席位；计划由会话「${this.sessionTitleForTask(worker)}」处理。`:`任务已交由会话「${this.sessionTitleForTask(worker)}」接手。`):'协调会话已完成。';
        this.store.event(id,'task.dispatch-hint',{text:result,sessionName:worker?this.sessionTitleForTask(worker):null});
      }
      else if(task.role==='worker') {
        if(this.amendments.hasPending(id)){this.scheduleAmendmentContinuation(id);this.emit();return;}
        const isFileDelivery=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='file-delivery.requested' LIMIT 1").get(id);
        if(isFileDelivery) {
          const current=this.store.task(id),startedAt=this.store.db.prepare("SELECT createdAt FROM events WHERE taskId=? AND type='task.started' ORDER BY id DESC LIMIT 1").get(id)?.createdAt;
          const outcome=await finishFileDelivery(this,{...current,startedAt},collected);
          if(outcome.state!=='sent')this.setEmotion(outcome.state==='failed'?'sad':'focused',55,'按文件交付的真实状态说明结果。');
          this.report({...current,result:outcome.summary,fileDelivery:outcome},'completed:'+id+':'+task.runVersion);
        } else this.report(this.store.task(id),'completed:'+id+':'+task.runVersion);
      }
      void this.notify();this.kickDirector();
    } else if(event.type==='failed')await this.fail(id,Object.assign(new Error(typeof event.error==='string'?event.error:JSON.stringify(event.error)),{retrySafe:event.retrySafe===true,
      ...(Number.isInteger(event.httpStatus)?{httpStatus:event.httpStatus}:{}),...(Number.isFinite(event.retryAfterMs)?{retryAfterMs:event.retryAfterMs}:{}),...(event.uncertain===true?{uncertain:true}:{})}));
    this.emit();
  }
  async fail(id,error) {
    this.sessionDocumentLoads.delete(id);
    const task=this.store.task(id);if(!task || !active.has(task.status))return;
    if(retryFixedWorkerContext(this,task,error))return;
    if(this.errorRetries.schedule(task,error)){
      try{await this.adapters[task.engine].release?.(task);}catch(cleanupError){this.store.event(id,'task.retry-cleanup-failed',{error:redact(cleanupError.message)});}
      return;
    }
    if(task.role==='worker') {
      const bound=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.amendments-bound' ORDER BY id DESC LIMIT 1").get(id);
      try{const value=JSON.parse(bound?.data||'{}');if(value.runVersion===task.runVersion)this.amendments.release(value.ids||[]);}catch{}
    }
    if(this.retryDirectorAfterSafePreflight(task,error))return;
    if(this.retryDirectorAfterContextLimit(task,error))return;
    if(task.engine==='dsh'&&this.isFixedWorker(task)&&/NO_ADAPTER[\s\S]{0,120}provider\s+["']?command/i.test(String(error?.message||''))) {
      const slot=fixedWorkerSlotForTask(task,this.workspaceRoot);
      const key=`worker:fixed:dsh${slot===1?'':`:${slot}`}`;
      this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
      this.store.event(id,'dsh.session-invalidated',{slot,sessionId:task.sessionId||null,reason:'provider-adapter-missing',provider:'command'});
    }
    this.store.transaction(()=>{
      this.store.update(id,{status:'failed',error:error.message});this.store.error(id,error.message);
      this.store.event(id,'task.failure-diagnostic',taskFailureDiagnostic(error));
      const plan=errorStrategy(error);this.store.event(id,'task.error-strategy',{category:plan.category,action:plan.action,httpStatus:plan.status,autoRetry:false});
      if(task.role!=='director')this.store.collection(id,'pending');
    });
    // Route actionable failures to the dedicated Codex repair project
    // internally. This is fire-and-forget and never blocks the failed task's
    // lifecycle or emits a second user-facing error message.
    void this.queueInternalRepair(this.store.task(id),error).catch(repairError=>this.store.event(id,'internal-repair.enqueue-failed',{error:redact(repairError.message)}));
    this.pumpPhoneQueue();
    this.observeEngineOutcome(task,'failed',error.message);
    if(['worker','coordinator'].includes(task.role))this.setEmotion('sad',58,'这次工作没做好，有一点失落和不甘心；把实际卡点和已有结果说清。');
    this.store.db.prepare("UPDATE approvals SET status='interrupted',updatedAt=? WHERE taskId=? AND status IN ('pending','resolving')").run(this.store.now(),id);
    if(task.role==='worker')await this.collect(task);
    if(task.role==='director'){
      const directorReport=String(task.prompt||'').startsWith('[内部工作回报]');
      let progressReport=false;try{progressReport=directorReport && JSON.parse(String(task.prompt).slice('[内部工作回报]\n'.length).split(/\r?\n/,1)[0]).kind==='progress';}catch{}
      // A failed report turn can leave DSH's writer attached to its session
      // after a transport timeout. Reusing that session for the queued retry
      // then fails at session/create with "already owned by an active write
      // handle". Report turns are stateless summaries, so start the next
      // attempt in a fresh session while retaining the failed task's original
      // session ID in history.
      if(directorReport)this.store.meta('reportDirectorSessionId','');
      const recovered=directorReport && !progressReport && this.reports?.failed(this.store.task(id),error);
      if(progressReport)this.store.event(id,'task.supervision-report-failed',{message:redact(error.message)});
      if(!recovered){
        if(progressReport){this.emit();this.kickDirector();return;}
        const connection=/DSH RPC (?:workspace\/create|session\/create)|connecting to the DSH event stream/i.test(error.message);
        const text=error.code==='DIRECTOR_REPLY_TIMEOUT'?'刚才那条回复卡住了，我已保留原消息并恢复后续对话。':connection?'刚才接入原对话时没有成功，这条还没能进入正常回复。你的消息和记忆都已保留。':'刚才这条回复没有完成。你的消息和记忆都已保留，具体原因已记录。';
        this.say(text);this.notification(text,'failed:'+id+':'+task.runVersion);
      }
    }
    else if(task.role==='worker')this.report(this.store.task(id),'failed:'+id+':'+task.runVersion);
    else if(task.role==='coordinator') {
      const failure=this.store.task(id);
      void this.reports?.announce({task:failure,kind:'coordination-failure',situation:'二级任务协调会话未能成功建立工作会话。说明发生了什么、任务是否开始，以及是否需要用户稍后重试。',dedupe:`coordinator-failed:${id}:${task.runVersion}`})
        .catch(()=>{const text='我这边安排执行会话时遇到问题，任务还没有开始；我会保留原因，等连接恢复后再继续处理。';this.say(text);this.notification(text,`coordinator-failed-fallback:${id}:${task.runVersion}`);});
    }
    void this.notify();this.emit();this.kickDirector();
  }
  async queueInternalRepair(task,error) {
    const id=this.internalRepair.enqueue(task?.id,error);
    await this.internalRepair.poll();return !!id;
  }
  async collect(task) {
    if(this.isFixedWorker(task)||this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.native-linked'").get(task.id)) {
      try {
        const records=await collectTaskDeliverables({task:this.store.task(task.id)||task,archive:this.archive,workspaceRoot:this.workspaceRoot});
        this.store.collection(task.id,'done');this.store.event(task.id,'artifacts.deliverables-collected',{count:records.length,warnings:records.warnings||[]});
        this.emit();return records;
      }catch(error){this.store.collection(task.id,'failed',error.message);this.store.error(task.id,'成果文件收取失败：'+error.message);}
      this.emit();return [];
    }
    try{
      const cwd=['maintenance','librarian'].includes(task.role)?join(task.cwd,'outputs',task.id):task.cwd;
      let records=await this.archive.collect({taskId:task.id,cwd});
      const timedOut=rows=>(rows.warnings||[]).some(w=>String(w.reason).startsWith('collection time limit reached'));
      if(['maintenance','librarian'].includes(task.role)&&timedOut(records)){
        this.store.event(task.id,'artifacts.collection-retry',{reason:'time-budget',attempt:1});
        await new Promise(resolve=>setTimeout(resolve,250));
        // A transiently busy event loop or antivirus scan can consume the
        // ordinary 30s archive budget even for a tiny repair/catalog file.
        // Retry once with a bounded wider budget instead of repeating the
        // same timeout and emitting a false failed-archive report.
        const normalLimit=Math.max(1,Number(this.archive.limits?.maxElapsedMs)||30_000);
        const retry=await this.archive.collect({taskId:task.id,cwd,maxElapsedMs:Math.max(normalLimit*4,120_000)});
        const merged=[...new Map([...records,...retry].map(record=>[record.id,record])).values()];
        merged.warnings=retry.warnings||[];records=merged;
      }
      this.store.collection(task.id,timedOut(records)?'failed':'done');
      this.store.event(task.id,'artifacts.collected',{count:records.length,warnings:records.warnings||[]});
      for(const warning of records.warnings||[]){if(warning.reason==='credential-like content')this.store.event(task.id,'artifact.safely-excluded',{path:warning.path,reason:warning.reason});else this.store.error(task.id,'归档跳过 '+warning.path+'：'+warning.reason);}
      this.emit();return records;
    }
    catch(error){this.store.collection(task.id,'failed',error.message);this.store.error(task.id,'产物归档失败：'+error.message);}
    this.emit();return [];
  }
  async answer(id,answer) {
    const approval=this.store.getApproval(id);if(!approval)throw Error('找不到这个选择');
    if(approval.status==='answered')return {ok:true,duplicate:true};
    if(approval.status!=='pending' || this.answering.has(id))throw Error('这个选择正在处理或已失效');
    if(approval.raw?.isSecret===true || approval.raw?.params?.isSecret===true){
      const error=Error('此请求涉及敏感信息，请在引擎的本机配置或界面中处理。中控不通过 QQ 收集密钥。');
      error.code='HUB_SECRET_INPUT_REQUIRED';throw error;
    }
    if(typeof answer!=='string' || !answer.trim() || answer.length>10000)throw Error('请输入你的选择');
    let task=this.store.task(approval.taskId);if(task.status!=='waiting')throw Error('任务当前没有等待选择');
    let chosen=answer.trim();
    if(/^\d+$/.test(chosen) && approval.options.length) {
      const option=approval.options[Number(chosen)-1];if(!option)throw Error('选项序号不存在');
      chosen=typeof option==='string'?option:option.label || option.value;
    }
    this.answering.add(id);this.store.setApproval(id,'resolving',chosen);this.emit();
    try {
      if(approval.kind==='followup')this.run(task,'主人对前面的选择回复：'+chosen+'\n请在当前会话继续完成原任务。');
      else await this.adapters[task.engine].respond(task,approval,chosen);
      if(task.role==='director')this.store.meta('director:response-start:'+task.id,this.store.now());
      this.store.setApproval(id,'answered',chosen);this.store.update(task.id,{status:'running'});
      this.store.event(task.id,'approval.answered',{id,answer:chosen});this.say('好，你的选择已经交回原来的会话啦。它会接着处理。');
      return {ok:true};
    }catch(error){this.store.setApproval(id,'pending');throw error;}
    finally {this.answering.delete(id);this.emit();}
  }
  matchingPendingDirectorApproval(text) {
    const value=String(text || '').trim();
    if(!value)return null;
    const candidates=this.store.approvals().filter(approval=>{
      if(approval.status!=='pending' || !approval.options?.length)return false;
      const task=this.store.task(approval.taskId);
      return task?.status==='waiting';
    });
    // Never guess which turn to answer when state is inconsistent or multiple
    // questions are pending. A quoted receipt can identify its original approval.
    if(candidates.length!==1)return null;
    const approval=candidates[0];
    const matches=approvalOptionAnswer(value,approval.options)!==null;
    return matches?approval:null;
  }
  priorityStopRequest(text) {
    return parseStopRequest(text);
  }
  stopTargets(request){
    const running=this.store.allTasks().filter(task=>active.has(task.status)&&task.role!=='director'&&task.role!=='direct');
    if(!request.target||request.all)return running;
    const target=request.target.toLocaleLowerCase();
    return running.filter(task=>{const title=this.sessionTitleForTask(task).toLocaleLowerCase(),prompt=String(task.prompt||'').toLocaleLowerCase();return task.id.toLocaleLowerCase()===target||title===target||(target.length>=2&&(title.includes(target)||prompt.includes(target)));});
  }
  async handlePriorityControl(text,{source='web',targetIds}={}) {
    const request=this.priorityStopRequest(text);if(!request)return null;
    const running=Array.isArray(targetIds)?targetIds.map(id=>this.store.task(id)).filter(task=>task&&active.has(task.status)):this.stopTargets(request);
    if(request.all) {
      for(const task of running)await this.cancel(task.id,{source:'priority-stop'});
      const reply=running.length?'已按确认停止所有中枢执行任务。':'现在没有可以停止的执行任务。';
      this.say(reply);if(source==='qq')this.notification(reply,'stop-all:'+randomUUID());
      return {ok:true,stopped:running.length};
    }
    if(/^(?:当前任务|当前)$/u.test(request.target))request.target='';
    let matches=running;
    if(request.target&&!Array.isArray(targetIds)) {
      const target=request.target.toLocaleLowerCase();
      matches=running.filter(task=>{
        const title=this.sessionTitleForTask(task),prompt=String(task.prompt||'');
        return task.id.toLocaleLowerCase()===target || title.toLocaleLowerCase()===target ||
          (target.length>=2&&(title.toLocaleLowerCase().includes(target)||prompt.toLocaleLowerCase().includes(target)));
      });
    }
    let reply,result;
    if(matches.length===1) {
      const task=matches[0],name=this.sessionTitleForTask(task);
      try {
        result=await this.cancel(task.id,{source:'priority-stop'});
        reply=result.ok?`已经让「${name}」停下来了。`:`「${name}」现在不在执行中。`;
      } catch(error) {
        reply=`我刚才尝试停止「${name}」，但执行端没有确认取消：${String(error?.message||error).slice(0,240)}`;
        this.store.error(task.id,`优先停止失败：${String(error?.message||error)}`);
      }
    } else if(matches.length>1) {
      reply=`我找到几项正在执行的任务：\n${matches.slice(0,6).map(task=>'「'+this.sessionTitleForTask(task)+'」').join('\n')}\n告诉我其中一个名称，我就直接停掉它。`;
      result={ok:false,error:'AMBIGUOUS_STOP_TARGET',matches:matches.map(task=>task.id)};
    } else {
      reply=request.target?'没找到正在执行的「'+request.target+'」。':'现在没有可以停止的执行任务。';
      result={ok:false,error:'NO_ACTIVE_STOP_TARGET'};
    }
    this.say(reply);if(source==='qq')this.notification(reply,`priority-stop:${createHash('sha256').update(String(text)+'\0'+reply).digest('hex').slice(0,24)}`);
    return result||{ok:true,control:'stop'};
  }
  scheduleAmendmentContinuation(id) {
    void Promise.resolve(this.chains.get(id)).then(()=>{
      if(this.stopping||!this.amendments.hasPending(id))return;
      const current=this.store.task(id);
      if(this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested' LIMIT 1").get(id))return;
      if(!current||['running','waiting','cancelled'].includes(current.status))return;
      if(current.status!=='queued')this.store.update(id,{status:'queued',error:null});
      this.pumpWorkerQueue();
    }).catch(error=>this.store.event(id,'task.amendment-scheduling-failed',{error:redact(error.message)}));
  }
  amendmentPrompt(task,rows) {
    const additions=this.amendments.format(rows);
    const context=task.result||task.error;
    const original=String(task.prompt||'').slice(0,Math.max(0,18000-additions.length));
    const effects=/(?:邮件|发送|发布|评论|付款|购买)/u.test(original)?'补充不代表既有操作已撤销；对已经发送或执行的操作先核对实际状态，避免重复。':'';
    return [original,context?'上一轮结果（仅作接续参考）：'+String(context).slice(0,800):'',effects,additions].filter(Boolean).join('\n\n').slice(-20000);
  }
  suppressSupersededReports(taskId) {
    if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='return_reports'").get())return;
    for(const row of this.store.db.prepare("SELECT key,manifest FROM return_reports WHERE taskId=? AND status NOT IN ('sent','suppressed')").all(taskId)) {
      let manifest=[];try{manifest=JSON.parse(row.manifest||'[]');}catch{}
      for(const part of manifest)this.store.db.prepare("UPDATE outbox SET status='suppressed',error='用户已补充要求，旧结果暂不作为最终回报',updatedAt=? WHERE id=? AND status='pending'").run(this.store.now(),part.id);
      this.store.db.prepare("UPDATE return_reports SET status='suppressed',updatedAt=? WHERE key=?").run(this.store.now(),row.key);
    }
  }
  async message(id,text,{messageKey=null,source='user'}={}) {
    const task=this.store.task(id);if(!task)throw Error('找不到任务');
    if(this.store.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status='recovery_required' LIMIT 1").get(id))throw Error('此会话在等待人工选择时中断，请先到原 Agent 会话核对并处理，避免绕过审批。');
    if(typeof text!=='string' || !text.trim() || text.length>20000)throw Error('请输入继续内容');
    if(task.role==='worker') {
      if(this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested' LIMIT 1").get(id))throw Error('用户已要求停止此任务，不能通过补充恢复执行；请明确重新派发');
      if(task.status==='cancelled')throw Error('该任务已取消，请明确重新派发，补充不会自动重启已取消任务');
      if(task.status==='waiting')throw Error('原任务正在等待选择，请先回应原有审批；补充不会绕过审批');
      const key=messageKey||`amend:${id}:${task.runVersion}:${createHash('sha256').update(text).digest('hex')}`;
      const addition=this.amendments.append(id,text,{idempotencyKey:key});
      let steered=false;
      if(!addition.duplicate&&source!=='supervisor')this.store.say('user',text);
      if(addition.status!=='applied') {
        this.suppressSupersededReports(id);
        if(!addition.duplicate&&task.engine==='dsh'&&task.status==='running'&&this.adapters.dsh?.steer){
          try{const result=await this.adapters.dsh.steer(task,text);steered=result?.accepted===true;this.store.event(id,steered?'task.amendment-steered':'task.amendment-awaiting-continuation',{amendmentId:addition.id,revision:addition.revision});}
          catch(error){this.store.event(id,'task.amendment-steer-unconfirmed',{amendmentId:addition.id,error:redact(error.message)});}
        }
        // The current engine turn must reach its genuine terminal event first.
        this.scheduleAmendmentContinuation(id);
      }
      this.emit();return {ok:true,recorded:true,pending:addition.status!=='applied',steered,revision:addition.revision,reply:addition.status==='applied'?'这条补充已经交给原工作会话。':steered?'补充已送入当前工作会话，并保留接续记录；落实情况以执行结果为准。':'补充已记录，等待原会话安全接续；尚未确认当前回合已收到。'};
    }
    if(active.has(task.status))throw Error('任务还在运行或等待选择，请先回应选择或取消');
    if(!task.sessionId)throw Error('该任务没有可恢复会话，请重新派发');
    if(typeof text!=='string' || !text.trim() || text.length>20000)throw Error('请输入继续内容');
    if(!['director','coordinator'].includes(task.role) && this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").get().n>=this.maxConcurrent)throw Error(`同时最多运行 ${this.maxConcurrent} 个执行任务`);
    const canRecoverDshSession=task.role==='worker'&&task.engine==='dsh';
    if(canRecoverDshSession&&!this.reusableDshRoute(task.id)&&typeof this.adapters.dsh?.endpointFor==='function') {
      const endpoint=this.adapters.dsh.endpointFor(task);
      if(endpoint)this.store.event(task.id,'dsh.route',{endpoint,priority:'primary-3080',reason:'manual-continuation-route-refresh'});
    }
    const continuationContext=canRecoverDshSession?{
      prompt:String(task.prompt||'').slice(0,900),
      result:String(task.result||task.error||'').slice(0,1400),
    }:null;
    this.store.say('user',text);
    this.run(task,text,canRecoverDshSession?{allowMissingSessionFallback:true,continuationContext}:{});
    return {ok:true};
  }
  async cancel(id,{source='api'}={}) {
    const task=this.store.task(id);if(!task)throw Error('找不到任务');
    if(!active.has(task.status))return {ok:true};
    const cancelSource=['api','control-panel','priority-stop','cancel-command'].includes(source)?source:'api';
    this.cancellingTasks??=new Map();if(this.cancellingTasks.has(id))return this.cancellingTasks.get(id);
    const operation=(async()=>{
    if(!this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested' LIMIT 1").get(id))this.store.event(id,'task.stop-requested',{source:cancelSource});
    if(task.role==='worker'&&task.engine==='dsh'&&task.sessionId)this.store.meta('worker:stop:'+task.sessionId,JSON.stringify({taskId:id,at:this.store.now()}));
    this.store.db.prepare("UPDATE task_amendments SET status='cancelled',updatedAt=? WHERE taskId=? AND status IN ('pending','claimed')").run(this.store.now(),id);
    this.suppressSupersededReports(id);
    if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='artifacts' AND type='table'").get())this.store.db.prepare("UPDATE attachment_outbox SET status='suppressed',error='用户停止任务，停止未发送的成果',updatedAt=? WHERE status='pending' AND artifactId IN (SELECT id FROM artifacts WHERE task_id=?)").run(this.store.now(),id);
    let identity={};try{identity=JSON.parse(this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='session' ORDER BY id DESC LIMIT 1").get(id)?.data||'{}');}catch{}
    let stopTimer;
    try{await Promise.race([this.adapters[task.engine].cancel({...task,followRequestId:identity.requestId,followPromptMarker:identity.promptMarker}),new Promise((_,reject)=>{stopTimer=setTimeout(()=>reject(Error('执行端停止确认超时；已阻止后续接续，请核对原会话')),10000);})]);}
    catch(error){this.store.update(id,{error:'停止执行尚未确认：'+redact(error.message)});this.store.event(id,'task.stop-unconfirmed',{error:redact(error.message)});this.emit();throw error;}
    finally{clearTimeout(stopTimer);}
    try{const row=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.images' ORDER BY id DESC LIMIT 1").get(id);if(row)await this.cleanupVisualCache(JSON.parse(row.data||'{}').cleanupDirectory);}catch{}
    this.store.update(id,{status:'cancelled'});
    const repairMatch=/^t-repair-([a-f0-9]{24})-\d+$/u.exec(id);
    if(repairMatch)this.store.db.prepare("UPDATE internal_repairs SET status='blocked',detail=?,updatedAt=? WHERE id=? AND status IN ('sending','accepted','delivery-uncertain','needs-action','result-received','validation-failed')").run('用户已确认停止本轮修复，不自动重新派发。',this.store.now(),repairMatch[1]);
    this.store.db.prepare("UPDATE approvals SET status='cancelled',updatedAt=? WHERE taskId=? AND status IN ('pending','resolving')").run(this.store.now(),id);
    if(task.role!=='director')this.store.collection(id,'cancelled');
    this.store.event(id,'task.cancelled',{source:cancelSource,role:task.role,engine:task.engine});this.pumpPhoneQueue();this.emit();this.kickDirector();return {ok:true};
    })();this.cancellingTasks.set(id,operation);try{return await operation;}finally{this.cancellingTasks.delete(id);}
  }
  directMode() { return this.store.meta('directSessionMode') === 'on'; }
  repairMode() { return this.store.meta('repairWindowMode') === 'on'; }
  async enterRepairWindow() {
    if(!this.codexRepairThreadId || !this.codexQueuePath) throw Error('当前 Codex 修复窗口尚未绑定');
    this.detachDirectBridge();this.directBridge=null;
    this.store.meta('directSessionMode','off');this.store.meta('directSessionKind','');this.store.meta('repairWindowMode','on');
    return {ok:true,repair:true};
  }
  exitRepairWindow() { this.store.meta('repairWindowMode','off');return {ok:true}; }
  async repairChat(text) {
    if(!this.codexRepairThreadId || !this.codexQueuePath) throw Error('当前 Codex 修复窗口尚未绑定');
    const watcher=await this.prepareRepairWatcher(String(text));
    const watchId=watcher?this.repairReturns?.queue(watcher):null;
    try {await execFileAsync(resolveCodexExecutable({command:this.codexQueuePath}),['queue','--thread',this.codexRepairThreadId,'--message',String(text)],{windowsHide:true,timeout:15000,maxBuffer:200000});}
    catch(error){if(watchId)this.repairReturns?.cancel(watchId);throw error;}
    const reply='原话已排入当前 Codex 修复窗口；接收后会确认，最终回复会自动返回。';this.say(reply);this.notification(reply,'repair-window:'+randomUUID());
    if(watcher) void this.repairReturns?.poll().catch(error=>this.store.event(null,'repair.return-poll-error',{error:redact(error.message)}));
    return {ok:true,repair:true};
  }
  async prepareRepairWatcher(text) {
    try {
      const pattern=`${this.codexSessionRoot.replace(/[\\/]+$/u,'')}/**/*${this.codexRepairThreadId}*.jsonl`;
      const matches=globSync(pattern,{nodir:true});
      const file=matches.sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];
      if(!file)return null;
      return {file,offset:statSync(file).size,text,queuedAt:Date.now(),turnId:null,userSeen:false,seen:new Set()};
    } catch { return null; }
  }
  async ensureDirectBridge() {
    if(this.directBridge) return this.directBridge;
    const dedicated=this.store.meta('directSessionKind') === 'dedicated';
    const sessionId=dedicated ? this.store.meta('directSessionId') : null;
    const id=this.store.meta('directTaskId') || 't-direct-'+randomUUID().slice(0,8);
    const cwd=join(this.workspaceRoot,'_director');mkdirSync(cwd,{recursive:true});
    const existing=this.store.task(id);
    const task=existing || this.store.createTask({id,engine:'dsh',prompt:'直连会话',cwd,sessionId,role:'direct'});
    task.sessionId=sessionId;
    this.store.meta('directTaskId',id);if(sessionId)this.store.meta('directSessionId',sessionId);
    const bridge={task,approval:null,queue:Promise.resolve(),ready:dedicated};
    this.directBridge=bridge;
    try {
      await this.adapters.dsh.start({...task,...(dedicated?{reconnectOnly:true}:{prompt:'这是一个用户直连会话。直接回答用户原话，不要派发任务、不要调用主管工具，也不要输出中控协议。'})},event=>{
        if(event?.type==='session' && event.sessionId){bridge.task.sessionId=event.sessionId;this.store.update(bridge.task.id,{sessionId:event.sessionId,status:'running'});this.store.meta('directSessionId',event.sessionId);}
        if(bridge.ready && this.directBridge===bridge)this.handleDirectEvent(bridge,event);
      });
      bridge.ready=true;this.store.meta('directSessionKind','dedicated');
      return bridge;
    } catch(error) { this.directBridge=null; throw error; }
  }
  handleDirectEvent(bridge,event) {
    if(event?.type==='session' && event.sessionId) { bridge.task.sessionId=event.sessionId;this.store.meta('directSessionId',event.sessionId);return; }
    if(event?.type==='approval') { bridge.approval=event;this.directReply(String(event.question || ''));return; }
    if(event?.type==='completed') { bridge.approval=null;this.directReply(String(event.text || ''));return; }
    if(event?.type==='failed') this.directReply('直连会话暂时失败：'+String(event.error || '未知错误'));
  }
  directReply(text) {
    const value=String(text || '').trim();if(!value)return;
    this.store.say('assistant',value);this.store.enqueue(value,'direct-session:'+createHash('sha256').update(value).digest('hex').slice(0,24)+':'+randomUUID());void this.notify();this.emit();
  }
  async enterDirectSession() {
    const bridge=await this.ensureDirectBridge();this.store.meta('directSessionMode','on');
    return {ok:true,sessionId:bridge.task.sessionId};
  }
  async selectDirectSession({sessionId,title}) {
    if(typeof sessionId!=='string' || !/^session-[\w-]+$/u.test(sessionId)) throw Error('DSH 会话选择无效');
    if(typeof title!=='string' || !title.trim()) throw Error('DSH 会话缺少名称');
    // Close the old center-side bridge record without cancelling DSH work.
    this.detachDirectBridge();this.directBridge=null;
    const id='t-direct-'+randomUUID().slice(0,12);
    this.store.meta('directSessionKind','dedicated');
    this.store.meta('directSessionId',sessionId);
    this.store.meta('directSessionTitle',title.trim().slice(0,160));
    this.store.meta('directTaskId',id);
    this.store.meta('repairWindowMode','off');
    const bridge=await this.ensureDirectBridge();
    this.store.meta('directSessionMode','on');
    this.emit();
    return {ok:true,title:this.store.meta('directSessionTitle'),connected:bridge.task.sessionId===sessionId};
  }
  directSessionStatus() {
    const pending=this.repairReturns?this.store.db.prepare("SELECT userSeen,COUNT(*) AS count FROM repair_returns WHERE status='pending' GROUP BY userSeen").all():[];
    const queued=Number(pending.find(row=>!row.userSeen)?.count||0);
    const processing=Number(pending.find(row=>row.userSeen)?.count||0);
    return {enabled:this.directMode(),title:this.store.meta('directSessionTitle')||'',connected:!!this.directBridge?.ready,kind:this.store.meta('directSessionKind')||'',repair:{enabled:this.repairMode(),queued,processing}};
  }
  detachDirectBridge() {
    const task=this.directBridge?.task;
    const current=task?this.store.task(task.id):null;
    if(current && ['queued','running','waiting'].includes(current.status)) {
      this.store.update(current.id,{status:'detached',result:'中枢直连桥接已关闭；DSH 原生会话及其工作仍由 DSH 管理。'});
      this.store.event(current.id,'direct.bridge-detached',{sessionId:current.sessionId||null});
      this.emit();
    }
  }
  async exitDirectSession() {
    this.detachDirectBridge();this.store.meta('directSessionMode','off');this.store.meta('directTaskId','');this.store.meta('directSessionTitle','');this.directBridge=null;
    return {ok:true};
  }
  async directChat(text) {
    const bridge=await this.ensureDirectBridge();
    // A rejected reply must not poison every subsequent direct message.
    bridge.queue=bridge.queue.catch(()=>{}).then(async()=>{
      const approval=bridge.approval || {requestId:'__direct_message__'};
      await this.adapters.dsh.respond(bridge.task,approval,text);
      if(bridge.approval===approval)bridge.approval=null;
    });
    await bridge.queue;return {ok:true,direct:true};
  }
  async chat(text,{source='web',messageKey,imagePaths=[],fileAttachments=[],originalUserText:incomingOriginal,replyIds=[]}={}) {
    const originalUserText=typeof incomingOriginal==='string'&&incomingOriginal.trim()?incomingOriginal:String(text||'');
    text=String(text || '').trim();if(!text || text.length>20000)throw Error('请输入 1–20000 字符');
    const waitingBeforeMessage=this.companion?.waitingState?.();
    const chatId=this.store.say('user',text);this.companion?.observeUserMessage?.(text);this.companion?.recordInteraction(undefined,waitingBeforeMessage);this.emit();
    if(isMenuCommand(text)){const reply=quickMenu(this.store);this.say(reply);if(source==='qq')this.notification(reply,`quick-menu:${messageKey||chatId}`);return {ok:true,menu:true};}
    const requestedVoiceMode=voiceModeCommand(text);
    if(requestedVoiceMode!==null){
      const reply=typeof this.setVoiceEnabled!=='function'?'当前还没有配置本地语音。':(this.setVoiceEnabled(requestedVoiceMode),requestedVoiceMode?'已切回语音，所有文字回复都会用当前音色分段读出来。':'已切回文字回复。');
      this.say(reply);if(source==='qq')this.notification(reply,`voice-mode:${messageKey||chatId}`);return {ok:true,voiceMode:true};
    }
    if(requestsScreenPicker(originalUserText)&&this.requestScreenPicker){
      const picker=await this.requestScreenPicker({requestId:'chat:'+chatId});
      const reply=picker.status==='already_sharing'?'当前已经在共享你选定的画面，陪工作仍在继续。':picker.error?'选择请求已保留，桌面入口暂未打开：'+picker.error:'正在打开电脑端的屏幕／窗口选择器，选好后就开始共享。';
      this.say(reply);if(source==='qq')this.notification(reply,`screen-picker:${messageKey||chatId}`);
      return{ok:true,screenPicker:picker,chatId};
    }
    const confirmation=guardControlCommand({store:this.store,text,source,resolveStopTargets:request=>this.stopTargets(request)});
    if(confirmation?.pending||confirmation?.cancelled) {
      this.say(confirmation.reply);if(source==='qq')this.notification(confirmation.reply,`control-confirmation:${chatId}`);
      return {ok:true,awaitingConfirmation:!!confirmation.pending};
    }
    const confirmedControl=confirmation?.confirmed===true;
    if(confirmedControl)text=confirmation.command;
    if(confirmedControl&&/^(?:退出|关闭|停止)中枢$/u.test(text)) {
      if(typeof this.requestShutdown!=='function')throw Error('这个入口未接入后台关闭能力，中枢仍在运行。');
      const reply='已收到二次确认，我会退出中枢；原工作会话保留，结果回传将在重新启动后继续。';
      this.say(reply);if(source==='qq'){this.notification(reply,`control-shutdown:${chatId}`);await this.notify();}
      await this.requestShutdown();return {ok:true,shuttingDown:true};
    }
    // An explicitly selected DSH session is a literal message bridge: bypass
    // supervisor commands and companion shortcuts so the user's words reach
    // that conversation unchanged. Keep only the opt-out phrase local.
    if(this.directMode()) {
      if(/^(?:退出DSH直连|关闭DSH直连|退出DSH当前会话|退出\s+DSH\s+直连|退出直连)$/u.test(text)) {
        await this.exitDirectSession();const reply='已退出 DSH 直连，恢复主管中枢。';this.say(reply);if(source==='qq')this.notification(reply,'dsh-direct-mode-off:'+randomUUID());return {ok:true};
      }
      return this.directChat(text);
    }
    const control=confirmedControl?await this.handlePriorityControl(text,{source,targetIds:confirmation.targetIds}):null;if(control)return control;
    const companionReply=this.companion?.command(text);
    if(companionReply){this.say(companionReply.reply);if(source==='qq')this.notification(companionReply.reply,'companion:'+randomUUID());return {ok:true,companion:true};}
    if(/^(?:直连|进入直连|直连当前会话|修复窗口|进入修复窗口|紧急修复)$/u.test(text)) {
      const result=await this.enterRepairWindow();const reply='已直连当前 Codex 修复窗口；输入“退出直连”即可返回主管中枢。';this.say(reply);if(source==='qq')this.notification(reply,'repair-window-on:'+randomUUID());return result;
    }
    if(/^(?:退出直连|关闭直连|结束直连|关闭修复窗口|退出修复窗口|结束修复)$/u.test(text)) {
      const wasRepair=this.repairMode(),wasDirect=this.directMode();
      if(wasRepair)this.exitRepairWindow();
      if(wasDirect)await this.exitDirectSession();
      const reply=wasRepair?'已退出 Codex 修复窗口，恢复主管中枢。':wasDirect?'已退出 DSH 直连，恢复主管中枢。':'已退出直连，当前由主管中枢接收消息。';
      this.say(reply);if(source==='qq')this.notification(reply,'direct-mode-off:'+randomUUID());return {ok:true};
    }
    if(/^(?:DSH直连|进入DSH直连|直连DSH当前会话)$/u.test(text)) {
      const result=await this.enterDirectSession();const reply='已进入 DSH 直连；输入“退出 DSH 直连”即可返回主管中枢。';this.say(reply);if(source==='qq')this.notification(reply,'dsh-direct-mode:'+randomUUID());return result;
    }
    if(/^(?:退出DSH直连|关闭DSH直连|退出DSH当前会话|退出\s+DSH\s+直连)$/u.test(text)) {
      const result=await this.exitDirectSession();const reply='已退出 DSH 直连，恢复主管中枢。';this.say(reply);if(source==='qq')this.notification(reply,'dsh-direct-mode-off:'+randomUUID());return result;
    }
    if(this.repairMode()) return this.repairChat(text);
    if(this.directMode()) return this.directChat(text);
    // Explicitly addressed repair-window messages go directly to that thread;
    // a generic worker must not be asked to forward them through a browser.
    if(/codex/iu.test(text) && /(?:直连.{0,12}会话|当前.{0,8}(?:修复窗口|这个会话)|(?:平时|一般|通常).{0,15}直连|修复窗口)/u.test(text)
      && /(?:发给|转给|交给|跟.{0,8}说|让.{0,12}(?:完成|实现|修复|处理)|帮.{0,8}(?:完成|实现|修复))/u.test(text)) return this.repairChat(originalUserText);
    if(text==='接管' || text==='返回原助手' || text==='保留原入口') {
      if(!this.setQqMode)throw Error('QQ 路由切换不可用');const mode=text==='接管'?'all':'prefix';await this.setQqMode(mode);
      const reply=mode==='all'?'中枢已接管你的 QQ 私聊，现在直接说任务即可。随时发 /中枢 返回原助手 切回原入口。':'已返回原助手。新中枢继续用 /中枢 开头接收你的消息。';
      this.say(reply);if(source==='qq')this.notification(reply,'mode:'+randomUUID());return {ok:true,mode};
    }
    const choice=/^(?:选择|答复|answer)\s+(a-[\w-]+)\s+([\s\S]+)$/i.exec(text);
    if(choice)return this.answer(choice[1],choice[2]);
    const follow=/^(?:继续|continue)\s+(t-[\w-]+)\s*([\s\S]*)$/i.exec(text);
    if(follow)return this.message(follow[1],follow[2] || '请继续完成任务。');
    const stop=/^(?:取消|cancel)\s+(t-[\w-]+)$/i.exec(text);if(confirmedControl&&stop)return this.cancel(stop[1],{source:'cancel-command'});
    if(/^(?:状态|任务|status)$/.test(text)) {
      const tasks=this.store.tasks().slice(0,8);
      const names={queued:'排队中',running:'执行中',waiting:'等待选择',completed:'已完成',failed:'未完成',cancelled:'已取消',interrupted:'待接回'};
      const reply=tasks.length?tasks.map(t=>`${sessionDisplayName(t)} · ${t.engine==='codex'?'Codex':t.engine==='workbuddy'?'WorkBuddy':'DSH'} · ${names[t.status]||t.status}`).join('\n\n'):'现在没有中枢任务。';
      this.say(reply);if(source==='qq')this.notification(reply,'status:'+randomUUID());return {ok:true};
    }
    if(/^(?:帮助|help)$/.test(text)) {
      const reply=this.primaryMode
         ?'直接说你要做的事，助手会判断并派给独立任务；也可以直接闲聊。\ncodex 任务内容：交给 Codex。\n状态：查看任务进度。\n需要选择时按提示回复；中控任务卡可打开原会话、补充要求或取消任务。\n直连：进入当前 Codex 修复窗口，原话直送；退出直连：返回主管中枢。\nDSH直连：进入 DSH 当前会话；退出 DSH 直连：返回主管中枢。\n找 关键词：搜索文件库。\n读 文件或文档：把已归档文档读入中控对话。\n发给我 文件ID：发送已归档的成果文件。'
         :'直接说你要做的事，助手会判断并派发。\ncodex 任务内容：交给 Codex。\n状态：查看任务进度。\n需要选择时按提示回复；中控任务卡可打开原会话、补充要求或取消任务。\n直连：进入当前 Codex 修复窗口，原话直送；退出直连：返回主管中枢。\nDSH直连：进入 DSH 当前会话；退出 DSH 直连：返回主管中枢。\n找 关键词：搜索文件库。\n读 文件或文档：把已归档文档读入中控对话。\n发给我 文件ID：把归档文件发到 QQ。\n接管：中枢接管主人私聊，后续直接说话。\n返回原助手：切回原入口，中枢用 /中枢 开头。';
      this.say(reply);if(source==='qq')this.notification(reply,'help:'+randomUUID());return {ok:true};
    }
    const importFiles=/^(?:收录|导入资料)\s+(.+)$/i.exec(text);
    if(importFiles && this.importLibrary){
      const result=await this.importLibrary({directory:importFiles[1].trim().replace(/^"|"$/g,''),recursive:true});
      const reply=`收进资料库了，共 ${result.artifacts.length} 份。原文件还在原处。${result.warnings.length?`有 ${result.warnings.length} 项跳过或未能读取，可以在文件页查看。`:''}需要时说“归类”，我会交给 DSH。`;
      this.say(reply);if(source==='qq')this.notification(reply,'library-import:'+result.id);return result;
    }
    if(/^(?:归类|资料分类)$/.test(text) && this.classifyLibrary){
      const result=await this.classifyLibrary({});const reply=result.jobs.length?`已经交给 DSH 排队分类了，共 ${result.jobs.length} 批。核对并写入资料库后，我会再告诉你。`:'资料库里暂时没有等待分类的文件。';
      this.say(reply);if(source==='qq')this.notification(reply,'library-classify:'+randomUUID());return result;
    }
    const search=/^(?:找|搜索|search)\s+(.+)$/i.exec(text);
    if(search) {
      const records=await (this.searchKnowledge?this.searchKnowledge(search[1]):this.archive.search(search[1]));const reply=records.slice(0,6).map(r=>(r.catalog?.title || r.name)+' · '+(r.category || '资料')+' · 文件ID '+r.id+'\nhttp://127.0.0.1:3188/api/artifacts/'+encodeURIComponent(r.id)+'/file').join('\n\n') || '文件库里还没有匹配的文件。';
      this.say(reply);if(source==='qq')this.notification(reply,'search:'+randomUUID());return {artifacts:records};
    }
    const readRequest=/^(?:读|阅读|读取|查看文档|打开文档)\s+(.+)$/i.exec(text);
    if(readRequest && this.readArtifact && readRequest[1].trim().length >= 2) {
      const target=readRequest[1].trim().replace(/^文件\s*/i,'');
      const selection=parseRequestedPdfPages(target),lookupTarget=selection.query||target;
      let record=null;
      if(/^[a-f0-9-]{20,80}$/i.test(lookupTarget)) record=await this.readArtifact(lookupTarget);
      else {
        const matches=await (this.searchKnowledge?this.searchKnowledge(lookupTarget):this.archive.search(lookupTarget));
        if(matches.length===1)record=await this.readArtifact(matches[0].id);
        else {
          const reply=matches.length?`找到 ${matches.length} 份相关资料，请说“读 文件ID”选择其中一份。`:'文件库里没有找到这份资料，请先导入目录或用“找 关键词”检索。';
          this.say(reply);if(source==='qq')this.notification(reply,'read-search:'+randomUUID());return {artifacts:matches};
        }
      }
      if(!record) {
        const reply='文件库里没有找到这份资料，请先导入目录或用“找 关键词”检索。';
        this.say(reply);if(source==='qq')this.notification(reply,'read-missing:'+randomUUID());return {ok:false,error:'资料不存在'};
      }
      const visualPdf=record.mimeType==='application/pdf'&&(!String(record.text||'').trim()||selection.pages);
      if((record.isImage||visualPdf) && this.dispatchVisualArtifact) {
        const request=lookupTarget===record.name || /^[a-f0-9-]{20,80}$/i.test(lookupTarget)?'':lookupTarget;
        let visualTask;
        try{visualTask=await this.dispatchVisualArtifact({id:record.id,name:record.name,request,pages:selection.pages});}
        catch(error){const reply=`我暂时没能把《${record.name}》交给视觉会话：${String(error?.message||'视觉读取失败').slice(0,300)}`;this.say(reply);if(source==='qq')this.notification(reply,`visual-read-error:${record.id}:${randomUUID()}`);return {ok:false,error:String(error?.message||'视觉读取失败')};}
        const reply=`我把《${record.name}》交给视觉会话看了，等它看完就把内容接着告诉你。`;
        this.say(reply);
        if(source==='qq')this.notification(reply,`visual-read:${record.id}:${visualTask.id}`);
        return {ok:true,artifact:record,task:visualTask};
      }
      const content=String(record.text || '').trim();
      const body=content?content.slice(0,8000)+(content.length>8000?'\n\n（正文较长，已截取前 8000 个字符；原文件仍可从文件库打开。）':''):
        record.isImage?'这是图片文件。中控已经确认文件并保留了原图，可以从文件库打开或说“发图片 文件ID”发送。':'这份文件已经归档，但暂时没有可提取的正文。可以直接打开原文件查看。';
      const reply=`我已经读到《${record.name}》。\n${body}`;
      this.say(reply);
      if(source==='qq')this.notification(`我已经读到《${record.name}》，正文已放到中控左侧对话里。`, `read:${record.id}`);
      return {ok:true,artifact:record,text:content};
    }
    const share=/^(?:发给我|发送|发文件|发图片)\s+(?:文件\s+)?([a-f0-9-]{20,80})$/i.exec(text);
    if(share && this.sendArtifact) {
      const result=await this.sendArtifact(share[1],{image:/发图片/.test(text)});
      const reply=result.image?'图片已经发到 QQ 了。':'文件已经发到 QQ 了。';
      this.say(reply);if(source==='qq')this.notification(reply,'artifact-share:'+share[1]+':'+randomUUID());
      return {ok:true,artifact:result};
    }
    this.preferences?.observe({chatId,text:originalUserText,replyIds});
    const socialReply=await this.social?.reply(text);
    if(socialReply){this.say(socialReply.reply);if(source==='qq')this.notification(socialReply.reply,`social-reply:${chatId}`);return socialReply;}
    const replyContext=source==='qq'?qqReplyContext(this.store,{text:originalUserText,replyIds}):{text:''};
    const quotedApproval=replyContext.approvalId?this.store.getApproval(replyContext.approvalId):null;
    if(quotedApproval?.status==='pending'){const chosen=approvalOptionAnswer(originalUserText,quotedApproval.options);if(chosen)return this.answer(quotedApproval.id,chosen);}
    const matchingApproval=!replyIds.length?this.matchingPendingDirectorApproval(text):null;
    if(matchingApproval)return this.answer(matchingApproval.id,approvalOptionAnswer(text,matchingApproval.options));
    const explicit=parseExplicitEngineCommand(text);
    imagePaths=source==='qq'&&Array.isArray(imagePaths)?imagePaths.slice(0,4).filter(value=>typeof value==='string'&&isAbsolute(value)):[];
    const prompt=text;
    const availableFiles=fileAttachments.length?fileAttachments:(replyContext.files||[]);
    const validFileAttachments=source==='qq'&&Array.isArray(availableFiles)?availableFiles.filter(item=>item&&typeof item.path==='string'&&isAbsolute(item.path)).slice(0,4):[];
    const fileContext=validFileAttachments.length?await prepareQqFileContext(validFileAttachments):{text:'',imagePaths:[]};
    imagePaths=[...imagePaths,...(fileContext.imagePaths||[])].slice(0,4);
    const engine=imagePaths.length?'dsh':this.directorEngine();
    let screenDelivery='';
    if(requestsSharedScreen(originalUserText)&&this.shareScreen){
      try{const result=await this.shareScreen({requestId:'chat:'+chatId});screenDelivery='用户要求发送共享画面，已通过中枢请求当前所选窗口的新截图，不需要再派工作。真实状态：'+JSON.stringify(result)+'。waiting_frame是在等共享客户端截取，queued/pending只是排队，sent=true才可说已发送；不能说没有发图通道。';}
      catch(error){screenDelivery='本次共享画面发送未能开始：'+redact(String(error.message))+ '。请按具体状态说明，不笼统否认系统能力。';}
    }
    const deliveryContext=fileDeliveryContext(this.store,text);
    const fileRequest=/(?:发(?:送)?给我|给我发|发我|转发给我|拿给我|(?:截图|图片|文件).{0,6}(?:发来|发过来|给我看看))/u.test(text)?'定位目标文件并复制到 outputs，回报真实路径，由中枢统一发送；保留源文件。若本轮已经自行发送，只回报文件路径和message_id供核验，不能再发送一份。无法确认目标先核对。':null;
    const visualPaths=engine==='dsh'?imagePaths:[];
    const filePrompt=validFileAttachments.length?`\n[QQ 文件附件已保存到本机]\n${validFileAttachments.map((item,index)=>`${index+1}. 原文件名：${String(item.originalName||'未命名文件').slice(0,180)}；本地绝对路径：${item.path}；大小：${Number(item.size)||0} 字节；MIME：${String(item.mimeType||'application/octet-stream')}`).join('\n')}\n请直接使用这些真实路径读取附件；如果无法读取，请明确说明失败原因，不要把文件名当成本地路径，也不要猜测文件内容。`:'';
    const imageCapability=visualPaths.length&&explicit&&explicit.engine!=='dsh'?`\n中枢能力说明：${explicit.engine} 工作会话当前只能接收文字，尚不能直接接收原图。先结合附图和用户原话自然说明这项限制；需要原图直接输入的工作在澄清前不要派单，也不要声称图片已交给该引擎。`:'';
    const visualPrompt=`${prompt}${filePrompt}${visualPaths.length?`\n[附图 ${visualPaths.length} 张，请查看图像内容并结合用户文字回答。]${imageCapability}`:''}`;
    // Plain conversational follow-ups enter the running native turn directly.
    // Approvals and attachments keep their dedicated handling paths.
    const speaking=this.store.db.prepare("SELECT * FROM tasks WHERE role='director' AND engine='dsh' AND status='running' AND prompt NOT LIKE '[内部工作回报]%' ORDER BY createdAt DESC LIMIT 1").get();
    if(speaking?.sessionId&&engine==='dsh'&&!screenDelivery&&!fileRequest&&!replyContext.text&&!replyIds.length&&!visualPaths.length&&!validFileAttachments.length&&this.adapters.dsh.steer){
      this.store.event(speaking.id,'director.interjection-requested',{chatId,source,text:prompt});
      try{
        const result=await this.adapters.dsh.steer(speaking,prompt);
        if(result?.accepted){
          this.store.event(speaking.id,'director.interjection-accepted',{chatId,source,messageKey:messageKey||null,text:prompt});
          const prior=this.workHandoff(speaking)||buildWorkHandoff({store:this.store,userText:speaking.prompt});
          const additions=this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.interjection-accepted'").all(speaking.id).map(row=>JSON.parse(row.data)).sort((a,b)=>Number(a.chatId)-Number(b.chatId));
          const interjectionBaseRequest=prior.interjectionBaseRequest||prior.userRequest||speaking.prompt,interjectionBaseGoal=prior.interjectionBaseGoal||prior.goal||speaking.prompt;
          this.store.event(speaking.id,'task.work-handoff',{...prior,interjectionBaseRequest,interjectionBaseGoal,userRequest:[interjectionBaseRequest,...additions.map(x=>x.text)].join('\n'),goal:[interjectionBaseGoal,...additions.map(x=>x.text)].join('\n')});
          this.store.meta('director:response-start:'+speaking.id,this.store.now());
          return {ok:true,interjected:true,task:this.store.task(speaking.id),chatId};
        }
      }catch(error){
        // Delivery may have succeeded. Do not enqueue a duplicate automatically.
        if(error.receipt==='not-received'){this.store.event(speaking.id,'director.interjection-not-received',{chatId,error:String(error.message)});}else{
        this.store.event(speaking.id,'director.interjection-uncertain',{chatId,error:String(error.message),requestId:error.requestId||null});
        const reply='这句插话的接收状态暂时没确认，原话已经保留；我没有重复提交。';
        this.say(reply);if(source==='qq')this.notification(reply,`interjection-uncertain:${chatId}`);
        return {ok:true,interjected:false,uncertain:true,chatId};
        }
      }
    }
    {
      const waiting=this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status='queued'").get().n;
      if(waiting>=this.directorQueueLimit) {
        const reply=`主管会话现在排得比较满，等待上限是 ${this.directorQueueLimit} 条。这条消息没有排进去；等队列空一些后请再发我。`;
        this.say(reply);
        if(source==='qq')this.notification(reply,`director-queue-full:${messageKey || randomUUID()}`);
        return {ok:false,queued:false,error:'DIRECTOR_QUEUE_FULL',limit:this.directorQueueLimit};
      }
    }
    const quotedFallback=replyIds.length&&!replyContext.text?text.match(/\[引用消息[^\]]*\][\s\S]*/u)?.[0]?.slice(0,2200):'';
    const requestContext=[replyContext.text,quotedFallback,screenDelivery,fileContext.text,deliveryContext].filter(Boolean).join('\n\n').slice(0,8000);
    const task=await this.create({engine,prompt:visualPrompt,messageKey,role:'director',imagePaths:visualPaths,originalUserText,requestContext});
    if(validFileAttachments.length)this.store.event(task.id,'task.file-attachments',{attachments:validFileAttachments.map(item=>({path:item.path,originalName:item.originalName,size:item.size,mimeType:item.mimeType,extension:item.extension}))});
    this.store.event(task.id,'task.work-handoff',{...buildWorkHandoff({store:this.store,userText:prompt,goal:prompt}),executionEngine:this.workerEngine()});
    this.store.event(task.id,'chat.request',{chatId,source,...(messageKey?{messageKey}:{}),...(explicit?{requestedEngine:explicit.engine}:{})});
    if(fileRequest) {
      const handoff=this.workHandoff(task) || buildWorkHandoff({store:this.store,userText:prompt,goal:prompt});
      this.store.event(task.id,'task.work-handoff',{...handoff,fileDelivery:true,fileRequest});
      this.store.event(task.id,'file-delivery.requested',{source:'chat',messageKey:messageKey||chatId});
    }
    return {ok:true,task,chatId};
  }
}
