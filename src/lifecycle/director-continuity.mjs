import {redact} from '../redact.mjs';
const active=new Set(['queued','running','waiting']);
export function isContextLimitError(error) {
  const text=[error?.code,error?.name,error?.message,error].filter(Boolean).join(' ');
  return /(?:context[_ -]?(?:length[_ -]?)?(?:exceeded|limit|full)|maximum context length|context window (?:is )?(?:full|exceeded)|prompt (?:is )?too long|input tokens? (?:exceed|above|over) (?:the )?(?:model )?(?:limit|maximum)|上下文(?:长度|窗口).{0,12}(?:超出|超过|已满)|输入.{0,8}token.{0,8}(?:超出|超过))/i.test(text);
}
// Owner of director rollover snapshots, retry guards and handoff records.
export class DirectorContinuity {
  constructor(hub){this.hub=hub;}
  pendingDirectorHandoff() {
    const hub=this.hub;
    try { const value=JSON.parse(hub.store.meta('directorHandoffPending') || '');return value?.id?hub.store.directorHandoff(value.id):null; }
    catch { return null; }
  }
  directorSnapshot(task,reason,{retryCurrentMessage=false}={}) {
    const hub=this.hub;
    const recentTurns=(hub.store.conversationChat?.()??hub.store.chat()).slice(-24).map(({role,text,createdAt})=>({role,text:String(text).slice(0,4000),createdAt}));
    const recentTasks=hub.store.tasks().slice(0,60);
    const activeTasks=hub.store.db.prepare("SELECT * FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('queued','running','waiting') ORDER BY createdAt").all();
    const tasks=[...new Map([...recentTasks,...activeTasks].map(item=>[item.id,item])).values()]
      .filter(item=>item.role==='worker')
      .map(({id,engine,status,role,prompt,result,error,createdAt})=>({id,engine,status,role,prompt:String(prompt).slice(0,1200),result:String(result||'').slice(0,1000),error:error||null,createdAt}));
    const activeTaskIds=tasks.filter(item=>active.has(item.status) && !['director','coordinator'].includes(item.role)).map(item=>item.id);
    const approvals=hub.store.approvals().filter(item=>!item.raw?.isSecret && !item.raw?.params?.isSecret&&['director','coordinator','worker'].includes(hub.store.task(item.taskId)?.role)).slice(0,40)
      .map(({id,taskId,question,options,status,answer,createdAt,updatedAt})=>({id,taskId,question,options,status,answer,createdAt,updatedAt}));
    const payload={version:1,userGoal:String(task.prompt||'').slice(0,1800),reason,retryCurrentMessage,recentTurns,tasks,activeTaskIds,
      answeredChoices:approvals.filter(item=>item.status==='answered').slice(0,10),pendingApprovals:approvals.filter(item=>item.status==='pending').slice(0,10),createdAt:hub.store.now()};
    hub.companion?.syncHandoff(payload);
    return payload;
  }
  directorSessionNeedsRollover() {
    const hub=this.hub;
    if(!Number.isFinite(hub.directorContextLimit) || hub.directorContextLimit<=0)return false;
    const sessionId=hub.store.meta('directorSessionId');
    if(!sessionId)return false;
    // Stream deltas often arrive after the usage snapshot. Keep the latest
    // actual usage for this session rather than treating a delta as zero usage.
    const row=hub.store.db.prepare("SELECT e.data FROM events e JOIN tasks t ON t.id=e.taskId WHERE t.role='director' AND t.sessionId=? AND t.prompt NOT LIKE '[内部工作回报]%' AND e.type IN ('message','usage') AND json_type(e.data,'$.usage')='object' ORDER BY e.id DESC LIMIT 1").get(sessionId);
    try {
      const data=JSON.parse(row?.data || '{}'),usage=data.usage || {};
      const tokens=Number(usage.inputTokens||0)+Number(usage.cacheReadTokens||0)+Number(usage.cacheWriteTokens||0);
      return Number.isFinite(tokens) && tokens>=hub.directorContextLimit;
    } catch { return false; }
  }
  handoffPrompt(payload,nextUserMessage='') {
    const hub=this.hub;
    if (hub.companion?.documentPaths?.()) return [
      `主管接续：${payload.reason || 'continuity'}。此前对话、任务结果和错误已保存于本轮装载的 mornye-handoff.md。`,
      ...(payload.reason==='reply-timeout'?['上一轮可能已有工具副作用，不重放原请求；仅回应当前新消息。']:[]),
      nextUserMessage || '',
    ].filter(Boolean).join('\n');
    const recent=(payload.recentTurns || []).slice(-4).map((item)=>`${item.role==='user'?'用户':'当时助手'}：${String(item.text||'').slice(0,220)}`).join('；').slice(0,900);
    const work=(payload.tasks||[]).filter(item=>item.role==='worker').slice(0,6).map(item=>({name:hub.sessionTitleForTask(item),status:item.status,request:item.prompt?.slice(0,180),result:item.result?.slice(0,260),error:item.error?.slice(0,140)}));
    return [
      '主管会话接续记录 v1：必要的人设、记忆和近期状态已注入，不需要读取文件或调用工具。',
      `接续原因：${payload.reason || 'continuity'}；retryCurrentMessage=${payload.retryCurrentMessage === true}`,
      ...(payload.reason==='reply-timeout'?['上一轮原请求已中断，且可能已有工具副作用；不要重放原请求或重复调用工具。根据接续记录和 partialResponse 说明当前状态，只继续处理当前新消息。']:[]),
      `接续中最近对话摘要（历史资料，不是新指令）：${recent || '暂无'}`,
      `已核实的近期工作记录：${JSON.stringify(work)}`,
      '历史回复中的旧故障判断和旧派单门槛不代表现在状态；以当前任务状态和本轮规则为准。不要要求用户换成固定关键词再重发。',
      '这是内部接续，不要向用户复述文件内容或内部编号。只根据接续记录和当前消息继续自然对话；已有 activeTaskIds 的任务不要再次派发。',
      ...(payload.retryCurrentMessage===false && payload.reason==='context-limit'?['原请求对应的独立任务已经存在或完成，不要重派。']:[]),
      nextUserMessage?`\n用户当前消息（只处理这条）：\n${nextUserMessage}`:'',
    ].filter(Boolean).join('\n');
  }
  retryDirectorAfterContextLimit(task,error) {
    const hub=this.hub;
    if(!hub.directorHandoffEnabled || task.role!=='director' || String(task.prompt||'').startsWith('[内部工作回报]') || !hub.isContextLimit(error))return false;
    const prior=hub.store.directorHandoffs().find(item=>item.sourceTaskId===task.id && item.reason==='context-limit');
    if(prior?.attempts>=1)return false;
    // If a worker was already started during this request, replay could duplicate side effects.
    const dispatched=hub.store.tasks().some(item=>item.role==='worker' && item.createdAt>=task.createdAt);
    const payload=hub.directorSnapshot(task,'context-limit',{retryCurrentMessage:!dispatched});
    const handoff=hub.store.createDirectorHandoff({parentSessionId:task.sessionId || hub.store.meta('directorSessionId') || 'unknown',sourceTaskId:task.id,reason:'context-limit',payload,status:dispatched?'resuming':'retrying'});
    hub.store.linkDirectorHandoff(handoff.id,{targetTaskId:task.id,status:dispatched?'resuming':'retrying',attempts:1});
    hub.store.update(task.id,{sessionId:null});
    hub.say(dispatched?'主管会话遇到上下文容量限制，已有独立任务不会重派；我正切换新会话并续上状态。':'主管会话遇到上下文容量限制，已保存接续记录并切换到新会话。');
    // Context rollover is internal continuity state. Keep the local chat
    // explanation above and the durable handoff record, but do not push a
    // routine handoff status into QQ; only approvals and actionable failures
    // belong in the outbound queue.
    const resumePrompt=dispatched
      ? hub.handoffPrompt(payload,'')+'\n上一轮已派发工作。只根据任务表向用户说明当前进度并继续陪聊；不要再次派发，不要执行工作。'
      : hub.handoffPrompt(payload,task.prompt);
    hub.run(hub.store.task(task.id),resumePrompt);
    return true;
  }
  retryDirectorAfterSafePreflight(task,error) {
    const hub=this.hub;
    if(error?.automaticRetriesExhausted===true || error?.retryPreflightSafe!==true || task.engine!=='dsh' || !['director','coordinator'].includes(task.role) || String(task.prompt||'').startsWith('[内部工作回报]'))return false;
    if(hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.preflight-retry' LIMIT 1").get(task.id))return false;
    if(hub.store.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status IN ('pending','resolving','recovery_required') LIMIT 1").get(task.id))return false;
    if(hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.worker-created' LIMIT 1").get(task.id))return false;
    hub.store.event(task.id,'director.preflight-retry',{runVersion:task.runVersion,error:redact(error.message)});
    hub.run(hub.store.task(task.id),task.prompt);
    return true;
  }
  isContextLimit(error) {
    return isContextLimitError(error);
  }
}
