import {isContextLimitError} from './director-continuity.mjs';
import {fixedWorkerSlotForTask} from '../routing/fixed-worker.mjs';

// Only a native rejection before output/tool activity is safe to replay.
// Provider overload and unknown/partly executed turns never enter this path.
export function retryFixedWorkerContext(hub,task,error) {
  if(task?.role!=='worker'||task.engine!=='dsh'||!hub.isFixedWorker(task)||!task.sessionId
    ||error?.retrySafe!==true||!isContextLimitError(error))return false;
  if(hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type IN ('task.worker-context-retried','task.stop-requested') LIMIT 1").get(task.id))return false;
  const slot=fixedWorkerSlotForTask(task,hub.workspaceRoot);
  const key=`worker:fixed:dsh${slot===1?'':`:${slot}`}`;
  let binding;try{binding=JSON.parse(hub.store.meta(key)||'null');}catch{}
  hub.store.transaction(()=>{
    if(binding?.sessionId===task.sessionId)hub.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
    hub.store.event(task.id,'task.worker-context-retried',{previousSessionId:task.sessionId,slot,reason:'context-limit-before-execution'});
    hub.store.event(task.id,'task.fixed-worker-rollover',{previousSessionId:task.sessionId,slot,reason:'context-limit-before-execution'});
    hub.store.update(task.id,{sessionId:null,error:null,result:null});
  });
  hub.run(hub.store.task(task.id));
  return true;
}
