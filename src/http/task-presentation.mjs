import {isContextLimitError} from '../lifecycle/director-continuity.mjs';

export function taskSummary(store, task, approvalRecoveryRequired=false,context=null) {
  const retry=context?context.retries?.get(task.id):store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_error_retries'").get()
    ?store.db.prepare("SELECT * FROM task_error_retries WHERE taskId=? AND status='pending'").get(task.id):null;
  if(retry&&task.status==='running'&&retry.runVersion===task.runVersion)return `${retry.category==='rate-limit'?'服务暂时限流':'连接暂时异常'}，等待后自动重试（${retry.attempts}/3）；原会话保留。`;
  if(task.role==='worker'&&(context?.hasAmendments??store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_amendments'").get())) {
    const pending=context?context.pending.get(task.id)||0:store.db.prepare("SELECT count(*) n FROM task_amendments WHERE taskId=? AND status='pending'").get(task.id).n;
    if(pending)return `已记录 ${pending} 条补充，等待原会话安全接续；之前的结果还不是本次最终结果。`;
  }
  const report = context?context.reports.get(task.id):store.db.prepare("SELECT data FROM events WHERE taskId=? AND type IN ('narrator.completed','narrator.fallback') ORDER BY id DESC LIMIT 1").get(task.id);
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

export function errorSummary(message) {
  const text = String(message || '');
  if (/(?:发送结果不确定|结果长时间未确认|结果未确认)/.test(text)) return 'QQ 消息可能已送达；为避免重复，中枢已暂停自动重发，请核对 QQ。';
  if (isContextLimitError(text)) return '会话上下文已满，需要新会话接续。';
  if (/prefill_cap_refused|cell is at capacity/i.test(text)) return '模型服务暂时繁忙，稍后可在原会话重试。';
  if (/(?:\b400\b|invalid[_ -]?request|malformed|bad request|请求格式)/i.test(text)) return '请求格式无效，任务未能完成。';
  if (/insufficient[_ -]?quota|quota[_ -](?:exceeded|exhausted)|usage limit exceeded|余额不足|额度(?:已)?(?:不足|耗尽|用完)/i.test(text)) return '模型额度不足，需要核对提供商额度或账单。';
  if (/(?:\b429\b|rate limit|限流)/i.test(text)) return '模型暂时限流；可安全重试的请求会有限退避重试。';
  if (/(?:network|fetch|ECONN|timeout|连接|网络)/i.test(text)) return '服务连接中断，正在等待恢复。';
  if (/(?:approval|approval required|需要确认)/i.test(text)) return '任务正在等待确认。';
  return '发生运行问题，详细记录已保留。';
}

export function taskPresentationContext(store,tasks){
 const pending=new Map(),reports=new Map(),retries=new Map(),ids=tasks.map(t=>t.id),hasAmendments=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_amendments'").get();
 if(ids.length){const marks=ids.map(()=>'?').join(',');
  if(hasAmendments)for(const r of store.db.prepare(`SELECT taskId,count(*) n FROM task_amendments WHERE status='pending' AND taskId IN (${marks}) GROUP BY taskId`).all(...ids))pending.set(r.taskId,r.n);
  if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_error_retries'").get())for(const r of store.db.prepare(`SELECT * FROM task_error_retries WHERE status='pending' AND taskId IN (${marks})`).all(...ids))retries.set(r.taskId,r);
  for(const r of store.db.prepare(`SELECT taskId,data FROM events WHERE id IN (SELECT max(id) FROM events WHERE taskId IN (${marks}) AND type IN ('narrator.completed','narrator.fallback') GROUP BY taskId)`).all(...ids))reports.set(r.taskId,r);
 }
 return {hasAmendments,pending,reports,retries};
}
