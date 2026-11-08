import {createTaskReadView} from './task-read-view.mjs';
import {errorSummary} from './task-presentation.mjs';
import { displayArtifacts } from '../knowledge/display.mjs';
import { groupErrorIncidents } from './error-incidents.mjs';

// Read-model composition only. Recovery and engine actions stay with their
// services, so rendering the console cannot invent a second task lifecycle.
export function createStateView({store,hub,archive,companion,personaIdentity=null,proactive=null,news=null,diary=null,dailyReview=null,mailMonitor=null,specialists,health,modelConnection,readErrors,sessionLink}) {
  let lastProfile=null;const taskView=createTaskReadView({store,hub,sessionLink});
  return {
    diagnostics(){return lastProfile;},
    taskHistory(options){return taskView.history(options);},
    async snapshot({compact=false}={}) {
      const start=performance.now(),profile={};
      const measure=(name,fn)=>{const t=performance.now();const value=fn();profile[name]=Math.round(performance.now()-t);return value;};
      const {tasks,taskCount,taskCursor}=await taskView.state({compact});
      profile.tasksMs=Math.round(performance.now()-start);
      const now=Date.now();
      const activeDirector=store.db.prepare("SELECT id,status,createdAt,updatedAt FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status IN ('running','waiting') ORDER BY createdAt LIMIT 1").get() || null;
      const waitingDirector=store.db.prepare("SELECT id,createdAt FROM tasks WHERE role='director' AND prompt NOT LIKE '[内部工作回报]%' AND status='queued' ORDER BY createdAt,rowid").all();
      const directorQueue={serialized:true,policy:'fifo-per-session',active:activeDirector?{taskId:activeDirector.id,status:activeDirector.status,ageMs:Math.max(0,now-Date.parse(activeDirector.createdAt))}:null,
        waitingCount:waitingDirector.length,next:waitingDirector[0]?{taskId:waitingDirector[0].id,createdAt:waitingDirector[0].createdAt,waitMs:Math.max(0,now-Date.parse(waitingDirector[0].createdAt))}:null};
      const taskTitles=new Map(tasks.map(task=>[task.id,task.sessionTitle]));
      const errors=groupErrorIncidents(readErrors().filter(error=>error.taskId==null||store.db.prepare('SELECT role FROM tasks WHERE id=?').get(error.taskId)?.role!=='coordinator').map(error=>({createdAt:error.createdAt,resolved:!!error.resolved,message:errorSummary(error.message),taskTitle:taskTitles.get(error.taskId)||null})));
      const archiveStart=performance.now();const recent=compact&&archive.recent?await archive.recent(10):null;const artifacts=displayArtifacts(recent?recent.records:await archive.list());profile.artifactsMs=Math.round(performance.now()-archiveStart);
      const companionState=measure('companionMs',()=>companion.state({compact})),specialistState=measure('specialistsMs',()=>specialists.state());
      const result={tasks,...(compact?{taskCount,taskCursor}:{}),approvals:store.approvals().map(({raw,...approval})=>approval),
        artifacts,...(compact?{artifactCount:recent?.total??artifacts.length,compact:true}:{}),errors,chat:store.chat(),
        health:modelConnection?{...health,dshModel:modelConnection.state('dsh')}:health,
        directSession:hub.directSessionStatus?.() || {enabled:false,title:'',connected:false},
        directorQueue,mail:mailMonitor?mailMonitor.settings():null,companion:{...companionState,...(personaIdentity?{identity:personaIdentity.status()}:{}),...(proactive?{proactive:proactive.settings()}:{}),...(news?{news:news.settings()}:{}) ,...(diary?{diary:{...diary.settings(),entries:compact?[]:diary.list(30)}}:{}),...(dailyReview?{dailyReview:dailyReview.settings()}:{})},specialists:specialistState};
      lastProfile={...profile,totalMs:Math.round(performance.now()-start),sampledAt:new Date().toISOString()};
      return result;
    },
  };
}
