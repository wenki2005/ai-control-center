/** Exact native request identity survives a control-center process, not a replay prompt. */
export function dshFollowIdentity(store,task) {
  if(task.engine!=='dsh'||!task.sessionId)return {};
  const row=store.db.prepare("SELECT id,data FROM events WHERE taskId=? AND type='session' ORDER BY id DESC LIMIT 1").get(task.id);
  let data;try{data=JSON.parse(row?.data||'{}');}catch{return {};}
  if(data.sessionId!==task.sessionId||data.runVersion!=null&&data.runVersion!==task.runVersion)return {};
  return {...(typeof data.requestId==='string'&&data.requestId?{followRequestId:data.requestId}:{}),
    ...(typeof data.promptMarker==='string'&&data.promptMarker?{followPromptMarker:data.promptMarker}:{})};
}

export function canDetachDshTask(store,task) {
  if(task.engine!=='dsh'||!['worker','director','coordinator'].includes(task.role))return false;
  if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_error_retries'").get()
    &&store.db.prepare("SELECT 1 FROM task_error_retries WHERE taskId=? AND status='pending'").get(task.id))return false;
  if(store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type IN ('task.stop-requested','task.native-linked') LIMIT 1").get(task.id))return false;
  if(store.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status IN ('pending','resolving','recovery_required') LIMIT 1").get(task.id))return false;
  if(task.status==='queued')return true; // Nothing has been submitted yet.
  if(task.status!=='running'||!task.sessionId)return false;
  const identity=dshFollowIdentity(store,task);
  if(!identity.followRequestId&&!identity.followPromptMarker)return false;
  const started=store.db.prepare("SELECT id FROM events WHERE taskId=? AND type='task.started' ORDER BY id DESC LIMIT 1").get(task.id)?.id;
  if(!started)return false;
  const session=store.db.prepare("SELECT id,data FROM events WHERE taskId=? AND type='session' ORDER BY id DESC LIMIT 1").get(task.id);
  if(!session||session.id<started)return false;
  const accepted=JSON.parse(session.data).accepted===true||!!store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND id>? AND type IN ('dsh.prompt-received','dsh.model-started','dsh.tool-activity') LIMIT 1").get(task.id,started);
  return accepted;
}

export function checkpointDshReload(store) {
  const tasks=store.db.prepare("SELECT * FROM tasks WHERE status='running' AND engine='dsh'").all().filter(task=>canDetachDshTask(store,task));
  for(const task of tasks)store.event(task.id,'task.reload-checkpoint',{sessionId:task.sessionId,runVersion:task.runVersion,...dshFollowIdentity(store,task)});
  return tasks.length;
}
