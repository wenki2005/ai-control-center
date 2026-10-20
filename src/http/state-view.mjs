import { displayArtifacts } from '../knowledge/display.mjs';
import { groupErrorIncidents } from './error-incidents.mjs';

function taskSummary(store, task, approvalRecoveryRequired=false) {
  const report = store.db.prepare("SELECT data FROM events WHERE taskId=? AND type IN ('narrator.completed','narrator.fallback') ORDER BY id DESC LIMIT 1").get(task.id);
  try {
    const text = JSON.parse(report?.data || '{}').text;
    if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 500);
  } catch { /* A malformed optional narration must not break the state view. */ }
  if(task.role==='coordinator') {
    if(task.status==='running')return '二级主管正在选择合适的工作会话并派发；其他任务可以同时进入各自的派单流程。';
    if(task.status==='queued')return '二级主管派单已登记，等待连接。';
    if(task.status==='completed')return '二级主管已完成派单核对。';
    if(task.status==='failed')return '二级主管派单遇到问题，详情已记录。';
  }
  if (task.status === 'detached') return '中枢直连已关闭，原 DSH 会话保留。';
  if (task.status === 'completed') return '任务已完成，可打开对应会话查看详情。';
  if (task.status === 'failed') return '任务遇到问题，详细错误已记录。';
  if (task.status === 'waiting' || task.status === 'approval') return '正在等待你的选择。';
  if (task.status === 'interrupted' && approvalRecoveryRequired) return '中断前正在等待人工选择；请到原 Agent 会话核对，中枢不会自动续跑。';
  if (task.status === 'interrupted') return '任务曾中断，可从原会话继续。';
  return task.status === 'running' ? '正在执行。' : '任务已排队。';
}

function errorSummary(message) {
  const text = String(message || '');
  if (/(?:发送结果不确定|结果长时间未确认|结果未确认)/.test(text)) return 'QQ 消息可能已送达；为避免重复，中枢已暂停自动重发，请核对 QQ。';
  if (/(?:\b400\b|invalid[_ -]?request|malformed|bad request|请求格式)/i.test(text)) return '请求格式无效，任务未能完成。';
  if (/(?:context|上下文)/i.test(text)) return '会话上下文已满，需要新会话接续。';
  if (/(?:\b429\b|quota|rate limit|额度)/i.test(text)) return '模型额度或速率受限，稍后可重试。';
  if (/(?:network|fetch|ECONN|timeout|连接|网络)/i.test(text)) return '服务连接中断，正在等待恢复。';
  if (/(?:approval|approval required|需要确认)/i.test(text)) return '任务正在等待确认。';
  return '发生运行问题，详细记录已保留。';
}

// Read-model composition only. Recovery and engine actions stay with their
// services, so rendering the console cannot invent a second task lifecycle.
export function createStateView({store,hub,archive,companion,news=null,diary=null,specialists,health,modelConnection,readErrors,sessionLink}) {
  return {
    async snapshot() {
      const recoveryApprovalTasks=new Set(store.db.prepare("SELECT DISTINCT taskId FROM approvals WHERE status='recovery_required'").all().map(row=>row.taskId));
      const tasks=store.tasks()
        .filter(task=>!(task.role==='director' && String(task.prompt||'').startsWith('[内部工作回报]')))
        .map(task=>{const approvalRecoveryRequired=recoveryApprovalTasks.has(task.id);return {id:task.id,engine:task.engine,role:task.role,prompt:task.prompt,model:task.model,status:task.status,
          hasSession:!!task.sessionId,canContinue:!!task.sessionId&&!approvalRecoveryRequired,approvalRecoveryRequired,summary:taskSummary(store,task,approvalRecoveryRequired),
          sessionTitle:hub.sessionTitleForTask(task),sessionUrl:sessionLink(task),createdAt:task.createdAt,updatedAt:task.updatedAt};});
      const now=Date.now();
      const activeDirector=store.db.prepare("SELECT id,status,createdAt,updatedAt FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status IN ('running','waiting') ORDER BY createdAt LIMIT 1").get() || null;
      const waitingDirector=store.db.prepare("SELECT id,createdAt FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status='queued' ORDER BY createdAt,rowid").all();
      const directorQueue={serialized:true,policy:'fifo-per-session',active:activeDirector?{taskId:activeDirector.id,status:activeDirector.status,ageMs:Math.max(0,now-Date.parse(activeDirector.createdAt))}:null,
        waitingCount:waitingDirector.length,next:waitingDirector[0]?{taskId:waitingDirector[0].id,createdAt:waitingDirector[0].createdAt,waitMs:Math.max(0,now-Date.parse(waitingDirector[0].createdAt))}:null};
      const taskTitles=new Map(tasks.map(task=>[task.id,task.sessionTitle]));
      const errors=groupErrorIncidents(readErrors().filter(error=>store.task(error.taskId)?.role!=='coordinator').map(error=>({createdAt:error.createdAt,resolved:!!error.resolved,message:errorSummary(error.message),taskTitle:taskTitles.get(error.taskId)||null})));
      return {tasks,approvals:store.approvals().map(({raw,...approval})=>approval),
        artifacts:displayArtifacts(await archive.list()),errors,chat:store.chat(),
        health:modelConnection?{...health,dshModel:modelConnection.state('dsh')}:health,
        directSession:hub.directSessionStatus?.() || {enabled:false,title:'',connected:false},
        directorQueue,companion:{...companion.state(),...(news?{news:news.settings()}:{}) ,...(diary?{diary:{...diary.settings(),entries:diary.list(30)}}:{})},specialists:specialists.state()};
    },
  };
}
