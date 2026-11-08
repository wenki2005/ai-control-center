import { resolveDispatchEngine } from '../routing/engine-policy.mjs';
import { buildWorkHandoff } from '../hub/work-handoff.mjs';
import { amendmentIdempotencyKey } from '../hub/task-amendments.mjs';

const isExplicitTest=title=>/(测试|验收|回归|联调|自动测试|连接测试|\btest\b|runtime\s*check)/iu.test(String(title||''));
const isLegacyDispatchAutomation=title=>/^中枢派发 ·/u.test(String(title||''));
const isConfirmedCenterAutoTest=title=>isLegacyDispatchAutomation(title)||/(?:中枢|中控|自动化)?自动测试/iu.test(String(title||''));
const isTestWorkspace=cwd=>/(?:^|[\\/])(?:test|tests|testing|qa|scratch|tmp|temp|runtime)(?:[\\/]|$)/iu.test(String(cwd||''));
const isPersonalQqProject=cwd=>/(?:^|[\\/])(?:qq助手|mornye(?:[-_ ]?qq)?)(?:[\\/]|$)|qq.{0,4}mornye/iu.test(String(cwd||''));
function cleanupProtection(session,{archivedIds,taskRows=[],fixedSessionIds,pendingApprovalTaskIds}) {
  const reasons=[];
  const associated=taskRows.filter(task=>task.sessionId===session.sessionId);
  const legacy=isLegacyDispatchAutomation(session.title);
  if(fixedSessionIds.has(session.sessionId)||associated.some(task=>task.role==='direct'||task.role==='reporter'||task.fixed))reasons.push('当前固定、报告或直连会话，默认保留');
  if(associated.some(task=>!['completed','failed','cancelled'].includes(task.status)))reasons.push('关联中枢任务尚未结束，默认保留');
  if(associated.some(task=>pendingApprovalTaskIds.has(task.id)))reasons.push('关联任务存在待处理确认，默认保留');
  if(associated.some(task=>task.role==='worker'&&!legacy&&!isExplicitTest(task.prompt)))reasons.push('关联工作任务不是自动测试，默认保留');
  if(session.running===true)reasons.push('正在运行');
  else if(session.runningKnown!==true)reasons.push('无法确认运行状态');
  if(isPersonalQqProject(session.cwd)&&!legacy)reasons.push('个人 QQ 项目，默认保留');
  if(archivedIds.has(session.sessionId))reasons.push('已由中枢归档');
  if(!isConfirmedCenterAutoTest(session.title))reasons.push('未确认为中枢自动测试');
  if(!legacy&&!isTestWorkspace(session.cwd))reasons.push('不在测试工作目录');
  return reasons;
}

