import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const sessionIdVariants=id=>id.startsWith('session-')?[id,id.slice(8)]:[id,`session-${id}`];
const nativeSessionId=id=>/^session-[\w-]+$/u.test(id)||/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(id);

export async function directoryManifest(root) {
  const entries=[];
  async function walk(directory) {
    const children=await readdir(directory,{withFileTypes:true});
    children.sort((a,b)=>a.name.localeCompare(b.name));
    for(const child of children) {
      const path=join(directory,child.name),rel=relative(root,path).split(sep).join('/'),info=await lstat(path);
      if(info.isSymbolicLink())throw Error(`会话备份发现符号链接，无法验证完整性：${rel}`);
      if(info.isDirectory()) {entries.push({path:rel,type:'directory'});await walk(path);}
      else if(info.isFile()) {
        const digest=createHash('sha256');
        for await(const chunk of createReadStream(path))digest.update(chunk);
        entries.push({path:rel,type:'file',size:info.size,sha256:digest.digest('hex')});
      } else throw Error(`会话备份发现无法识别的文件类型：${rel}`);
    }
  }
  await walk(root);
  return entries;
}

function isSessionCwdConflict(error) {
  return /session\s+["'][^"']+["']\s+belongs to\s+["'][^"']+["'],\s*not\s+["'][^"']+["']/i.test(String(error||''));
}

function isTransientPollError(error) {
  return /timeout|aborted|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/i.test(String(error?.message||error||''));
}

