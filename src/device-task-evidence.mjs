const parse=row=>{try{return JSON.parse(row?.data||'{}');}catch{return {};}};
const evidence=row=>row?{eventId:row.id,type:row.type,at:row.createdAt}:null;

// Read existing current-run native observations only. Never submit, resume or alter a task.
export function readLocalTaskEvidence(store,task){
  const binding={taskId:task.id,engine:task.engine,sessionId:task.sessionId,runVersion:task.runVersion};
  const empty={binding,acceptance:null,activity:null};
  if(task.status==='queued'||!task.sessionId||!Number.isSafeInteger(task.runVersion))return empty;
  const start=store.db.prepare("SELECT id FROM events WHERE taskId=? AND type='task.started' ORDER BY id DESC LIMIT 1").get(task.id);
  if(!start)return empty;
  const session=store.db.prepare("SELECT id,type,data,createdAt FROM events WHERE taskId=? AND type='session' AND id>? ORDER BY id DESC LIMIT 1").get(task.id,start.id);
  const identity=parse(session);
  // Connecting a native session is not a receipt for its prompt. Old sessions and prior runs cannot testify.
  if(identity.sessionId!==task.sessionId||identity.runVersion!==task.runVersion)return empty;
  if(task.engine!=='dsh')return empty; // Existing Codex session event occurs before turn/start; it proves no acceptance.
  const activity=store.db.prepare("SELECT id,type,createdAt FROM events WHERE taskId=? AND id>? AND type IN ('dsh.model-started','dsh.tool-activity') ORDER BY id DESC LIMIT 1").get(task.id,start.id);
  const received=store.db.prepare("SELECT id,type,createdAt FROM events WHERE taskId=? AND id>? AND type='dsh.prompt-received' ORDER BY id LIMIT 1").get(task.id,start.id);
  const acceptedSession=identity.accepted===true&&(typeof identity.requestId==='string'&&identity.requestId||typeof identity.promptMarker==='string'&&identity.promptMarker)?session:null;
  const terminal=store.db.prepare("SELECT id FROM events WHERE taskId=? AND id>? AND type IN ('completed','failed','task.stop-requested') ORDER BY id DESC LIMIT 1").get(task.id,start.id);
  return {binding,acceptance:evidence(received||acceptedSession||activity),activity:terminal?null:evidence(activity)};
}
