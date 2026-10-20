const RECOVERED_TASK_STATES=new Set(['failed','cancelled','interrupted']);
const DSH_CONNECTION_ERROR=/(?:DSH event stream reconnect failed|connect ECONN(?:REFUSED|RESET)|fetch failed|socket hang up|Timed out connecting to the DSH event stream|^Request timed out\.?$|^Connection error\.?$)/i;
const DSH_TOOL_RUNTIME_ERROR=/(?:Cannot read properties of undefined \(reading ['"]prepare['"]\)|\bprepare undefined\b|TOOL_RUNTIME_SCHEDULER|(?:工具执行|工具调用).{0,100}(?:持续失效|彻底失效|失败|中断|结果未留存|结果未记录)|tool (?:execution|call).{0,100}(?:failed|interrupted|not recorded|not retained))/i;

/** Return error IDs whose underlying incident has verifiable recovery evidence. */
export function findResolvedErrorIds({taskRows,store,guardianState,modelConnection}) {
  const tasks=new Map(taskRows.map(task=>[task.id,task]));
  const superseded=new Set(store.db.prepare("SELECT DISTINCT taskId FROM events WHERE taskId IS NOT NULL AND type='task.superseded'").all().map(row=>row.taskId));
  const deliveredFallbacks=new Set(store.db.prepare(`
    SELECT r.directorTaskId
    FROM return_reports r
    WHERE r.status='fallback' AND r.directorTaskId IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM outbox o
        WHERE substr(o.dedupe,1,length('return-fallback:'||r.key||':part:'))='return-fallback:'||r.key||':part:'
      )
      AND NOT EXISTS (
        SELECT 1 FROM outbox o
        WHERE substr(o.dedupe,1,length('return-fallback:'||r.key||':part:'))='return-fallback:'||r.key||':part:'
          AND o.status<>'sent'
      )
  `).all().map(row=>row.directorTaskId));
  const attachmentsResolved=!store.db.prepare("SELECT 1 FROM attachment_outbox WHERE status IN ('pending','sending','uncertain') LIMIT 1").get();
  const uncertainNotificationsResolved=!store.db.prepare("SELECT 1 FROM outbox WHERE status='uncertain' LIMIT 1").get();
  const dshOnline=modelConnection.state('dsh').status==='online';
  const allTasks=store.allTasks();
  const recoveredDshTask=task=>task?.engine==='dsh' && RECOVERED_TASK_STATES.has(task.status);
  const routeEndpoint=task=>{
    const row=store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='dsh.route' ORDER BY id DESC LIMIT 1").get(task?.id);
    try{return JSON.parse(row?.data||'{}').endpoint||null;}catch{return null;}
  };
  const sameCapabilityRecovery=(error,task)=>{
    const endpoint=routeEndpoint(task);if(!endpoint)return false;
    return allTasks.some(candidate=>candidate.engine==='dsh'&&candidate.status==='completed'&&candidate.result
      &&candidate.updatedAt>error.createdAt&&routeEndpoint(candidate)===endpoint
      &&!!store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='dsh.tool-activity' AND createdAt>? LIMIT 1").get(candidate.id,error.createdAt));
  };
  const sameInstanceDshCompletion=(error,task)=>{
    const endpoint=routeEndpoint(task);if(!endpoint)return false;
    return allTasks.some(candidate=>candidate.engine==='dsh'&&candidate.status==='completed'
      &&candidate.result&&candidate.updatedAt>error.createdAt&&routeEndpoint(candidate)===endpoint);
  };
  const recoveredDirectorSessionCwdMismatch=(error,task)=>task?.engine==='dsh'
    &&task.role==='director'&&task.sessionId
    &&/DSH 指定会话的项目目录与任务不一致/.test(error.message)
    &&allTasks.some(candidate=>candidate.engine==='dsh'&&candidate.role==='director'
      &&candidate.status==='completed'&&candidate.sessionId===task.sessionId
      &&candidate.updatedAt>error.createdAt);
  const recoveredCoordinatorSessionSelection=(error,task)=>{
    if(task?.engine!=='dsh'||task.role!=='coordinator'||!task.result
      ||!/^协调器选择的会话不存在、引擎不匹配或仍在执行$/.test(error.message))return false;
    const marker='[HUB-DISPATCH] ';
    if(!task.result.startsWith(marker))return false;
    let dispatch;try{dispatch=JSON.parse(task.result.slice(marker.length));}catch{return false;}
    if(dispatch?.engine!=='dsh'||typeof dispatch.sessionId!=='string')return false;
    return allTasks.some(candidate=>candidate.engine==='dsh'&&candidate.role==='worker'
      &&candidate.status==='completed'&&candidate.sessionId===dispatch.sessionId
      &&candidate.result&&candidate.updatedAt>error.createdAt);
  };
  const recoveredService=(message,service)=>!guardianState.stale && message.includes(service.error) && guardianState.services?.[service.name]?.status==='healthy';

  return store.allErrors().filter(error=>{
    const task=error.taskId?tasks.get(error.taskId):null;
    const attachmentFailure=!error.taskId && /^QQ 附件(?:通知暂时失败，已保留并将重试：|被明确拒绝，已保留并将重试：|发送结果不确定，已停止自动重发)/.test(error.message);
    const recoveredAttachmentFailure=attachmentsResolved && attachmentFailure;
    const recoveredNotificationFailure=!error.taskId && uncertainNotificationsResolved
      && /^QQ 消息发送结果不确定，已停止自动重发/.test(error.message);
    const recoveredDshConnectionFailure=recoveredDshTask(task) && DSH_CONNECTION_ERROR.test(error.message)
      && dshOnline && sameInstanceDshCompletion(error,task);
    const recoveredDshRuntimeFailure=recoveredDshTask(task) && sameCapabilityRecovery(error,task)
      && /(?:DSH RPC session\/prompt|Connection error\.|Cannot read properties of undefined \(reading 'prepare'\)|belongs to .+ not .+)/i.test(error.message);
    const recoveredDshToolFailure=recoveredDshTask(task) && DSH_TOOL_RUNTIME_ERROR.test(error.message)
      && sameCapabilityRecovery(error,task);
    const cloneFailure=error.message.startsWith('维护助手启动失败：Command failed: git clone')
      && /fatal: destination path '.+' already exists and is not an empty directory\./.test(error.message);
    const cloneJobId=cloneFailure?error.message.match(/repos[\\/](j-[a-f0-9-]{6,})/i)?.[1]:null;
    const recoveredCloneFailure=!!cloneJobId && !!store.db.prepare("SELECT 1 FROM specialist_jobs WHERE id=? AND kind='maintenance' AND status='completed' AND attempts>0 LIMIT 1").get(cloneJobId);
    const recoveredHub=!error.taskId && !guardianState.stale && error.message.includes('中控服务异常') && guardianState.services?.hub?.status==='healthy';
    const recoveredDsh=!error.taskId && !guardianState.stale && /(?:独立 DSH异常|DSH 主服务异常)/.test(error.message) && guardianState.services?.dsh?.status==='healthy';
    const recoveredDshFallback=!error.taskId && !guardianState.stale && /(?:独立 DSH fallback异常|隔离 DSH 主管异常)/.test(error.message) && guardianState.services?.dshFallback?.status==='healthy';
    const recoveredSnowLuma=recoveredService(error.message,{error:'SnowLuma异常',name:'snowluma'});
    const recoveredQqLogin=recoveredService(error.message,{error:'QQ 登录连接异常',name:'qq-login'});
    const staleWatchdog=!error.taskId && !guardianState.stale && error.message.includes('看门狗超过 90 秒未更新');
    // A legacy error-triggered maintenance run may itself fail while its
    // source incident is being recovered. The specialist records an explicit
    // stale-diagnostic-skipped event and closes the job once every source
    // error has been cleared. That audit trail makes the generic failure
    // banner obsolete, while the failed task remains in history.
    const staleMaintenanceDiagnostic=task?.role==='maintenance' && !!store.db.prepare(`
      SELECT 1
      FROM events e JOIN specialist_jobs j ON j.id=json_extract(e.data,'$.jobId')
      WHERE e.taskId=? AND e.type='specialist.stale-diagnostic-skipped'
        AND j.taskId=e.taskId AND j.kind='maintenance' AND j.status='completed'
      LIMIT 1
    `).get(task.id);

    return recoveredAttachmentFailure || recoveredNotificationFailure || recoveredDshConnectionFailure || recoveredDshRuntimeFailure || recoveredDshToolFailure || recoveredDirectorSessionCwdMismatch(error,task) || recoveredCoordinatorSessionSelection(error,task) || recoveredCloneFailure
      || staleMaintenanceDiagnostic
      || superseded.has(error.taskId) || deliveredFallbacks.has(error.taskId)
      || recoveredHub || recoveredDsh || recoveredDshFallback || recoveredSnowLuma || recoveredQqLogin || staleWatchdog;
  }).map(error=>error.id);
}
