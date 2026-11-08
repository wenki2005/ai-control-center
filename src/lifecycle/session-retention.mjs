import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {planSessionRetention} from './session-retention-policy.mjs';
import {prepareSessionTranscript} from './session-transcript.mjs';
import {redact} from '../redact.mjs';

const terminal=new Set(['completed','failed','cancelled']);
export class SessionRetention {
  constructor({store,nativeTasks,companion,now=Date.now,prepare=prepareSessionTranscript}) {
    Object.assign(this,{store,nativeTasks,companion,now,prepare});
    this.owner=randomUUID();
    nativeTasks.prepareArchive=snapshot=>this.prepare({store,companion,...snapshot});
    store.db.exec(`CREATE TABLE IF NOT EXISTS dsh_session_retention(sessionId TEXT PRIMARY KEY,status TEXT NOT NULL,reason TEXT NOT NULL,backupPath TEXT,transcriptPath TEXT,memoryCount INTEGER NOT NULL DEFAULT 0,error TEXT,updatedAt TEXT NOT NULL,retryAfter INTEGER)`);
    store.db.exec('CREATE TABLE IF NOT EXISTS dsh_session_retention_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expiresAt INTEGER NOT NULL)');
    if(!store.db.prepare('PRAGMA table_info(dsh_session_retention)').all().some(row=>row.name==='attempts'))store.db.exec('ALTER TABLE dsh_session_retention ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }
  settings(){return {enabled:this.store.meta('session-retention:enabled')!=='off',automaticDays:3,inactiveDays:15,intervalMinutes:60,scope:'有中枢创建记录或DSH明确subagent来源标记的自动会话；个人、未知归属及固定运行会话保留'};}
  async ownership(){
    const {store}=this,automatic=new Map(),personal=new Set(),protectedIds=new Set();
    // A session returned after a start without an existing ID was created by
    // this adapter. Native adoption and user-selected sessions start with IDs.
    const events=store.db.prepare(`SELECT e.data,e.createdAt FROM events e JOIN tasks t ON t.id=e.taskId
      WHERE t.engine='dsh' AND e.type='session' AND
      (json_extract(e.data,'$.createdByHub')=1 OR
       (json_type(e.data,'$.createdByHub') IS NULL AND EXISTS(SELECT 1 FROM events p WHERE p.taskId=e.taskId AND p.type='task.started' AND p.id<e.id)
        AND (SELECT json_extract(p.data,'$.sessionId') FROM events p WHERE p.taskId=e.taskId AND p.type='task.started' AND p.id<e.id ORDER BY p.id DESC LIMIT 1) IS NULL))
      ORDER BY e.id`).all();
    for(const row of events){let e;try{e=JSON.parse(row.data);}catch{continue;}if(e.sessionId&&!automatic.has(e.sessionId))automatic.set(e.sessionId,row.createdAt);}
    const collect=value=>{if(typeof value==='string'){for(const id of value.match(/session-[a-zA-Z0-9-]+/g)||[])protectedIds.add(id);}else if(value&&typeof value==='object')for(const child of Object.values(value))collect(child);};
    for(const row of store.db.prepare("SELECT key,value FROM metadata WHERE key NOT LIKE 'internal-session:%' AND key NOT LIKE 'session-documents:%' AND key NOT LIKE 'session-retention:%'").all()){
      if(/session|worker:fixed/iu.test(row.key)){try{collect(JSON.parse(row.value));}catch{collect(row.value);}}
    }
    for(const row of store.db.prepare("SELECT value FROM metadata WHERE key LIKE 'session-retention:personal:%'").all())personal.add(row.value);
    for(const task of store.db.prepare('SELECT id,sessionId,status,role FROM tasks WHERE sessionId IS NOT NULL').all()){
      if(task.role==='direct')personal.add(task.sessionId);
      if(!terminal.has(task.status))protectedIds.add(task.sessionId);
    }
    for(const row of store.db.prepare("SELECT DISTINCT t.sessionId FROM tasks t JOIN approvals a ON a.taskId=t.id WHERE a.status IN ('pending','resolving','paused') AND t.sessionId IS NOT NULL").all())protectedIds.add(row.sessionId);
    if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='specialist_agents'").get())for(const row of store.db.prepare('SELECT sessionId FROM specialist_agents WHERE sessionId IS NOT NULL').all())protectedIds.add(row.sessionId);
    try{collect(JSON.parse(await readFile(join(homedir(),'.dsh/bot/state.json'),'utf8')));}catch{}
    return {automatic,personal,protectedIds};
  }
  async plan(sessions){
    sessions??=await this.nativeTasks.listSessions({includeDelegated:true});const ownership=await this.ownership();
    for(const session of sessions)if(session.parentSessionId&&session.origin==='subagent'&&!ownership.automatic.has(session.sessionId))ownership.automatic.set(session.sessionId,null);
    const active=new Set(sessions.filter(s=>s.running===true).map(s=>s.sessionId));
    for(const task of this.store.db.prepare("SELECT sessionId FROM tasks WHERE sessionId IS NOT NULL AND status IN('queued','running','waiting','interrupted')").all())active.add(task.sessionId);
    for(let pass=0;pass<sessions.length;pass++){let added=false;for(const s of sessions)if(s.parentSessionId&&active.has(s.parentSessionId)&&!active.has(s.sessionId)){active.add(s.sessionId);ownership.protectedIds.add(s.sessionId);added=true;}if(!added)break;}
    const archivedIds=this.store.db.prepare('SELECT sessionId FROM dsh_archived_sessions').all().map(row=>row.sessionId);
    const normalized=sessions.map(row=>({...row,createdAt:row.createdAt??ownership.automatic.get(row.sessionId)}));
    const decision=planSessionRetention({sessions:normalized,automaticIds:ownership.automatic.keys(),personalIds:ownership.personal,protectedIds:ownership.protectedIds,archivedIds,now:this.now()});
    return {...decision,sessions:normalized,summary:{total:sessions.length,provenAutomatic:sessions.filter(s=>ownership.automatic.has(s.sessionId)).length,eligible:decision.eligible.length,alreadyArchived:decision.skipped.filter(row=>row.reason==='already-archived').length,notDue:decision.skipped.filter(row=>row.reason==='not-old-enough-or-invalid-time').length,protected:decision.skipped.filter(row=>!['already-archived','not-old-enough-or-invalid-time'].includes(row.reason)).length},settings:this.settings()};
  }
  run({limit=10}={}) {
    if(this.pending)return this.pending;
    const claimed=this.store.db.prepare(`INSERT INTO dsh_session_retention_lease(id,owner,expiresAt) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt WHERE expiresAt<=? RETURNING owner`).get(this.owner,this.now()+600000,this.now());
    if(!claimed)return Promise.resolve({busy:true,archived:[],failed:[]});
    this.pending=this.perform(Math.max(1,Math.min(100,Number(limit)||10))).finally(()=>{this.store.db.prepare('DELETE FROM dsh_session_retention_lease WHERE owner=?').run(this.owner);this.pending=null;});return this.pending;
  }
  async perform(limit){
    if(!this.settings().enabled)return {disabled:true,archived:[],failed:[]};
    const plan=await this.plan(),archived=[],failed=[];
    const candidates=plan.eligible.filter(row=>!(this.store.db.prepare('SELECT retryAfter FROM dsh_session_retention WHERE sessionId=?').get(row.sessionId)?.retryAfter>this.now())).slice(0,limit);
    for(const item of candidates){
      if(this.closed)break;const session=plan.sessions.find(row=>row.sessionId===item.sessionId);let prepared;
      if(!this.store.db.prepare('UPDATE dsh_session_retention_lease SET expiresAt=? WHERE owner=?').run(this.now()+600000,this.owner).changes)break;
      try{
        const result=await this.nativeTasks.archiveSession(item.sessionId,{
          sessionSnapshot:session,
          guard:async(latest,catalog)=>{const current=await this.plan(catalog||[latest]);if(!current.eligible.some(row=>row.sessionId===item.sessionId))throw Error('会话保护状态或时间条件已变化，未归档');},
          beforeArchive:async snapshot=>{prepared=await this.prepare({store:this.store,companion:this.companion,sessionId:item.sessionId,backupPath:snapshot.backupPath,title:session.title});}
        });
        if(!result.archived)throw Error('原生归档未确认');
        this.store.db.prepare(`INSERT INTO dsh_session_retention(sessionId,status,reason,backupPath,transcriptPath,memoryCount,updatedAt) VALUES(?,'archived',?,?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET status='archived',reason=excluded.reason,backupPath=excluded.backupPath,transcriptPath=excluded.transcriptPath,memoryCount=excluded.memoryCount,error=NULL,updatedAt=excluded.updatedAt,retryAfter=NULL`)
          .run(item.sessionId,item.reason,result.backupPath,prepared.transcriptPath,prepared.memoryCandidates.length,this.store.now());
        this.store.event(null,'session-retention.archived',{sessionId:item.sessionId,reason:item.reason,backupPath:result.backupPath,messages:prepared.messageCount,memoryCandidates:prepared.memoryCandidates.length});
        archived.push({sessionId:item.sessionId,title:session.title,reason:item.reason,messages:prepared.messageCount,memoryCandidates:prepared.memoryCandidates.length});
      }catch(error){
        const message=redact((error.dshMethod?`DSH ${error.dshMethod}: `:'')+String(error.message)).slice(0,800);
        const attempts=(this.store.db.prepare('SELECT attempts FROM dsh_session_retention WHERE sessionId=?').get(item.sessionId)?.attempts||0)+1;
        const unknown=error.archiveResultUnknown||(error.dshMethod==='workspace/archiveSession'&&/timeout|aborted|fetch failed/i.test(error.message));
        const status=unknown?'uncertain':'failed',retryAfter=unknown||attempts>=3?Number.MAX_SAFE_INTEGER:this.now()+3600000;
        this.store.db.prepare(`INSERT INTO dsh_session_retention(sessionId,status,reason,error,updatedAt,retryAfter,attempts) VALUES(?,?,?,?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET status=excluded.status,error=excluded.error,updatedAt=excluded.updatedAt,retryAfter=excluded.retryAfter,attempts=excluded.attempts`).run(item.sessionId,status,item.reason,message,this.store.now(),retryAfter,attempts);
        this.store.event(null,'session-retention.failed',{sessionId:item.sessionId,error:message});failed.push({sessionId:item.sessionId,title:session.title,error:message});
      }
    }
    const result={at:this.store.now(),summary:plan.summary,archived,failed};this.store.meta('session-retention:last-run',JSON.stringify(result));return result;
  }
  start(){this.closed=false;const run=()=>void this.run().catch(error=>this.store.event(null,'session-retention.scan-failed',{error:redact(error.message)}));this.first=setTimeout(run,60000);this.first.unref?.();this.timer=setInterval(run,3600000);this.timer.unref?.();}
  async close(){this.closed=true;clearTimeout(this.first);clearInterval(this.timer);await this.pending;}
}
