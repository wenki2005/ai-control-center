import {taskSummary,taskPresentationContext} from './task-presentation.mjs';
import {setImmediate as yieldToIo} from 'node:timers/promises';

/** Task presentation owns no submissions, recovery or lifecycle writes. */
export function createTaskReadView({store,hub,sessionLink}) {
  const filter="NOT (role='director' AND prompt LIKE '[内部工作回报]%')";
  const fields='rowid AS cursor,id,engine,role,prompt,model,status,sessionId,cwd,projectPath,runVersion,createdAt,updatedAt';
  const page=store.db.prepare(`SELECT ${fields} FROM tasks WHERE ${filter} AND rowid<? ORDER BY rowid DESC LIMIT ?`);
  const active=store.db.prepare(`SELECT ${fields} FROM tasks WHERE ${filter} AND status IN ('queued','running','waiting') ORDER BY rowid DESC`);
  const count=store.db.prepare(`SELECT count(*) n FROM tasks WHERE ${filter}`);
  async function present(rows){
    const recovery=new Set(store.db.prepare("SELECT DISTINCT taskId FROM approvals WHERE status='recovery_required'").all().map(row=>row.taskId));
    const context=taskPresentationContext(store,rows),title=hub.sessionTitlesForTasks?.(rows)||((task)=>hub.sessionTitleForTask(task)),tasks=[];
    for(const [index,task] of rows.entries()){
      if(index%10===0)await yieldToIo();
      const required=recovery.has(task.id);tasks.push({id:task.id,engine:task.engine,role:task.role,prompt:task.prompt,model:task.model,status:task.status,
        hasSession:!!task.sessionId,canContinue:!!task.sessionId&&!required,canAmend:task.role==='worker'&&!required&&!['waiting','cancelled'].includes(task.status),
        pendingAmendments:context.pending.get(task.id)||0,approvalRecoveryRequired:required,summary:taskSummary(store,task,required,context),
        sessionTitle:title(task),sessionUrl:sessionLink(task),createdAt:task.createdAt,updatedAt:task.updatedAt});
    }
    return tasks;
  }
  return {
    async state({compact=false}={}){
      const recent=page.all(Number.MAX_SAFE_INTEGER,compact?40:200);
      const rows=compact?[...new Map([...active.all(),...recent].map(row=>[row.id,row])).values()].sort((a,b)=>b.cursor-a.cursor):recent;
      return {tasks:await present(rows),taskCount:count.get().n,taskCursor:recent.at(-1)?.cursor||null};
    },
    async history({before=Number.MAX_SAFE_INTEGER,limit=40}={}){
      if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('历史分页参数无效');
      const rows=page.all(before,limit+1),selected=rows.slice(0,limit);
      return {tasks:await present(selected),nextCursor:rows.length>limit?selected.at(-1)?.cursor:null,hasMore:rows.length>limit};
    },
  };
}
