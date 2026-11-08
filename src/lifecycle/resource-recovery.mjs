import {createHash} from 'node:crypto';

const ABANDONED='recovery-abandoned-by-user';
const conflict=message=>Object.assign(Error(message),{code:'RESOURCE_RECOVERY_CONFLICT',statusCode:409});
export function drawingRecoveryVersion(row) {
  if(!row)return null;
  // A legacy database lacks backendBase. Adding that nullable column must not
  // invalidate an otherwise identical, explicitly confirmed source snapshot.
  const normalized={...row,engine:row.engine||'local',backendBase:row.backendBase??null};
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
}

/** Resource observations are independent of business outcomes. Never replay a job. */
export class ResourceRecovery {
  constructor(store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS local_resource_recovery(
      id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,jobId TEXT NOT NULL,
      sourceUpdatedAt TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,createdAt TEXT NOT NULL)`);
    store.db.exec('CREATE INDEX IF NOT EXISTS local_resource_recovery_owner_job ON local_resource_recovery(owner,jobId,id)');
  }
  record({owner,jobId,sourceUpdatedAt,status,evidence}) {
    this.store.db.prepare('INSERT INTO local_resource_recovery(owner,jobId,sourceUpdatedAt,status,evidence,createdAt) VALUES(?,?,?,?,?,?)')
      .run(owner,jobId,sourceUpdatedAt,status,JSON.stringify(evidence),this.store.now());
  }
  recent() {return this.store.db.prepare('SELECT * FROM local_resource_recovery ORDER BY id DESC LIMIT 30').all().map(row=>({...row,evidence:JSON.parse(row.evidence)}));}
  abandonedDrawing(row) {
    if(!row||row.status!=='uncertain'||(row.engine||'local')!=='local')return null;
    const version=drawingRecoveryVersion(row);
    const records=this.store.db.prepare('SELECT id,evidence FROM local_resource_recovery WHERE owner=? AND jobId=? AND status=? ORDER BY id DESC')
      .all(`drawing:${row.id}`,row.id,ABANDONED);
    for(const record of records)try{
      const evidence=JSON.parse(record.evidence);
      if(evidence.kind==='explicit-user-abandonment'&&evidence.version===version&&evidence.authorization?.targetId===row.id
        &&evidence.authorization?.id&&evidence.authorization?.source&&evidence.authorization?.confirmation&&evidence.confirmed===true)return {id:record.id,evidence};
    }catch{}
    return null;
  }
  abandonDrawing({jobId,expectedVersion,confirmed,authorization,assertInactive=()=>{}}={}) {
    if(confirmed!==true)throw conflict('放弃恢复和释放预算需要用户单独确认');
    if(typeof jobId!=='string'||!jobId||typeof expectedVersion!=='string'||!/^[a-f0-9]{64}$/.test(expectedVersion))throw conflict('需要精确作业和预览版本');
    if(authorization?.targetId!==jobId||!['id','source','confirmation'].every(key=>typeof authorization?.[key]==='string'&&authorization[key].trim()&&authorization[key].length<=2000))throw conflict('需要绑定该作业的用户确认及来源审计');
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      const row=db.prepare('SELECT * FROM companion_drawings WHERE id=?').get(jobId);
      if(!row||row.status!=='uncertain'||(row.engine||'local')!=='local')throw conflict('只能明确放弃本地历史未知绘图的恢复，活动作业不能释放');
      if(drawingRecoveryVersion(row)!==expectedVersion)throw conflict('绘图记录已变化，请重新核对原作业后确认');
      if(db.prepare("SELECT 1 FROM companion_drawings WHERE engine='local' AND status IN ('queued','submitting','running') LIMIT 1").get())throw conflict('存在活动绘图，暂不释放历史预算');
      assertInactive();
      const existing=this.abandonedDrawing(row);
      if(!existing)this.record({owner:`drawing:${jobId}`,jobId,sourceUpdatedAt:row.updatedAt,status:ABANDONED,
        evidence:{kind:'explicit-user-abandonment',version:expectedVersion,confirmed:true,authorization:{id:authorization.id,source:authorization.source,confirmation:authorization.confirmation,targetId:jobId},
          remoteId:row.remoteId??null,backendBase:row.backendBase??null,businessOutcome:'unknown',scope:'this-job-budget-and-restart-recovery-only'}});
      const recordId=existing?.id||this.abandonedDrawing(row)?.id;
      db.exec('COMMIT');return {jobId,status:ABANDONED,businessOutcome:'unknown',recordId,alreadyApplied:!!existing};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
}

export function validIdleDrawingQueue(queue) {
  return Array.isArray(queue?.queue_running)&&Array.isArray(queue?.queue_pending)
    &&queue.queue_running.length===0&&queue.queue_pending.length===0;
}

export function maintenanceView({loaded,disk,activity,resources}) {
  const reservations=resources?.coordinator?.active||[];
  return {loaded,disk,sourceMatches:loaded.sourceFingerprint===disk.sourceFingerprint,
    reload:activity,resources:{busy:!!resources?.busy,restoring:!!resources?.restoring,
      reservations:reservations.map(row=>({...row,meaning:row.recovery?'restored-protection':'current-reservation',actualExecution:'unknown'})),
      queued:resources?.coordinator?.queued||0,recovery:resources?.recovery||[]},
    guidance:activity.busy?'安全重载仍受保护。预约不证明模型仍在执行；未知业务结果不会改写或重放。旧进程缺少维护入口时，请正常退出并重新打开程序。':'可使用安全重载；已接受的独立 DSH 请求按原身份跟随恢复。'};
}