// The HTTP adapter translates requests only. Hub remains the single owner of
// task creation, engine policy, approvals and native session identity.
export function createTaskRoutes({store,hub,body,json,sessionLink,sessionUrlFor,nativeTasks}) {
  const safeText=(value,max=1200)=>String(value || '').slice(0,max);
  function cleanupState() {
    const taskRows=store.db.prepare("SELECT t.id,t.sessionId,t.role,t.status,t.prompt,t.cwd,EXISTS(SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker') AS fixed FROM tasks t WHERE t.sessionId IS NOT NULL").all();
    const fixedSessionIds=new Set(['directorSessionId','coordinatorSessionId','directSessionId','reportDirectorSessionId'].map(key=>store.meta(key)).filter(Boolean));
    for(const engine of ['dsh','codex','workbuddy']){try{const remembered=JSON.parse(store.meta(`worker:fixed:${engine}`)||'null');if(remembered?.sessionId)fixedSessionIds.add(remembered.sessionId);}catch{}}
    for(const row of store.db.prepare("SELECT value FROM metadata WHERE lower(key) LIKE '%session%'").all()){if(/^session-[\w-]+$/u.test(row.value||''))fixedSessionIds.add(row.value);}
    // Specialist bindings live in their own table, not the metadata keys.
    // Archiving one silently blocks all later catalog/maintenance work in DSH.
    if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='specialist_agents'").get()) {
      for(const row of store.db.prepare('SELECT sessionId FROM specialist_agents WHERE sessionId IS NOT NULL').all())fixedSessionIds.add(row.sessionId);
    }
    const pendingApprovalTaskIds=new Set(store.db.prepare("SELECT DISTINCT taskId FROM approvals WHERE status IN ('pending','resolving')").all().map(row=>row.taskId));
    const archivedIds=new Set(store.db.prepare("SELECT sessionId FROM dsh_archived_sessions").all().map(row=>row.sessionId));
    return {taskRows,fixedSessionIds,pendingApprovalTaskIds,archivedIds};
  }
  function linkedDispatch(caller) {
    const row=store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 1").get(caller.id);
    try {const id=JSON.parse(row?.data||'{}').workerId;return id?store.task(id):null;} catch {return null;}
  }
  function publicEvent(row) {
    let data={};try{data=JSON.parse(row.data || '{}');}catch{data={};}
    let safeData;
    switch(row.type) {
      case 'task.created': case 'task.started': case 'session':
        safeData={};break;
      case 'message':
        safeData={text:safeText(data.text)};break;
      case 'completed':
        safeData={text:'任务已完成。'};break;
      case 'approval': case 'approval.created':
        safeData={question:safeText(data.question,1000),options:Array.isArray(data.options)?data.options.slice(0,12).map(option=>safeText(typeof option==='string'?option:option?.label || option?.value,300)):[]};break;
      case 'narrator.completed': case 'narrator.fallback':
        safeData={text:safeText(data.text)};break;
      case 'failed':
        safeData={error:'任务执行失败，请查看任务状态。'};break;
      case 'task.receipt':
        safeData={status:safeText(data.status,100)};break;
      case 'task.milestone':
        safeData={summary:safeText(data.summary,600)};break;
      case 'task.dispatch-hint':
        safeData={text:safeText(data.text,600),hint:true};break;
      default:return null;
    }
    return {type:row.type,createdAt:row.createdAt,data:safeData};
  }
  function publicEvents(rows) {
    const visible=[];let previousStream=null;
    for(const row of rows) {
      const event=publicEvent(row);
      if(!event)continue;
      let identity=null;
      if(row.type==='message')try{const data=JSON.parse(row.data),s=data.stream;if(s?.kind==='snapshot'&&s.requestId&&s.sessionId&&Number.isSafeInteger(s.runVersion)&&!data.progress&&!data.usage)identity=JSON.stringify([s.sessionId,s.requestId,s.runVersion]);}catch{}
      if(identity&&identity===previousStream&&visible.at(-1)?.type==='message')visible[visible.length-1]=event;
      else visible.push(event);
      previousStream=identity;
    }
    return visible;
  }
  return async function handleTaskRoute(req,res,url) {
    const path=url.pathname;
    if(path==='/api/dsh/sessions' && req.method==='GET') {
      if(!nativeTasks)return json(res,503,{error:'DSH 会话列表暂不可用'}),true;
      const query=String(url.searchParams.get('q')||'').trim().toLocaleLowerCase().slice(0,100);
      const archived=new Set(store.db.prepare("SELECT sessionId FROM dsh_archived_sessions").all().map(row=>row.sessionId));
      const sessions=(await nativeTasks.listSessions()).filter(item=>!archived.has(item.sessionId));
      const filtered=query?sessions.filter(item=>item.title.toLocaleLowerCase().includes(query)||item.cwd.toLocaleLowerCase().includes(query)):sessions;
      filtered.sort((a,b)=>Number(b.running)-Number(a.running)||(b.updatedAt||0)-(a.updatedAt||0));
      return json(res,200,{sessions:filtered.slice(0,500).map(({sessionId,title,cwd,running,updatedAt,turns})=>({sessionId,title,project:cwd.replace(/[\\/]+$/u,'').split(/[\\/]/u).at(-1)||'项目',running,updatedAt,turns}))}),true;
    }
    if(path==='/api/dsh/sessions/cleanup' && req.method==='GET') {
      if(!nativeTasks)return json(res,503,{error:'DSH 会话列表暂不可用'}),true;
      const sessions=await nativeTasks.listSessions();
      const state=cleanupState();
      const rows=sessions.filter(session=>isExplicitTest(session.title)||isLegacyDispatchAutomation(session.title)).map(session=>{
        const reasons=cleanupProtection(session,state);
        return {sessionId:session.sessionId,title:session.title,project:String(session.cwd||'').replace(/[\\/]+$/u,'').split(/[\\/]/u).at(-1)||'项目',updatedAt:session.updatedAt,turns:session.turns,protected:reasons.length>0,reason:reasons.join('、')};
      });
      return json(res,200,{sessions:rows,eligible:rows.filter(row=>!row.protected).length,protected:rows.length-rows.filter(row=>!row.protected).length}),true;
    }
    if(path==='/api/dsh/sessions/cleanup' && req.method==='POST') {
      if(!nativeTasks?.archiveSession)return json(res,503,{error:'当前 DSH 未提供可恢复的会话归档能力'}),true;
      const {sessionIds}=await body(req);
      if(!Array.isArray(sessionIds)||sessionIds.length<1||sessionIds.length>50||sessionIds.some(id=>typeof id!=='string'))return json(res,400,{error:'请选择 1 到 50 个测试会话'}),true;
      const unique=[...new Set(sessionIds)];
      const sessions=await nativeTasks.listSessions();
      const state=cleanupState();
      const selected=unique.map(id=>sessions.find(session=>session.sessionId===id));
      if(selected.some(session=>!session||!(isExplicitTest(session.title)||isLegacyDispatchAutomation(session.title))||cleanupProtection(session,state).length))return json(res,409,{error:'有会话已不存在、未确认为中枢自动测试或旧中枢派发会话、运行状态未知或正在运行、属于固定会话或关联任务尚未结束；请刷新清单后重试'}),true;
      const archived=[];
      for(const session of selected){await nativeTasks.archiveSession(session.sessionId);archived.push({title:session.title,project:String(session.cwd||'').replace(/[\\/]+$/u,'').split(/[\\/]/u).at(-1)||'项目'});}
      return json(res,200,{archived}),true;
    }
    if(path==='/api/direct-session' && req.method==='GET')return json(res,200,hub.directSessionStatus()),true;
    if(path==='/api/direct-session' && req.method==='POST') {
      if(!nativeTasks)return json(res,503,{error:'DSH 会话列表暂不可用'}),true;
      const {sessionId}=await body(req);
      if(typeof sessionId!=='string'||!/^session-[\w-]+$/u.test(sessionId))return json(res,400,{error:'请选择一个 DSH 会话'}),true;
      const session=(await nativeTasks.listSessions()).find(item=>item.sessionId===sessionId);
      if(!session)return json(res,404,{error:'这个 DSH 会话已不存在或当前不可用，请刷新列表'}),true;
      return json(res,200,await hub.selectDirectSession({sessionId:session.sessionId,title:session.title})),true;
    }
    if(path==='/api/direct-session/exit' && req.method==='POST')return json(res,200,await hub.exitDirectSession()),true;
    if(path==='/api/director/authorize' && req.method==='POST') {
      const {requestId,sessionId,targetTaskId}=await body(req);
      if(typeof requestId!=='string'||!requestId||typeof sessionId!=='string'||!sessionId)return json(res,400,{error:'主管请求身份无效'}),true;
      // This is an internal tool contract, not a UI read model. Bind the
      // caller to the native engine session recorded on its live task.
      const caller=store.task(requestId);
      if(!caller || !['director','coordinator'].includes(caller.role) || caller.engine!=='dsh' || caller.status!=='running' || caller.sessionId!==sessionId)
        return json(res,403,{error:'本轮主管请求已结束或会话不匹配，请不要重复派单。'}),true;
      const task={id:caller.id,role:caller.role,engine:caller.engine,status:caller.status,prompt:caller.prompt};
      if(targetTaskId!==undefined) {
        if(typeof targetTaskId!=='string'||!targetTaskId)return json(res,400,{error:'目标任务无效'}),true;
        const target=store.task(targetTaskId);
        if(!target || target.role!=='worker')return json(res,404,{error:'找不到这个 worker 任务'}),true;
        task.target={id:target.id,role:target.role,status:target.status,engine:target.engine};
      }
      return json(res,200,{task}),true;
    }
    if(path==='/api/director/amend-task' && req.method==='POST') {
      const {sessionId,targetTaskId,text}=await body(req);
      if(typeof sessionId!=='string'||typeof targetTaskId!=='string')return json(res,400,{error:'原会话或任务引用无效'}),true;
      const caller=store.db.prepare("SELECT * FROM tasks WHERE engine='dsh' AND role='director' AND sessionId=? AND status='running' ORDER BY createdAt DESC LIMIT 1").get(sessionId);
      if(!caller)return json(res,403,{error:'当前主管请求已结束，请勿从旧会话重复操作'}),true;
      const target=store.task(targetTaskId);if(!target||target.role!=='worker')return json(res,404,{error:'找不到原工作任务'}),true;
      const result=await hub.message(target.id,text,{messageKey:`native-amend:${amendmentIdempotencyKey(caller.id+':'+target.id,String(text))}`,source:'supervisor'});
      store.event(caller.id,'director.amended',{workerId:target.id});
      json(res,200,result);return true;
    }
    if(path==='/api/director/native-context' && req.method==='POST') {
      const {sessionId}=await body(req);
      if(typeof sessionId!=='string'||!/^session-[\w-]+$/u.test(sessionId))return json(res,400,{error:'主管会话身份无效'}),true;
      const caller=store.db.prepare("SELECT * FROM tasks WHERE engine='dsh' AND role IN ('director','coordinator') AND sessionId=? ORDER BY createdAt DESC LIMIT 1").get(sessionId);
      if(!caller)return json(res,404,{error:'ordinary-native-session'}),true;
      if(caller.status!=='running')return json(res,403,{error:'主管会话已结束，请不要从旧会话继续操作。'}),true;
      return json(res,200,{supervisor:true,role:caller.role});
    }
    if(path==='/api/director/native-tasks' && req.method==='POST') {
      const {sessionId}=await body(req);
      if(typeof sessionId!=='string'||!/^session-[\w-]+$/u.test(sessionId))return json(res,400,{error:'主管会话身份无效'}),true;
      const caller=store.db.prepare("SELECT * FROM tasks WHERE engine='dsh' AND role IN ('director','coordinator') AND sessionId=? ORDER BY createdAt DESC LIMIT 1").get(sessionId);
      if(!caller)return json(res,404,{error:'这不是中枢主管会话'}),true;
      if(caller.status!=='running')return json(res,403,{error:'主管会话已结束，无法读取本轮派单。'}),true;
      const workerIds=store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC").all(caller.id);
      const seen=new Set(),tasks=[];
      for(const row of workerIds) {
        let workerId;try{workerId=JSON.parse(row.data||'{}').workerId;}catch{continue;}
        if(typeof workerId!=='string'||seen.has(workerId))continue;seen.add(workerId);
        const worker=store.task(workerId);if(!worker)continue;
        tasks.push({id:worker.id,engine:worker.engine,status:worker.status,sessionTitle:hub.sessionTitleForTask(worker),updatedAt:worker.updatedAt});
      }
      return json(res,200,{tasks}),true;
    }
    if(path==='/api/director/native-dispatch' && req.method==='POST') {
      const {sessionId,targetSessionId,task,dispatchKey}=await body(req);
      if(typeof sessionId!=='string'||!/^session-[\w-]+$/u.test(sessionId)||typeof targetSessionId!=='string'||!/^session-[\w-]+$/u.test(targetSessionId)||typeof task!=='string'||!task.trim()||task.length>20000||typeof dispatchKey!=='string'||!/^[a-f0-9]{24}$/u.test(dispatchKey))return json(res,400,{error:'主管派单请求无效'}),true;
      const caller=store.db.prepare("SELECT * FROM tasks WHERE engine='dsh' AND role IN ('director','coordinator') AND sessionId=? ORDER BY createdAt DESC LIMIT 1").get(sessionId);
      if(!caller)return json(res,404,{error:'这不是中枢主管会话'}),true;
      if(caller.status!=='running')return json(res,403,{error:'主管请求已结束，不能继续派单。'}),true;
      if(caller.role==='director' && String(caller.prompt||'').startsWith('[前台回应]'))return json(res,403,{error:'前台回应不能创建执行任务，请用主管派单工具处理新的明确指令。'}),true;
      const already=linkedDispatch(caller);
      if(already)return json(res,200,{accepted:true,task:{id:already.id,engine:already.engine,sessionTitle:hub.sessionTitleForTask(already),role:already.role}}),true;
      const engine=resolveDispatchEngine({parentPrompt:hub.workHandoff(caller)?.userRequest||caller.prompt,proposedEngine:'dsh',selectedEngine:hub.workHandoff(caller)?.executionEngine||hub.workerEngine()});
      let sessionHint='',target=null;
      if(engine==='dsh') {
      if(!nativeTasks)return json(res,503,{error:'DSH 会话列表暂不可用'}),true;
      target=(await nativeTasks.listSessions()).find(item=>item.sessionId===targetSessionId);
      if(!target?.cwd)return json(res,404,{error:'目标 DSH 会话不存在或缺少可信工作目录'}),true;
      if(target.running===true)return json(res,409,{error:'目标 DSH 会话正在执行其他工作，请选择空闲会话。'}),true;
        sessionHint=`一级主管建议优先检查此 DSH 会话：${target.title}（${target.sessionId}），但请核对相关性与空闲状态后再决定。`;
      }
      const key=`${caller.role}:${caller.id}:${dispatchKey}`;
      if(caller.role==='coordinator') {
        const worker=await hub.create({engine,role:'worker',prompt:task.trim(),messageKey:key,...(target?{nativeSession:target}:{})});
        return json(res,200,{accepted:true,task:{id:worker.id,engine:worker.engine,sessionTitle:hub.sessionTitleForTask(worker),role:'worker'}}),true;
      }
      const coordinator=await hub.create({engine:'dsh',role:'coordinator',prompt:`[二级协调]\n一级主管判断需要执行，建议引擎：${engine}。${sessionHint}\n整理要求：${task.trim()}\n用户原话：${caller.prompt}`,messageKey:key});
      return json(res,200,{accepted:true,task:{id:coordinator.id,engine:coordinator.engine,sessionTitle:hub.sessionTitleForTask(coordinator),role:'coordinator'}}),true;
    }
    if(path==='/api/director/delegate' && req.method==='POST') {
      const {requestId,sessionId,engine,prompt,project,dispatchKey,contextTaskId}=await body(req);
      if(contextTaskId!==undefined&&(typeof contextTaskId!=='string'||contextTaskId.length>80))return json(res,400,{error:'前次任务引用无效'}),true;
      if(typeof requestId!=='string'||typeof sessionId!=='string'||!/^session-[\w-]+$/u.test(sessionId)||!['dsh','codex','workbuddy'].includes(engine)||typeof prompt!=='string'||!prompt.trim()||prompt.length>20000||typeof dispatchKey!=='string'||!/^[a-f0-9]{24}$/u.test(dispatchKey)||(project!==undefined&&(typeof project!=='string'||project.length>100)))return json(res,400,{error:'主管派单请求无效'}),true;
      const caller=store.task(requestId);
      if(!caller||caller.role!=='director'||caller.engine!=='dsh'||caller.status!=='running'||caller.sessionId!==sessionId)return json(res,403,{error:'本轮主管请求已结束或会话不匹配，请不要重复派单。'}),true;
      const already=linkedDispatch(caller);
      if(already)return json(res,200,{accepted:true,task:{id:already.id,engine:already.engine,sessionTitle:hub.sessionTitleForTask(already),role:already.role}}),true;
      const key=`director:${caller.id}:${dispatchKey}`;
      const handoff=buildWorkHandoff({store,userText:caller.prompt,goal:prompt.trim(),...(contextTaskId?{sourceTaskId:contextTaskId}:{})});
      const effectiveEngine=hub.directorRequestedEngine(caller)||engine;
      const coordinator=await hub.create({engine:'dsh',role:'coordinator',prompt:`[二级协调]\n执行引擎：${effectiveEngine}。${project?`\n项目建议：${project}`:''}\n执行目标：${prompt.trim()}\n用户原话：${caller.prompt}`,messageKey:key,handoff:{...hub.workHandoff(caller),...handoff,preferredEngine:effectiveEngine}});
      return json(res,200,{accepted:true,task:{id:coordinator.id,engine:coordinator.engine,sessionTitle:hub.sessionTitleForTask(coordinator),role:'coordinator'}}),true;
    }
    const session=/^\/api\/tasks\/([^/]+)\/session$/.exec(path);
    if(session && req.method==='GET') {
      const task=store.task(decodeURIComponent(session[1]));
      if(!task)json(res,404,{error:'任务不存在'});
      else if(task.engine!=='dsh'||!task.sessionId)json(res,409,{error:'此任务尚无可打开的 DSH 会话'});
      else {res.writeHead(302,{location:await sessionUrlFor(task),'cache-control':'no-store'});res.end();}
      return true;
    }
    const taskEvents=/^\/api\/tasks\/([^/]+)\/events$/.exec(path);
    if(taskEvents && req.method==='GET') {
      const taskId=decodeURIComponent(taskEvents[1]),task=store.task(taskId);
      if(!task){json(res,404,{error:'任务不存在'});return true;}
      const requested=Number(url.searchParams.get('limit')||120);
      const limit=Number.isFinite(requested)?Math.min(300,Math.max(1,Math.floor(requested))):120;
      const events=publicEvents(store.db.prepare('SELECT type,data,createdAt FROM events WHERE taskId=? ORDER BY id DESC LIMIT ?').all(taskId,limit).reverse());
      json(res,200,{task:{id:task.id,engine:task.engine,role:task.role,status:task.status,sessionTitle:hub.sessionTitleForTask(task),sessionUrl:sessionLink(task),createdAt:task.createdAt,updatedAt:task.updatedAt},events});
      return true;
    }
    if(path==='/api/tasks' && req.method==='POST') {
      const {engine,prompt,model,messageKey,project}=await body(req);
      const task=await hub.create({engine,prompt,model,messageKey,project});
      json(res,201,{accepted:true,task:{id:task.id,engine:task.engine,sessionTitle:hub.sessionTitleForTask(task)}});return true;
    }
    if(path==='/api/chat' && req.method==='POST') {
      await hub.chat((await body(req)).text);json(res,200,{accepted:true});return true;
    }
    const retract=/^\/api\/chat\/(\d+)\/retract$/.exec(path);
    if(retract&&req.method==='POST') {
      await body(req);json(res,200,await hub.retractChat(retract[1]));return true;
    }
    if(path==='/api/director/rollover' && req.method==='POST') {
      json(res,202,hub.startFreshDirector((await body(req)).reason||'manual'));return true;
    }
    const approval=/^\/api\/approvals\/([^/]+)$/.exec(path);
    if(approval && req.method==='POST') {
      json(res,200,await hub.answer(approval[1],(await body(req)).answer));return true;
    }
    const action=/^\/api\/tasks\/([^/]+)\/(message|cancel)$/.exec(path);
    if(action && req.method==='POST') {
      const value=await body(req);
      if(action[2]==='cancel'&&value.confirmed!==true){json(res,409,{error:'停止任务需要单独确认',confirmationRequired:true});return true;}
      json(res,200,action[2]==='message'?await hub.message(action[1],value.text,{messageKey:value.messageKey}):await hub.cancel(action[1],{source:'control-panel'}));return true;
    }
    return false;
  };
}