// The historical 3080 director can use hub_dispatch as well as our own tools.
// Adopt those tasks without sending another prompt to their engine sessions.
export class DshTaskReturns {
  constructor({store,hub,baseUrl,fetchImpl=fetch,timeoutFactory=AbortSignal.timeout,sessionListTimeoutMs=20_000,enabled=true,trustedHost=null,launchToken=null,launchTokenProvider=null,sessionDataRoot=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'sessions'),sessionBackupRoot=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'session-log-backups','mornye-control-center')}) {
    Object.assign(this,{store,hub,fetchImpl,timeoutFactory,sessionListTimeoutMs,enabled,launchToken,launchTokenProvider,sessionDataRoot,sessionBackupRoot});
    const url=new URL(baseUrl);
    const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname)||/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if(url.protocol!=='http:'||(!loopback&&(!trustedHost||trustedHost!==url.hostname)))throw Error('DSH 回报只允许连接本机');
    this.baseUrl=url.origin;this.trustedHost=trustedHost;this.launchToken=launchToken;this.cookie=null;this.watching=new Set();
    this.failed=false;this.consecutiveFailures=0;
    store.db.exec(`CREATE TABLE IF NOT EXISTS dsh_native_tasks(nativeId TEXT PRIMARY KEY,taskId TEXT NOT NULL,directorTaskId TEXT NOT NULL,createdAt TEXT NOT NULL,settledStatus TEXT,settledAt TEXT);`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS dsh_archived_sessions(sessionId TEXT PRIMARY KEY,archivedAt TEXT NOT NULL);`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS dsh_session_backups(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,backupPath TEXT NOT NULL,manifestHash TEXT NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL,deletedAt TEXT,error TEXT);`);
    const columns=new Set(store.db.prepare('PRAGMA table_info(dsh_native_tasks)').all().map(row=>row.name));
    if(!columns.has('settledStatus'))store.db.exec('ALTER TABLE dsh_native_tasks ADD COLUMN settledStatus TEXT');
    if(!columns.has('settledAt'))store.db.exec('ALTER TABLE dsh_native_tasks ADD COLUMN settledAt TEXT');
  }
  async authCookie({refresh=false}={}){
    if(refresh)this.cookie=null;
    if(this.cookie)return this.cookie;
    if(typeof this.launchTokenProvider==='function') {
      try { const latest=await this.launchTokenProvider(); if(latest)this.launchToken=latest; }
      catch { /* keep using the last known token during transient log access failures */ }
    }
    if(!this.launchToken)return null;
    const login=new URL('/',this.baseUrl);login.searchParams.set('token',this.launchToken);
    const response=await this.fetchImpl(login,{redirect:'manual',signal:AbortSignal.timeout(5000)});
    const cookie=(response.headers.getSetCookie?.()||[response.headers.get('set-cookie')].filter(Boolean)).find(value=>value.includes('='))?.split(';',1)[0];
    if(!cookie)throw Error(`DSH authentication HTTP ${response.status}`);
    this.cookie=cookie;return cookie;
  }
  async request(url,options={}){
    for(let attempt=0;attempt<2;attempt++) {
      const cookie=await this.authCookie({refresh:attempt>0}),headers={...(options.headers||{})};
      if(cookie)headers.cookie=cookie;
      const response=await this.fetchImpl(url,{...options,headers});
      if(![401,403].includes(response.status)||attempt||typeof this.launchTokenProvider!=='function')return response;
    }
  }
  async rpc(method,args,{timeoutMs=5000}={}) {
    const rpcId=randomUUID();
    let response;
    try{response=await this.request(`${this.baseUrl}/api/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args}}),signal:this.timeoutFactory(timeoutMs)});}
    catch(error){error.dshMethod=method;throw error;}
    if(!response.ok)throw Error(`DSH ${method} HTTP ${response.status}`);
    const value=await response.json();
    if(value.rpcId!==rpcId || !value.result?.ok)throw Error(`DSH ${method} 未返回有效结果`);
    return value.result.value;
  }
  async listSessions({includeDelegated=false}={}) {
    // DSH's session projection can take longer than task RPCs when it must
    // load a large, cold history. Give this read-only enumeration its own
    // bounded window so the UI does not report a false session failure at 5s.
    const value=await this.rpc('session/list',{_request:{}},{timeoutMs:this.sessionListTimeoutMs});
    const rows=Array.isArray(value?.items)?value.items:[];
    return rows.map(row=>{
      const title=String(row?.projections?.values?.title ?? row?.title ?? row?.name ?? (includeDelegated&&row?.parentSessionId?row?.projections?.values?.subagent?.label||'自动子会话':'')).trim();
      const sessionId=String(row?.sessionId ?? '');
      const cwd=String(row?.cwd ?? row?.projections?.values?.cwd ?? '');
      if(!(includeDelegated?nativeSessionId(sessionId):/^session-[\w-]+$/u.test(sessionId)) || !title || !cwd) return null;
      const updatedAt=row?.updatedAt ?? row?.projections?.values?.updatedAt ?? null;
      const turns=Number(row?.turnCount ?? row?.turns ?? row?.projections?.values?.turnCount ?? 0);
      const createdAt=row?.createdAt??row?.projections?.values?.createdAt;
      return {sessionId,title,cwd,...(row.parentSessionId&&nativeSessionId(row.parentSessionId)?{parentSessionId:row.parentSessionId}:{}),...(row.origin==='subagent'?{origin:'subagent'}:{}),running:row?.running===true,runningKnown:typeof row?.running==='boolean',...(createdAt!=null&&Number.isFinite(Number(createdAt))?{createdAt:Number(createdAt)}:{}),updatedAt:updatedAt!=null&&Number.isFinite(Number(updatedAt))?Number(updatedAt):null,turns:Number.isFinite(turns)?turns:0};
    }).filter(Boolean);
  }
  async archiveSession(sessionId,{beforeArchive,guard,sessionSnapshot}={}) {
    if(!nativeSessionId(String(sessionId||'')))throw Error('DSH 会话身份无效');
    // A retention scan already enumerated the catalog. Reuse that initial
    // snapshot, then always obtain a fresh catalog after backup preparation.
    if(sessionSnapshot&&sessionSnapshot.sessionId!==sessionId)throw Error('归档快照身份不匹配');
    const initialSessions=sessionSnapshot?[sessionSnapshot]:await this.listSessions({includeDelegated:true});
    const listed=initialSessions.find(item=>item.sessionId===sessionId);
    if(!listed)throw Error('会话不存在或已不可用');
    if(listed.running!==false||listed.runningKnown!==true)throw Error('无法确认会话已停止；为保护正在运行的会话，已取消归档');
    await guard?.(listed,initialSessions);

    const root=await realpath(this.sessionDataRoot),directories=[];
    for(const slug of await readdir(root,{withFileTypes:true})) {
      if(!slug.isDirectory())continue;
      const slugPath=join(root,slug.name),slugInfo=await lstat(slugPath);
      if(slugInfo.isSymbolicLink())continue;
      for(const variant of sessionIdVariants(sessionId)) {
        const candidate=join(slugPath,variant);
        try {
          const info=await lstat(candidate);
          if(!info.isDirectory()||info.isSymbolicLink())continue;
          const actual=await realpath(candidate),rel=relative(root,actual);
          if(!rel||rel==='..'||rel.startsWith('..'+sep)||resolve(actual)!==resolve(candidate))throw Error('会话目录路径无法安全验证');
          directories.push({slug:slug.name,variant,source:actual});
        } catch(error) {if(error?.code!=='ENOENT')throw error;}
      }
    }
    if(!directories.length)throw Error('找不到会话原始数据目录；没有删除会话');

    const base=join(this.sessionBackupRoot,`${this.store.now().replace(/[:.]/gu,'-')}-${randomUUID()}`);
    await mkdir(this.sessionBackupRoot,{recursive:true});
    await mkdir(base,{recursive:false});
    const before=[];
    for(const entry of directories)before.push({slug:entry.slug,variant:entry.variant,files:await directoryManifest(entry.source)});
    try {
      for(const entry of directories) {
        const destination=join(base,'sessions',entry.slug,entry.variant);
        await mkdir(join(base,'sessions',entry.slug),{recursive:true});
        await cp(entry.source,destination,{recursive:true,force:false,errorOnExist:true,preserveTimestamps:true});
      }
      const after=[],copies=[];
      for(let i=0;i<directories.length;i++) {
        after.push({slug:directories[i].slug,variant:directories[i].variant,files:await directoryManifest(directories[i].source)});
        copies.push({slug:directories[i].slug,variant:directories[i].variant,files:await directoryManifest(join(base,'sessions',directories[i].slug,directories[i].variant))});
      }
      if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(before)!==JSON.stringify(copies))throw Error('会话数据在复制期间发生变化或备份校验不一致；没有删除会话');
      const manifest={version:1,sessionId,createdAt:this.store.now(),directories:copies};
      const manifestText=JSON.stringify(manifest,null,2),manifestHash=createHash('sha256').update(manifestText).digest('hex');
      await writeFile(join(base,'manifest.json'),manifestText,{flag:'wx'});
      this.store.db.prepare('INSERT INTO dsh_session_backups(id,sessionId,backupPath,manifestHash,status,createdAt) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(),sessionId,base,manifestHash,'verified',this.store.now());
      await (beforeArchive||this.prepareArchive)?.({sessionId,title:listed.title,backupPath:base,manifestHash});
      // Recheck running state immediately before archiving the active projection.
      const latestSessions=await this.listSessions({includeDelegated:true});
      const latest=latestSessions.find(item=>item.sessionId===sessionId);
      if(!latest||latest.running!==false||latest.runningKnown!==true)throw Error('会话运行状态已变化或无法确认；备份已保留，没有归档会话');
      if(latest.updatedAt!==listed.updatedAt)throw Error('会话在备份后被再次使用；备份已保留，没有归档会话');
      await guard?.(latest,latestSessions);
      for(let i=0;i<directories.length;i++)if(JSON.stringify(before[i].files)!==JSON.stringify(await directoryManifest(directories[i].source)))throw Error('原会话内容在归档准备期间变化，已保留备份并停止归档');
      const archived=await this.rpc('workspace/archiveSession',{request:{sessionId,stopActivity:false}},{timeoutMs:15000});
      if(!Array.isArray(archived?.archivedSessionIds)||!archived.archivedSessionIds.includes(sessionId))throw Object.assign(Error('DSH 未确认目标会话已归档；保留备份等待核对'),{archiveResultUnknown:true});
      const now=this.store.now();
      this.store.transaction(()=>{
        this.store.db.prepare('INSERT INTO dsh_archived_sessions(sessionId,archivedAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET archivedAt=excluded.archivedAt').run(sessionId,now);
        this.store.db.prepare("UPDATE dsh_session_backups SET status='archived',deletedAt=? WHERE backupPath=?").run(now,base);
      });
      return {sessionId,archived:true,backupPath:base,manifestHash};
    } catch(error) {
      this.store.db.prepare("UPDATE dsh_session_backups SET status='backup-only',error=? WHERE backupPath=? AND status='verified'").run(String(error?.message||error).slice(0,1000),base);
      throw error;
    }
  }
  poll({fresh=false}={}) {
    if(fresh) {
      const pending=this.pending;
      if(pending)return pending.then(()=>this.poll({fresh:true}));
      // A fresh pass is required when a supervisor turn has completed: an
      // older in-flight list snapshot may predate the native tool dispatch.
    }
    if(!this.enabled || this.stopping)return Promise.resolve(true);
    if(this.pending)return this.pending;
    const started=Date.now();
    this.pending=this.sync().then(()=>{
      this.failed=false;this.consecutiveFailures=0;
      const recovered=this.store.db.prepare("SELECT id FROM errors WHERE message LIKE 'DSH 原生任务回报连接暂时不可用，将自动重试：%'").all();
      if(recovered.length)this.store.clearErrors(recovered.map(row=>row.id),{reason:'native-sync-completed'});
      this.store.meta?.('dsh-native:sync-health',JSON.stringify({status:'online',checkedAt:new Date().toISOString(),elapsedMs:Date.now()-started}));
      return true;
    }).catch(error=>{
      this.consecutiveFailures++;
      this.store.meta?.('dsh-native:sync-health',JSON.stringify({status:'retrying',phase:this.syncPhase,checkedAt:new Date().toISOString(),elapsedMs:Date.now()-started,consecutiveFailures:this.consecutiveFailures,errorType:error.name||'Error'}));
      // A single missed poll is expected during DSH restarts or local network
      // jitter. Keep retrying silently, but surface explicit auth/protocol
      // failures immediately and sustained transport failures after 3 polls.
      if(!this.failed && (!isTransientPollError(error) || this.consecutiveFailures>=3)){
        this.store.error(null,'DSH 原生任务回报连接暂时不可用，将自动重试：'+error.message);this.failed=true;
      }
      return false;
    }).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async sync() {
    this.syncPhase='compact';
    let response;
    for(let attempt=0;attempt<2;attempt++) {
      try {response=await this.request(`${this.baseUrl}/mornye/api/tasks/compact`,{signal:AbortSignal.timeout(5000)});break;}
      catch(error){if(attempt||!isTransientPollError(error))throw error;}
    }
    if(!response.ok)throw Error(`DSH 任务列表 HTTP ${response.status}`);
    const value=await response.json();if(!Array.isArray(value.tasks))throw Error('DSH 任务列表格式无效');
    this.syncPhase='task-processing';
    // First attach: replay results completed after the most recent supervisor
    // reply, rather than flooding QQ with the old stack's entire history.
    let since=this.store.meta('dsh-native:return-since');
    if(!since) {
      since=this.store.db.prepare("SELECT MAX(updatedAt) AS at FROM tasks WHERE role='director' AND status='completed' AND prompt NOT LIKE '[内部工作回报]%'").get().at || this.store.now();
      this.store.meta('dsh-native:return-since',since);
    }
    let sessions;
    for(const native of value.tasks) {
      if(this.stopping)break;
      if(!/^T[\w-]+$/u.test(String(native.taskId)) || !/^session-[\w-]+$/u.test(String(native.target)) || !Number.isFinite(native.dispatchedAt))continue;
      let link=this.store.db.prepare('SELECT * FROM dsh_native_tasks WHERE nativeId=?').get(native.taskId);
      if(!link) {
        const terminal=['done','failed','no-report','timeout'].includes(native.status);
        if(terminal && (!Number.isFinite(native.settledAt) || native.settledAt<Date.parse(since)))continue;
        // Only adopt work dispatched while one of THIS hub's director turns
        // was running. Unrelated/historical DSH sessions stay outside the hub.
        // Task records from the legacy plugin carry the calling native DSH
        // session. Never guess ownership from whichever supervisor task is
        // newest: concurrent director/coordinator turns can overlap.
        const sourceSessionId=String(native.sourceSessionId||'');
        if(!/^session-[\w-]+$/u.test(sourceSessionId))continue;
        const at=new Date(native.dispatchedAt).toISOString();
        const parent=this.store.db.prepare("SELECT * FROM tasks WHERE role IN ('director','coordinator') AND engine='dsh' AND sessionId=? AND createdAt<=? AND (status IN ('running','waiting') OR updatedAt>=?) AND prompt NOT LIKE '[内部工作回报]%' ORDER BY createdAt DESC LIMIT 1").get(sourceSessionId,at,at);
        if(!parent)continue;
        if(!sessions)sessions=(await this.rpc('session/list',{_request:{}},{timeoutMs:this.sessionListTimeoutMs})).items || [];
        const session=sessions.find(item=>item.sessionId===native.target);if(!session?.cwd)continue;
        const id='t-native-'+createHash('sha256').update(this.baseUrl+'\0'+native.taskId).digest('hex').slice(0,12);
        this.store.transaction(()=>{
          let task=this.store.db.prepare("SELECT * FROM tasks WHERE role='worker' AND sessionId=? ORDER BY createdAt DESC LIMIT 1").get(native.target);
          // A task already managed by the hub must not receive a second
          // completion watcher or a second return notification.
          const existing=task && ['queued','running','waiting'].includes(task.status) && !this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.native-linked'").get(task.id);
          if(!existing) {
            task=this.store.task(id) || this.store.createTask({id,engine:'dsh',prompt:String(native.task||'DSH 任务'),cwd:session.cwd,sessionId:native.target,role:'worker'});
            this.store.update(task.id,{status:'running'});
            this.store.event(task.id,'task.native-linked',{nativeId:native.taskId,directorTaskId:parent.id,followPromptMarker:`[HUB-TASK ${native.taskId}]`});
            this.store.event(task.id,'dsh.route',{endpoint:this.baseUrl,priority:'primary-3080'});
          }
          this.store.db.prepare('INSERT INTO dsh_native_tasks(nativeId,taskId,directorTaskId,createdAt) VALUES(?,?,?,?)').run(native.taskId,task.id,parent.id,this.store.now());
          this.store.event(parent.id,'director.worker-created',{workerId:task.id,engine:'dsh',nativeId:native.taskId});
        });
        link=this.store.db.prepare('SELECT * FROM dsh_native_tasks WHERE nativeId=?').get(native.taskId);
        this.hub.emit();
      }
      const task=this.store.task(link.taskId);
      if(!task || ['completed','failed','cancelled'].includes(task.status))continue;
      const adopted=this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.native-linked'").get(task.id);
      if(!adopted)continue;
      if(['failed','no-report','timeout'].includes(native.status)) {
        // DSH's native task is the authority for this adopted task's terminal
        // outcome. A hub restart marks running work interrupted; restore only
        // this verified native-linked task to an active state before routing
        // its failure through the ordinary Hub lifecycle. Persist the receipt
        // after fail() succeeds so repeated polls or a later manual resume do
        // not apply the same native failure to a newer run.
        if(link.settledAt)continue;
        const failure=String(native.error || native.report || '');
        if(isSessionCwdConflict(failure) && !this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.native-cwd-conflict-retried'").get(task.id)) {
          // The native DSH dispatcher can try to reopen a historical QQ
          // session using the current DSH process cwd. DSH rejects that before
          // sending any prompt. Keep the historical session intact, then let
          // the Hub create a fresh session in the session's recorded project.
          // This is a one-time safe retry because session/create failed before
          // the worker request was accepted.
          const previousSessionId=task.sessionId || native.target;
          this.store.transaction(()=>{
            this.store.event(task.id,'task.native-cwd-conflict-retried',{nativeId:native.taskId,previousSessionId,cwd:task.cwd});
            this.store.update(task.id,{status:'queued',sessionId:null,error:null});
            this.store.db.prepare('UPDATE dsh_native_tasks SET settledStatus=?,settledAt=? WHERE nativeId=? AND settledAt IS NULL')
              .run('retried-cwd-conflict',this.store.now(),native.taskId);
          });
          this.hub.run({...task,status:'queued',sessionId:null},task.prompt);
          continue;
        }
        if(task.status==='interrupted') {
          this.store.update(task.id,{status:'running',error:null});
          this.store.event(task.id,'task.native-reconnected',{nativeId:native.taskId,status:native.status});
        }
        await this.hub.fail(task.id,Error(String(native.error || native.report || `DSH 任务${native.status}`)));
        this.store.db.prepare('UPDATE dsh_native_tasks SET settledStatus=?,settledAt=? WHERE nativeId=? AND settledAt IS NULL')
          .run(native.status,this.store.now(),native.taskId);
      } else if(native.status==='done' && !this.watching.has(task.id)) {
        // A legacy receipt can arrive before turn/end. Replay/follow the
        // matching native turn and wait for its successful terminal event.
        this.watching.add(task.id);
        this.hub.run({...task,reconnectOnly:true,followPromptMarker:`[HUB-TASK ${native.taskId}]`});
      } else if(task.status==='interrupted')this.store.update(task.id,{status:'running',error:null});
    }
  }
  async close(){this.stopping=true;await this.pending;}
}
