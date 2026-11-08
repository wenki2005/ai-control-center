import {sessionDisplayName} from '../session-label.mjs';
import {fixedWorkerSlotForTask} from '../routing/fixed-worker.mjs';
// Snapshot-local lookup: no cache may retain stale bindings across a handoff.
export function taskTitleLookup({store,workspaceRoot,tasks,engineName}){
 const ids=tasks.map(t=>t.id).filter(Boolean),flags=new Map(),origins=new Map(),nativeTitles=new Map();
 if(ids.length){for(const row of store.db.prepare(`SELECT taskId,data FROM events WHERE taskId IN (${ids.map(()=>'?').join(',')}) AND type='task.native-session'`).all(...ids)){try{const value=JSON.parse(row.data);if(value.title)nativeTitles.set(row.taskId,value.title);}catch{}}}
 if(ids.length){const marks=ids.map(()=>'?').join(',');for(const r of store.db.prepare(`SELECT taskId,type FROM events WHERE taskId IN (${marks}) AND type IN ('task.fixed-worker','task.fixed-dispatcher')`).all(...ids)){const set=flags.get(r.taskId)||new Set();set.add(r.type);flags.set(r.taskId,set);}}
 const sessions=[...new Set(tasks.map(t=>t.sessionId).filter(Boolean))];
 if(sessions.length)for(const row of store.db.prepare(`WITH wanted(sessionId) AS (VALUES ${sessions.map(()=>'(?)').join(',')})
  SELECT t.id,t.engine,t.role,t.prompt,t.cwd,t.sessionId FROM wanted w JOIN tasks t ON t.rowid=(
    SELECT rowid FROM tasks WHERE role='worker' AND sessionId=w.sessionId ORDER BY createdAt,rowid LIMIT 1
  )`).all(...sessions))origins.set(row.sessionId,row);
 return task=>{if(nativeTitles.has(task?.id))return nativeTitles.get(task.id);const fixed=flags.get(task?.id);if(fixed?.has('task.fixed-worker')){const slot=fixedWorkerSlotForTask(task,workspaceRoot);return engineName(task.engine)+' · 固定工作会话'+(slot>1?' '+slot:'');}if(fixed?.has('task.fixed-dispatcher'))return '任务分发';return sessionDisplayName(origins.get(task?.sessionId)||task);};
}
