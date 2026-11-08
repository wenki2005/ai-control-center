import { createHash } from 'node:crypto';
import { redact } from '../redact.mjs';

const active = new Set(['queued','running','waiting']);
const engineName = engine => engine==='codex'?'Codex':engine==='workbuddy'?'WorkBuddy':engine==='dsh'?'DSH':String(engine || '引擎');

/** Owns exclusive phone-resource scheduling and periodic worker progress reports. */
export class WorkerSupervision {
  constructor({store,reports=()=>null,sessionTitleForTask,createDirector,stopping=()=>false,reconcileTask=()=>false,nativeSessions=()=>null,failTask=()=>{},paused=()=>false}) {
    Object.assign(this,{store,reports,sessionTitleForTask,createDirector,stopping,reconcileTask,nativeSessions,failTask,paused});
    this.reconciling=new Set();
    store.db.exec(`CREATE TABLE IF NOT EXISTS worker_supervision(
      taskId TEXT PRIMARY KEY REFERENCES tasks(id),lastScheduledAt TEXT,lastFinishedAt TEXT,
      reportTaskId TEXT,reportStatus TEXT
    )`);
  }
  get reportService() { return typeof this.reports==='function'?this.reports():this.reports; }
  async reconcileStaleDsh(task,{now=Date.now(),staleMs=2*60*1000,retryMs=5*60*1000}={}) {
    if(task.engine!=='dsh' || !task.sessionId || task.role!=='worker' || this.reconciling.has(task.id))return false;
    const runStart=this.store.db.prepare("SELECT id,createdAt FROM events WHERE taskId=? AND type='task.started' ORDER BY id DESC LIMIT 1").get(task.id);
    if(!runStart)return false;
    const last=this.store.db.prepare("SELECT id,COALESCE(json_extract(data,'$.coalesced.lastSeenAt'),createdAt) createdAt FROM events WHERE taskId=? AND id>? AND type IN ('message','dsh.tool-activity','approval') ORDER BY id DESC LIMIT 1").get(task.id,runStart.id);
    const lastAt=Math.max(Date.parse(last?.createdAt||runStart.createdAt)||now,Date.parse(this.store.eventJournal?.lastActivity(task.id))||0);
    if(now-lastAt<staleMs)return false;
    const key=`dsh-reconcile:${task.id}:${task.runVersion||0}`;
    const previous=Number(this.store.meta(key))||0;
    if(now-previous<retryMs)return false;
    this.reconciling.add(task.id);this.store.meta(key,String(now));
    try {
      const attached=await this.reconcileTask(task);
      if(!attached)return false;
      this.store.event(task.id,'task.dsh-follow-reconnected',{at:new Date(now).toISOString()});
      await new Promise(resolve=>setTimeout(resolve,2500));
      const current=this.store.task(task.id);
      if(!current || current.status!=='running' || current.runVersion!==task.runVersion)return true;
      const sessions=await this.nativeSessions();
      const native=sessions?.find(item=>item.sessionId===task.sessionId);
      // Missing, malformed, or unavailable native status is not evidence that
      // the turn stopped. Only an explicit DSH running:false can settle it.
      if(!native || native.runningKnown!==true || native.running!==false)return true;
      const message='DSH 会话已停止，但中枢没有收到这次工作的完成事件；结果无法确认。为避免重复执行可能已产生的操作，我没有自动重发。';
      this.store.event(task.id,'task.dsh-outcome-uncertain',{sessionTitle:this.sessionTitleForTask(task)});
      await this.failTask(task,new Error(message));
      return true;
    } catch(error) {
      this.store.event(task.id,'task.dsh-reconcile-error',{message:redact(error?.message||error)});
      return false;
    } finally { this.reconciling.delete(task.id); }
  }
  async superviseWorkers({now=Date.now(),intervalMs=5*60*1000}={}) {
    if(this.stopping())return 0;
    const tasks=this.store.db.prepare("SELECT * FROM tasks WHERE role='worker' AND status='running' ORDER BY createdAt").all();
    let queued=0;
    for(const task of tasks) {
      if(this.paused(task))continue;
      if(task.engine==='dsh')await this.reconcileStaleDsh(task,{now});
      const latestTask=this.store.task(task.id);
      if(!latestTask || latestTask.status!=='running')continue;
      const record=this.store.db.prepare('SELECT * FROM worker_supervision WHERE taskId=?').get(task.id);
      const runStart=this.store.db.prepare("SELECT id,createdAt FROM events WHERE taskId=? AND type='task.started' ORDER BY id DESC LIMIT 1").get(task.id);
      const runStartedAt=Date.parse(runStart?.createdAt||task.createdAt)||now;
      const previousReport=record?.reportTaskId?this.store.task(record.reportTaskId):null;
      if(previousReport && active.has(previousReport.status))continue;
      if(record?.reportTaskId && previousReport && record.reportStatus!==previousReport.status) {
        this.store.db.prepare('UPDATE worker_supervision SET lastFinishedAt=?,reportStatus=? WHERE taskId=?')
          .run(previousReport.updatedAt,previousReport.status,task.id);
        record.lastFinishedAt=previousReport.updatedAt;
        record.reportStatus=previousReport.status;
      }
      // A prior run's report may finish after this run starts. Reuse its
      // schedule/finish pair only when its schedule belongs to this run.
      const scheduledAt=Date.parse(record?.lastScheduledAt)||0;
      const currentRunSchedule=scheduledAt>=runStartedAt?scheduledAt:0;
      const finishedAt=currentRunSchedule?(Date.parse(record?.lastFinishedAt)||0):0;
      const lastAt=Math.max(runStartedAt,currentRunSchedule,finishedAt>=runStartedAt?finishedAt:0);
      if(now-lastAt<intervalMs)continue;
      const elapsedMinutes=Math.max(1,Math.floor((now-runStartedAt)/60000));
      const latestMessage=runStart?.id
        ? this.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='message' AND id>? ORDER BY id DESC LIMIT 1").get(task.id,runStart.id)
        : null;
      let currentRunResult='';
      try {currentRunResult=JSON.parse(latestMessage?.data||'{}').text||'';} catch {}
      const latestProgress=redact(String(currentRunResult)).trim().slice(-900) || '暂时没有新的文字进展';
      const progressHash=createHash('sha256').update(latestProgress).digest('hex');
      const progressMetaKey=`worker-progress:${task.id}:${task.runVersion||0}`;
      const stalledSinceKey=`worker-stall-since:${task.id}:${task.runVersion||0}`;
      const stallReportedKey=`worker-stall-reported:${task.id}:${task.runVersion||0}`;
      const unchanged=this.store.meta(progressMetaKey)===progressHash;
      let stalledMinutes=0,toolActivityCount=0,progressStalled=false;
      if(unchanged) {
        let stalledSince=Number(this.store.meta(stalledSinceKey))||0;
        if(!stalledSince) {stalledSince=now;this.store.meta(stalledSinceKey,String(now));}
        stalledMinutes=Math.max(0,Math.floor((now-stalledSince)/60000));
        if(runStart?.id)toolActivityCount=this.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId=? AND type='dsh.tool-activity' AND id>?").get(task.id,runStart.id).n;
        progressStalled=stalledMinutes>=15 && toolActivityCount>=20 && this.store.meta(stallReportedKey)!==progressHash;
      } else {
        this.store.meta(progressMetaKey,progressHash);
        this.store.meta(stalledSinceKey,'');
        this.store.meta(stallReportedKey,'');
      }
      if(unchanged && !progressStalled) {
        const stamp=new Date(now).toISOString();
        this.store.db.prepare(`INSERT INTO worker_supervision(taskId,lastScheduledAt,lastFinishedAt,reportTaskId,reportStatus)
          VALUES(?,?,? ,NULL,'unchanged') ON CONFLICT(taskId) DO UPDATE SET lastScheduledAt=excluded.lastScheduledAt,
          lastFinishedAt=excluded.lastFinishedAt,reportTaskId=NULL,reportStatus='unchanged'`).run(task.id,stamp,stamp);
        continue;
      }
      const reviewNote=progressStalled?`最近约 ${stalledMinutes} 分钟没有新的文字进展；本轮记录到 ${toolActivityCount} 次工具活动。这不足以判定任务卡死，请如实说目前看不到新结果并继续观察。`:'';
      const prompt=`[内部工作回报]\n${JSON.stringify({kind:'progress',sessionName:this.sessionTitleForTask(task),engine:engineName(task.engine),status:'仍在执行',elapsedMinutes,latestProgress,...(progressStalled?{stalledMinutes,toolActivityCount,reviewNote}:{}),files:[]})}\n这是定期进度监督。${reviewNote?reviewNote+' ':''}用当前启用人设的语气简短告诉用户承接会话名、已运行时间和目前进展；没有新进展时如实说明仍在执行、暂未收到更新，并说会继续跟进。不要提内部编号、项目路径或编造进度；不要重派任务、附文件或提问。`;
      const bucket=Math.floor(now/intervalMs);
      const messageKey=`supervision:${task.id}:${task.runVersion||0}:${bucket}`;
      const reports=this.reportService;
      if(reports?.announce) {
        const stamp=new Date(now).toISOString();
        if(progressStalled)this.store.meta(stallReportedKey,progressHash);
        this.store.db.prepare(`INSERT INTO worker_supervision(taskId,lastScheduledAt,lastFinishedAt,reportTaskId,reportStatus)
          VALUES(?,?,NULL,NULL,'queued') ON CONFLICT(taskId) DO UPDATE SET lastScheduledAt=excluded.lastScheduledAt,
          reportTaskId=NULL,reportStatus='queued'`).run(task.id,stamp);
        const contextTask={...task,result:latestProgress,status:'running'};
        void reports.announce({task:contextTask,kind:'progress-update',dedupe:messageKey,
          situation:`这是一次定期进度回报。执行会话名为「${this.sessionTitleForTask(task)}」，已运行约 ${elapsedMinutes} 分钟；当前可确认的进展：${latestProgress}。${reviewNote?reviewNote+' ':''}若没有新进展，就自然说明仍在执行、暂未收到更新，并表示会继续跟进。不要编造，也不要重派任务或附文件。`})
          .then(()=>{
            const current=this.store.task(task.id);
            if(current?.runVersion!==task.runVersion)return;
            const status=current.status==='running'?'reported':'suppressed';
            this.store.db.prepare("UPDATE worker_supervision SET lastFinishedAt=?,reportStatus=? WHERE taskId=? AND lastScheduledAt=? AND reportStatus='queued'")
              .run(this.store.now(),status,task.id,stamp);
          })
          .catch(error=>{
            if(this.store.task(task.id)?.runVersion!==task.runVersion)return;
            if(progressStalled)this.store.meta(stallReportedKey,'');
            const changed=this.store.db.prepare("UPDATE worker_supervision SET lastFinishedAt=?,reportStatus='report-failed' WHERE taskId=? AND lastScheduledAt=? AND reportStatus='queued'")
              .run(this.store.now(),task.id,stamp).changes;
            if(changed)this.store.event(task.id,'task.supervision-error',{message:redact(error.message)});
          });
        queued++; continue;
      }
      try {
        if(progressStalled)this.store.meta(stallReportedKey,progressHash);
        const directorTask=await this.createDirector({engine:'dsh',prompt,messageKey});
        this.store.db.prepare(`INSERT INTO worker_supervision(taskId,lastScheduledAt,lastFinishedAt,reportTaskId,reportStatus)
          VALUES(?,?,NULL,?,'queued') ON CONFLICT(taskId) DO UPDATE SET lastScheduledAt=excluded.lastScheduledAt,
          reportTaskId=excluded.reportTaskId,reportStatus='queued'`).run(task.id,new Date(now).toISOString(),directorTask.id);
        queued++;
      } catch(error) {
        if(progressStalled)this.store.meta(stallReportedKey,'');
        this.store.db.prepare(`INSERT INTO worker_supervision(taskId,lastScheduledAt,lastFinishedAt,reportTaskId,reportStatus)
          VALUES(?,?,NULL,NULL,'enqueue-failed') ON CONFLICT(taskId) DO UPDATE SET lastScheduledAt=excluded.lastScheduledAt,
          reportTaskId=NULL,reportStatus='enqueue-failed'`).run(task.id,new Date(now).toISOString());
        this.store.event(task.id,'task.supervision-error',{message:redact(error.message)});
      }
    }
    return queued;
  }
}
