import { join, isAbsolute } from 'node:path';

/** Resolve a worker's project, reusable session, and DSH continuation evidence. */
export function resolveWorkerContext({
  workspaceRoot,directorProjectPath,engine,role,parent,project,requestedSessionId,nativeSession,resumeTaskId,prompt,store,
  projectNameForCwd,requestsFreshSession,latestCompletedProjectWorker,latestRelatedWorker,sessionIsRelevant,reusableDshRoute,
}) {
  let cwd=join(workspaceRoot,role==='worker'?join('projects','中控任务'):'_director');
  if(role==='director' && engine==='codex' && directorProjectPath)cwd=directorProjectPath;
  let projectName=null;
  if(role==='worker' && typeof project==='string' && project.trim()) {
    projectName=project.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/[. ]+$/g,'').slice(0,80);
    if(!projectName || projectName==='.' || projectName==='..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(projectName))throw Error('项目名称无效');
    cwd=join(workspaceRoot,'projects',projectName);
  }
  let continuedFrom=null,coordinatorSessionFallback=null;
  if(role==='worker' && nativeSession) {
    const nativeEngine=nativeSession.engine||'dsh';
    const validId=engine==='dsh'?/^session-[\w-]+$/u:/^[\w-]{1,180}$/u;
    if(engine!==nativeEngine || !['director','coordinator'].includes(parent?.role) || !validId.test(String(nativeSession.sessionId||'')) || typeof nativeSession.cwd!=='string' || !isAbsolute(nativeSession.cwd))throw Error('主管原生会话必须由中枢核验引擎、原会话和工作目录后绑定');
    if(store.db.prepare("SELECT 1 FROM tasks WHERE engine=? AND sessionId=? AND status IN ('queued','running','waiting') LIMIT 1").get(engine,nativeSession.sessionId))throw Error('指定会话已有中枢任务正在执行');
    requestedSessionId=nativeSession.sessionId;
    cwd=nativeSession.cwd;
  }
  if(role==='worker' && requestedSessionId && !nativeSession) {
    const validSession=typeof requestedSessionId==='string' && !!requestedSessionId.trim() && requestedSessionId.length<=300;
    if(!validSession) {
      if(parent?.role==='coordinator') {coordinatorSessionFallback={reason:'malformed'};requestedSessionId=null;}
      else throw Error('指定的工作会话无效');
    }
    if(requestedSessionId) {
      const trusted=resumeTaskId?store.task(resumeTaskId):null;
      const trustedMatch=trusted?.role==='worker'&&trusted.engine===engine&&trusted.sessionId===requestedSessionId
        && ['completed','failed','cancelled','interrupted'].includes(trusted.status)
        && !store.db.prepare("SELECT 1 FROM tasks WHERE sessionId=? AND status IN ('queued','running','waiting') LIMIT 1").get(requestedSessionId);
      continuedFrom=trustedMatch?trusted:store.db.prepare("SELECT * FROM tasks AS previous WHERE previous.role='worker' AND previous.engine=? AND previous.sessionId=? AND previous.status IN ('completed','failed','cancelled','interrupted') AND NOT EXISTS (SELECT 1 FROM tasks AS activeTask WHERE activeTask.sessionId=previous.sessionId AND activeTask.status IN ('queued','running','waiting')) ORDER BY previous.createdAt DESC LIMIT 1").get(engine,requestedSessionId);
      if(continuedFrom && parent?.role==='coordinator') {
        if(continuedFrom.id!==resumeTaskId&&!sessionIsRelevant(prompt,continuedFrom)) {
          coordinatorSessionFallback={reason:'unrelated'};
          requestedSessionId=null;
          continuedFrom=null;
        }
      }
      if(!continuedFrom) {
        if(parent?.role==='coordinator') {coordinatorSessionFallback ||= {reason:'missing-busy-or-engine-mismatch'};requestedSessionId=null;}
        else throw Error('协调器选择的会话不存在、引擎不匹配或仍在执行');
      } else {cwd=continuedFrom.cwd;projectName=projectNameForCwd(cwd);}
    }
  }
  if(role==='worker' && !nativeSession && !continuedFrom && projectName && !requestsFreshSession(prompt)) {
    continuedFrom=latestCompletedProjectWorker(engine,cwd,projectName,prompt);
  }
  if(role==='worker' && !nativeSession && !continuedFrom && !projectName && !requestsFreshSession(prompt)) {
    continuedFrom=latestRelatedWorker(engine,prompt);
    if(continuedFrom) {cwd=continuedFrom.cwd;projectName=projectNameForCwd(cwd);}
  }
  let continuationRoute=null,continuationContext=null,continuedSessionId=continuedFrom?.sessionId || null;
  if(role==='worker' && engine==='dsh' && continuedFrom?.sessionId && !nativeSession) {
    continuationRoute=reusableDshRoute(continuedFrom.id);
    continuationContext={prompt:String(continuedFrom.prompt||'').slice(0,700),result:String(continuedFrom.result||'').slice(0,1100)};
    if(!continuationRoute)continuedSessionId=null;
  }
  return {cwd,projectName,continuedFrom,coordinatorSessionFallback,requestedSessionId,continuationRoute,continuationContext,continuedSessionId};
}
