import {mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,copyFileSync,realpathSync,cpSync,renameSync,unlinkSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {redact,containsCredential} from './redact.mjs';
import {hasHumanReadableName} from './knowledge/share-policy.mjs';
const execute=promisify(execFile),KINDS=['maintenance','librarian'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const label=kind=>kind==='maintenance'?'维护助手':'资料管理员';
function specialistSummary(row){
  if(row.status==='completed'||row.status==='deployed'){
    const value=redact(String(row.result||'')).replace(/(?:[A-Za-z]:\\|\/)(?:[^\s<>"']+[\\/])*[^\s<>"']+/g,'相关文件').replace(/\b(?:session|sess|thread)[-_][A-Za-z0-9_-]{6,}\b/gi,'会话');
    return value.trim().slice(0,220)||'已完成。';
  }
  if(row.status==='failed'){
    const error=String(row.error||'');
    if(error==='approval-recovery-required')return '中断前正在等待人工选择；请到原 Agent 会话核对。';
    if(/(?:\b400\b|invalid[_ -]?request|malformed|bad request)/i.test(error))return '请求格式有误，尚未完成。';
    if(/(?:context|上下文)/i.test(error))return '会话上下文已满，需要新会话接续。';
    if(/(?:\b429\b|quota|rate limit|额度)/i.test(error))return '模型额度或速率受限，稍后可重试。';
    if(/(?:network|fetch|ECONN|timeout|连接|网络)/i.test(error))return '连接中断，正在等待恢复。';
    return '遇到运行问题，详细记录已保留。';
  }
  return ({queued:'已排队，空闲后开始。',running:'正在处理。',ready:'修复已准备好，等待验证。',cancelled:'已取消。'})[row.status]||'正在处理。';
}
const MAX_AUTO_RETRIES=3;
function safePreflightRetry(job){return job?.kind==='maintenance' && !job.taskId && Number(job.attempts)===0 && /git clone[\s\S]*fatal: destination path '.+' already exists and is not an empty directory\./i.test(String(job.error||''));}
function retryClass(error){
  const text=String(error||'');
  if(/(?:\b400\b|invalid[_ -]?request|validation|schema|malformed|bad request)/i.test(text))return null;
  if(/引擎任务回执 JSON 无效|invalid (?:engine )?task receipt json/i.test(text))return 'receipt';
  if(/(?:session.{0,128}(?:not found|expired|unavailable|cannot be resumed|cannot resume|belongs to.{0,160}not)|(?:cannot|unable to) resume.{0,32}session|会话.{0,12}(?:不存在|过期|无法恢复|目录不匹配))/i.test(text))return 'session';
  if(/(?:\b429\b|quota|usage limit|rate limit|too many requests|insufficient[_ -]?quota|额度)/i.test(text))return 'quota';
  if(/(?:\b503\b|^\s*connection error\.?\s*$|timed out connecting.{0,80}(?:event stream|websocket)|workspace.{0,40}routing.{0,40}discovery.{0,40}(?:timeout|timed out)|fetch|network|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|EAI_AGAIN|socket|temporar(?:y|ily) unavailable|(?:event|request|operation).{0,30}timeout|timeout.{0,30}(?:event|request|operation)|连接(?:重置|拒绝|超时)|拒绝连接|网络)/i.test(text))return 'network';
  return null;
}
function retryAt(now,attempts,kind){const base=kind==='quota'?60*60_000:60_000;return new Date(Date.parse(now)+base*2**Math.max(0,attempts)).toISOString();}
const inside=(base,path)=>{const rel=relative(resolve(base),resolve(path));return !!rel && rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel);};
function noLinks(base,path){let current=resolve(path);while(current!==resolve(base)){if(!inside(base,current))throw Error('路径越界');if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('维护目标经过目录跳转');current=dirname(current);}}
function atomicWrite(file,bytes){const temp=file+'.hub-'+randomUUID()+'.tmp';try{writeFileSync(temp,bytes);renameSync(temp,file);}finally{if(existsSync(temp))unlinkSync(temp);}}

export class Specialists {
  constructor({root,runtime,store,hub,archive,enabled=true,contextLimit=100000,onChange=()=>{},notify=()=>{},runner=execute}) {
    Object.assign(this,{root,runtime,store,hub,archive,enabled,contextLimit,onChange,notify,runner});this.stopping=false;
    this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS specialist_agents(kind TEXT PRIMARY KEY,sessionId TEXT,cwd TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,currentJob TEXT,handoff TEXT,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specialist_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,dedupe TEXT UNIQUE,status TEXT NOT NULL,payload TEXT NOT NULL,taskId TEXT,attempts INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,nextRetryAt TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specialist_handoffs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,parentSessionId TEXT,childSessionId TEXT,reason TEXT NOT NULL,payload TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_catalog(artifactId TEXT PRIMARY KEY,title TEXT NOT NULL,summary TEXT NOT NULL,tags TEXT NOT NULL,relatedIds TEXT NOT NULL,jobId TEXT NOT NULL,updatedAt TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(specialist_agents)').all().some(column=>column.name==='engine'))this.db.exec("ALTER TABLE specialist_agents ADD COLUMN engine TEXT NOT NULL DEFAULT 'dsh'");
    if(!this.db.prepare('PRAGMA table_info(specialist_agents)').all().some(column=>column.name==='sessionCwd'))this.db.exec('ALTER TABLE specialist_agents ADD COLUMN sessionCwd TEXT');
    if(!this.db.prepare('PRAGMA table_info(specialist_jobs)').all().some(column=>column.name==='nextRetryAt'))this.db.exec('ALTER TABLE specialist_jobs ADD COLUMN nextRetryAt TEXT');
    for(const kind of KINDS){const cwd=kind==='librarian'?join(runtime,'workspaces','projects','资料管理'):join(runtime,'workspaces','_'+kind);mkdirSync(cwd,{recursive:true});this.db.prepare("INSERT OR IGNORE INTO specialist_agents(kind,cwd,status,updatedAt) VALUES(?,?,'idle',?)").run(kind,cwd,store.now());}
    // Move only the idle librarian's future work into its dedicated DSH project.
    // Existing task directories and archived files remain untouched.
    const oldLibrarianCwd=join(runtime,'workspaces','_librarian'),projectLibrarianCwd=join(runtime,'workspaces','projects','资料管理');
    this.db.prepare("UPDATE specialist_agents SET cwd=?,updatedAt=? WHERE kind='librarian' AND cwd=? AND currentJob IS NULL").run(projectLibrarianCwd,store.now(),oldLibrarianCwd);
    if(!store.meta('specialists:librarianProjectV1')){
      const agent=this.agent('librarian');
      if(!agent.currentJob && agent.cwd===projectLibrarianCwd){
        // A native DSH session retains its original cwd. Start once in the new
        // project rather than continuing an old ungrouped session in a different
        // directory, then reuse the new project's session for subsequent jobs.
        if(agent.sessionId){const handoff=JSON.stringify({kind:'librarian',reason:'project-grouping',catalogEntries:this.state().catalogEntries,createdAt:store.now()});this.db.prepare("UPDATE specialist_agents SET sessionId=NULL,generation=generation+1,handoff=?,updatedAt=? WHERE kind='librarian'").run(handoff,store.now());}
        store.meta('specialists:librarianProjectV1','1');
      }
    }
    for(const kind of KINDS){
      const agent=this.agent(kind);
      if(agent.sessionId && (!agent.sessionCwd || resolve(agent.sessionCwd)!==resolve(agent.cwd)))this.rotate(kind,'workspace-binding-mismatch');
    }
    if(!store.meta('specialists:errorCursor'))store.meta('specialists:errorCursor',String(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM errors').get().n));
    // Librarian automation starts at the current archive tail. Historical
    // artifacts remain available to the manual classify action, but a restart
    // must not reinterpret the whole old archive as new input.
    if(!store.meta('specialists:librarianCursor'))store.meta('specialists:librarianCursor',store.now());
  }
  agent(kind){return this.db.prepare('SELECT * FROM specialist_agents WHERE kind=?').get(kind);}
  decode(row){return row?{...row,payload:JSON.parse(row.payload)}:null;}
  job(id){return this.decode(this.db.prepare('SELECT * FROM specialist_jobs WHERE id=?').get(id));}
  state(){
    const agents=KINDS.map(kind=>{const row=this.agent(kind);return {kind,name:label(kind),engine:row.engine,status:row.status==='working'?'working':'idle',hasSession:!!row.sessionId};});
    const jobs=this.db.prepare('SELECT id,kind,status,taskId,attempts,result,error,nextRetryAt,createdAt,updatedAt FROM specialist_jobs ORDER BY createdAt DESC LIMIT 30').all().map(row=>{
      const task=row.taskId?this.store.task(row.taskId):null,agent=this.agent(row.kind);
      const blockedByApproval=!!task && !!this.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status='recovery_required' LIMIT 1").get(task.id);
      const preflightRetryAvailable=row.status==='failed' && safePreflightRetry(row) && !agent?.currentJob;
      const canResume=preflightRetryAvailable || (row.status==='failed' && !!task?.sessionId && !['queued','running','waiting'].includes(task.status) && !blockedByApproval && !agent?.currentJob);
      return {id:row.id,kind:row.kind,status:row.status,canResume,
        freshSessionAvailable:!preflightRetryAvailable && canResume && /(?:400|invalid[_ -]?request|context|上下文)/i.test(String(row.error||'')),preflightRetryAvailable,
        summary:specialistSummary(row),nextRetryAt:row.nextRetryAt,createdAt:row.createdAt,updatedAt:row.updatedAt,
      };
    });
    return {enabled:this.enabled,agents,jobs,catalogEntries:this.db.prepare('SELECT COUNT(*) AS n FROM artifact_catalog').get().n};
  }
  enqueue(kind,payload,dedupe='manual:'+randomUUID()) {
    if(!KINDS.includes(kind))throw Error('请选择 maintenance 或 librarian');
    const now=this.store.now(),id='j-'+randomUUID().slice(0,12);
    this.db.prepare("INSERT OR IGNORE INTO specialist_jobs(id,kind,dedupe,status,payload,createdAt,updatedAt) VALUES(?,?,?,'queued',?,?,?)").run(id,kind,dedupe,JSON.stringify(redact(payload)),now,now);
    this.onChange();return this.decode(this.db.prepare('SELECT * FROM specialist_jobs WHERE dedupe=?').get(dedupe));
  }
  updateJob(id,patch){const entries=Object.entries(patch).filter(([key])=>['status','taskId','attempts','result','error','payload','nextRetryAt'].includes(key));if(!entries.length)return;this.db.prepare(`UPDATE specialist_jobs SET ${entries.map(([key])=>key+'=?').join(',')},updatedAt=? WHERE id=?`).run(...entries.map(([key,value])=>key==='payload'?JSON.stringify(redact(value)):redact(value)),this.store.now(),id);}
  automaticCatalogMaterial(file) {
    if(!file || String(file.sourcePath||'').startsWith('generated://') || KINDS.includes(this.store.task(file.taskId)?.role))return false;
    return hasHumanReadableName(file) && file.category!=='source' && !/\.(?:log|tmp|bak)$/i.test(String(file.name||''));
  }
  pruneInternalCatalogJobs() {
    const find=this.db.prepare('SELECT task_id AS taskId,name,source_path AS sourcePath,category FROM artifacts WHERE id=?');
    for(const row of this.db.prepare("SELECT * FROM specialist_jobs WHERE kind='librarian' AND status='queued' AND dedupe LIKE 'catalog:%'").all()) {
      const job=this.decode(row),ids=job.payload.artifactIds;if(!Array.isArray(ids))continue;
      const kept=ids.filter(id=>this.automaticCatalogMaterial(find.get(id)));if(kept.length===ids.length)continue;
      this.store.transaction(()=>{
        for(const id of ids.filter(id=>!kept.includes(id)))if(this.store.meta('catalog:queued:'+id)===job.id)this.store.meta('catalog:queued:'+id,'');
        this.updateJob(job.id,kept.length?{payload:{...job.payload,artifactIds:kept}}:{status:'cancelled',nextRetryAt:null,result:'内部维护产物不触发自动资料整理，原文件保留。'});
        this.store.event(null,'librarian.internal-queue-pruned',{jobId:job.id,removed:ids.length-kept.length,remaining:kept.length});
      });
    }
  }
  async gather() {
    this.pruneInternalCatalogJobs();
    // The rowid cursor can move past live errors when recovered rows are
    // cleared or a database snapshot is restored. Reconcile by source error ID
    // against durable maintenance-job payloads so no outstanding error is
    // silently skipped and processed errors remain idempotent.
    const errors=this.db.prepare(`SELECT e.rowid AS seq,e.* FROM errors e
      -- This poller already retries transient transport failures and clears
      -- its notice after the next successful sync. Spawning a full maintenance
      -- job for each hourly retry window creates noisy, redundant work.
      WHERE e.message NOT LIKE 'DSH 原生任务回报连接暂时不可用，将自动重试：%'
      AND NOT EXISTS (
        SELECT 1 FROM specialist_jobs j, json_each(j.payload,'$.errorIds') source
        WHERE j.kind='maintenance' AND source.value=e.id
      ) ORDER BY e.rowid LIMIT 100`).all();
    for(const error of errors){const task=error.taskId?this.store.task(error.taskId):null;if(task?.status!=='completed' && !KINDS.includes(task?.role) && !/^(?:专职会话|维护助手|资料管理员)/.test(error.message)){
      const fingerprint=hash(error.message.replace(/[a-f0-9]{8}(?:-[a-f0-9-]+)?/gi,'ID'));
      this.enqueue('maintenance',{autoGenerated:true,errorIds:[error.id],error:error.message,taskId:error.taskId,request:'诊断此错误。可修复的中控源码缺陷先在隔离仓库修复并提交 repair.json；网络、额度、登录、凭据或已恢复的问题只报告事实，不改凭据、不停 QQ，不制造代码修改。'},'error:'+fingerprint+':'+error.createdAt.slice(0,13));
    }this.store.meta('specialists:errorCursor',String(error.seq));}
    const librarianCursor=this.store.meta('specialists:librarianCursor');
    const cursorSeq=Number(this.store.meta('specialists:librarianCursorSeq')||0);
    const freshRows=this.db.prepare('SELECT rowid AS seq,id,task_id AS taskId,name,path,source_path AS sourcePath,hash,size,category,created_at AS createdAt,excerpt FROM artifacts WHERE created_at>? OR (created_at=? AND rowid>?) ORDER BY created_at,rowid LIMIT 200').all(librarianCursor,librarianCursor,cursorSeq);
    const previousCopy=this.db.prepare('SELECT 1 FROM artifacts WHERE source_path=? AND hash=? AND rowid<? LIMIT 1');
    const eligible=freshRows.filter(file=>this.automaticCatalogMaterial(file) && !(String(file.name).startsWith('task-')&&/Archived files:\s*0\b/i.test(String(file.excerpt||''))) && !String(file.taskId).startsWith('import-') && !previousCopy.get(file.sourcePath,file.hash,file.seq) && !this.db.prepare('SELECT artifactId FROM artifact_catalog WHERE artifactId=?').get(file.id) && !this.store.meta('catalog:queued:'+file.id));
    if(freshRows.length)this.store.transaction(()=>{
      for(let offset=0;offset<eligible.length;offset+=12){const batch=eligible.slice(offset,offset+12);const job=this.enqueue('librarian',{artifactIds:batch.map(file=>file.id)},'catalog:'+hash(batch.map(file=>file.id).sort().join(',')));for(const file of batch)this.store.meta('catalog:queued:'+file.id,job.id);}
      // Advance only after every eligible item is durably queued. The row
      // cursor also covers archives whose files share one collection timestamp.
      const last=freshRows.at(-1);this.store.meta('specialists:librarianCursor',last.createdAt);this.store.meta('specialists:librarianCursorSeq',String(last.seq));
    });
  }
  async shell(command,args,cwd,timeout=90000){return this.runner(command,args,{cwd,windowsHide:true,timeout,maxBuffer:2*1024*1024});}
  async inspectMaintenanceRepo(repo) {
    noLinks(this.runtime,repo);
    if(!existsSync(repo)||lstatSync(repo).isSymbolicLink()||!lstatSync(repo).isDirectory())return null;
    try {
      const [top,origin,head,status]=await Promise.all([
        this.shell('git',['-C',repo,'rev-parse','--show-toplevel'],this.root),
        this.shell('git',['-C',repo,'remote','get-url','origin'],this.root),
        this.shell('git',['-C',repo,'rev-parse','HEAD'],this.root),
        this.shell('git',['-C',repo,'status','--porcelain'],this.root),
      ]);
      const canonical=realpathSync(repo),source=resolve(this.root).toLowerCase();
      if(resolve(top.stdout.trim()).toLowerCase()!==canonical.toLowerCase() || resolve(origin.stdout.trim()).toLowerCase()!==source)return null;
      return {head:head.stdout.trim(),clean:!status.stdout.trim()};
    }catch{return null;}
  }
  async prepareMaintenance(job,agent) {
    const base=(await this.shell('git',['rev-parse','HEAD'],this.root)).stdout.trim();
    let repo;
    if(job.payload.repo && existsSync(job.payload.repo)) {
      repo=resolve(job.payload.repo);
      if(!inside(join(agent.cwd,'repos'),repo))throw Error('维护任务保存的隔离仓库路径越界');
      const state=await this.inspectMaintenanceRepo(repo);
      if(!state)throw Error('维护任务保存的隔离仓库无法验证；原目录已保留，请人工检查');
      return job.payload;
    }
    const preferred=join(agent.cwd,'repos',job.id);mkdirSync(dirname(preferred),{recursive:true});
    const existing=await this.inspectMaintenanceRepo(preferred);
    if(existing?.clean && existing.head===base)repo=preferred;
    else if(!existsSync(preferred))repo=preferred;
    else {
      const recovery=join(dirname(preferred),`${job.id}-recovery-${hash(base||this.root).slice(0,10)}`);
      const prior=await this.inspectMaintenanceRepo(recovery);
      repo=prior?.clean && prior.head===base ? recovery : (existsSync(recovery)?`${recovery}-${randomUUID().slice(0,8)}`:recovery);
    }
    if(existsSync(repo))throw Error('维护任务的恢复隔离目录已存在且无法验证；为保护原文件，已停止创建');
    noLinks(this.runtime,repo);
    await this.shell('git',['clone','--quiet','--no-hardlinks',this.root,repo],agent.cwd);
    const cloned=await this.inspectMaintenanceRepo(repo);
    if(!cloned || cloned.head!==base || !cloned.clean)throw Error('新建的维护隔离仓库未通过来源与基线校验');
    const dependencies=Object.keys(JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).dependencies || {});
    for(const dependency of dependencies){const source=join(this.root,'node_modules',dependency),target=join(repo,'node_modules',dependency);mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{recursive:true,filter:path=>!lstatSync(path).isSymbolicLink()});}
    const payload={...job.payload,repo,baseCommit:base};this.updateJob(job.id,{payload});return payload;
  }
  snapshot(kind,reason) {
    const agent=this.agent(kind),jobs=this.db.prepare('SELECT id,status,result,error FROM specialist_jobs WHERE kind=? ORDER BY createdAt DESC LIMIT 12').all(kind);
    return redact({kind,reason,projectDirectory:agent.cwd,recentJobs:jobs,currentJob:agent.currentJob,catalogEntries:this.state().catalogEntries,createdAt:this.store.now()});
  }
  rotate(kind,reason) {
    const agent=this.agent(kind),snapshot=this.snapshot(kind,reason),id='sh-'+randomUUID();
    this.db.prepare('INSERT INTO specialist_handoffs VALUES(?,?,?,?,?,?,?)').run(id,kind,agent.sessionId,null,reason,JSON.stringify(snapshot),this.store.now());
    this.db.prepare("UPDATE specialist_agents SET sessionId=NULL,sessionCwd=NULL,generation=generation+1,handoff=?,updatedAt=? WHERE kind=?").run(JSON.stringify(snapshot),this.store.now(),kind);
    // Handoff records are internal continuity state. The user receives the
    // concise narrated result when the specialist job finishes; emitting a
    // separate outbox message here used to expose implementation chatter and
    // made routine context rollover look like an actionable failure.
    this.store.event(null,'specialist.handoff-prepared',{id,kind,reason});
  }
  async start(job) {
    const staleDiagnosticIds=job.kind==='maintenance' && job.payload?.autoGenerated===true && Array.isArray(job.payload.errorIds) ? [...new Set(job.payload.errorIds.filter(id=>typeof id==='string'&&id))] : [];
    if(staleDiagnosticIds.length){const active=this.db.prepare(`SELECT 1 FROM errors WHERE id IN (${staleDiagnosticIds.map(()=>'?').join(',')}) LIMIT 1`).get(...staleDiagnosticIds);if(!active){this.updateJob(job.id,{status:'completed',result:'对应报错已恢复并清理，跳过过期诊断。',error:null,nextRetryAt:null});this.store.event(null,'specialist.stale-diagnostic-skipped',{jobId:job.id,errorIds:staleDiagnosticIds});this.onChange();return this.job(job.id);}}
    let agent=this.agent(job.kind);
    if(agent.sessionId && (!agent.sessionCwd || resolve(agent.sessionCwd)!==resolve(agent.cwd))){this.rotate(job.kind,'workspace-binding-mismatch');agent=this.agent(job.kind);}
    const taskId='t-'+hash(job.id+':'+job.attempts).slice(0,12),output=join(agent.cwd,'outputs',taskId);mkdirSync(output,{recursive:true});
    const deliveryName=job.kind==='maintenance'?'repair.json':'catalog.json',deliveryPath=join(output,deliveryName);
    const deliveryBaseline=existsSync(deliveryPath)?{size:lstatSync(deliveryPath).size,mtimeMs:lstatSync(deliveryPath).mtimeMs}:null;
    let instruction;
    if(job.kind==='maintenance') {
      const payload=await this.prepareMaintenance(job,agent);
      instruction=`你是助手 AI 中枢的专职维护助手。只在隔离仓库 ${payload.repo} 内诊断和修复，不得修改线上项目 ${this.root}、原 QQ/DSH 配置或凭据，不得停止服务或部署。必要的源码部署由中控验证后执行。允许自动修复的文件仅 src/ 与 public/ 中已有文件或新文件；不允许删除、改 package/脚本/测试或凭据。既有测试必须保持原样并通过。\n维护请求：${JSON.stringify(payload)}\n把真实结论写入 ${join(output,'repair.json')}，JSON结构为 {"summary":"事实与验证","changes":["src/相对仓库路径或public/路径"]}。无可修源码时changes为空，清楚报告外部阻塞或服务已恢复。不要发明修复；修改前后可以运行 node --test test/*.test.mjs。最后一行必须输出中控 JSON 回执：[HUB-RESULT] {"status":"completed","summary":"简要结论","artifacts":["outputs/${taskId}/repair.json"]}。不要只写文件路径。`;
    } else {
      const ids=job.payload.artifactIds || (await this.archive.list()).filter(file=>this.store.task(file.taskId)?.role!=='librarian').slice(0,12).map(file=>file.id);
      const records=(await Promise.all(ids.map(id=>this.archive.get(id)))).filter(Boolean);
      this.updateJob(job.id,{payload:{...job.payload,artifactIds:records.map(record=>record.id)}});
      instruction=`你是个人数据库的资料管理员。整理中控已归档的文件，复制整理结果，不移动、不删除原件，不扫描其他目录，不修改任务或凭据，不直接改 SQLite 数据库。文件的SHA256和来源由程序保存，只有程序校验后才入库。\n本批文件：${JSON.stringify(records.map(record=>({id:record.id,name:record.name,taskId:record.taskId,excerpt:record.excerpt,size:record.size})))}\n如需全文，可用本机 GET http://127.0.0.1:3188/api/artifacts/<id>/file 。为每个文件生成中文标题、摘要、标签、相关文件ID；标签简短，相关ID只能来自本批或已有文件库。将 ${join(output,'catalog.json')} 写为 {"entries":[{"artifactId":"原ID","title":"中文标题","summary":"基于实际内容的摘要","tags":["标签"],"relatedIds":[]}]}。不得编造未读取事实。最后一行必须输出中控 JSON 回执：[HUB-RESULT] {"status":"completed","summary":"简要说明已整理的文件数","artifacts":["outputs/${taskId}/catalog.json"]}。不要只写文件路径。`;
    }
    // Background specialist jobs must not share a long-lived DSH conversation.
    // DSH queues prompts on a busy session; after a transport failure those
    // prompts can remain queued and later turns no longer map to their Hub task.
    // Keep only a small handoff marker in the fresh session; the current job's
    // explicit payload above is the source of truth for what to do.
    let handoffMarker='';
    if(agent.handoff){
      try{const handoff=JSON.parse(agent.handoff);handoffMarker=JSON.stringify({kind:handoff.kind,reason:handoff.reason,catalogEntries:handoff.catalogEntries,createdAt:handoff.createdAt});}
      catch{handoffMarker=JSON.stringify({kind:job.kind,reason:'prior-session-rotation'});}
      instruction='同项目接续摘要：'+handoffMarker+'\n'+instruction;
    }
    const persistedPayload=this.job(job.id)?.payload || job.payload;
    this.store.transaction(()=>{this.updateJob(job.id,{status:'running',taskId,payload:{...persistedPayload,deliveryBaseline}});this.db.prepare("UPDATE specialist_agents SET status='working',currentJob=?,updatedAt=? WHERE kind=?").run(job.id,this.store.now(),job.kind);});
    try{
      await this.hub.createManaged({id:taskId,kind:job.kind,prompt:instruction,cwd:agent.cwd,engine:agent.engine,sessionId:agent.sessionId});
      if(handoffMarker)this.db.prepare('UPDATE specialist_agents SET handoff=NULL WHERE kind=?').run(job.kind);
    }catch(error){this.store.transaction(()=>{this.updateJob(job.id,{status:'queued',taskId:null});this.db.prepare("UPDATE specialist_agents SET status='idle',currentJob=NULL WHERE kind=?").run(job.kind);});throw error;}
  }
  readOutput(task,name,job) {
    const file=join(task.cwd,'outputs',task.id,name);
    if(!inside(task.cwd,file)||!existsSync(file)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||lstatSync(file).size===0||lstatSync(file).size>500000)throw Error('交付缺失：专职会话交付文件缺失、越界、为空或过大');
    if(!inside(realpathSync(task.cwd),realpathSync(file)))throw Error('交付文件经过目录跳转');
    return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  }
  requireDeliveryReceipt(job,task,name) {
    const row=this.db.prepare("SELECT id,data FROM events WHERE taskId=? AND type='task.receipt' ORDER BY id DESC LIMIT 1").get(task.id);
    let receipt;try{receipt=JSON.parse(row?.data||'{}');}catch{}
    const expected=`outputs/${task.id}/${name}`;
    if(!row||Number(row.id)<=Number(job.payload.deliveryReceiptCursor||0)||receipt?.status!=='completed'||!Array.isArray(receipt.artifacts)||receipt.artifacts.length!==1||receipt.artifacts[0]!==expected)
      throw Error('交付缺失：本轮没有提交与专职任务匹配的完成回执');
    const file=join(task.cwd,expected);
    if(!inside(task.cwd,file)||!existsSync(file)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||lstatSync(file).size===0||lstatSync(file).size>500000)
      throw Error('交付缺失：回执文件不存在、为空或超过大小限制');
  }
  async catalog(job,task) {
    this.requireDeliveryReceipt(job,task,'catalog.json');const document=this.readOutput(task,'catalog.json',job);if(!Array.isArray(document.entries) || document.entries.length>100)throw Error('资料整理回执无效');
    const allowed=new Set(job.payload.artifactIds || []),allIds=new Set((await this.archive.list()).map(file=>file.id));
    const validated=document.entries.map(entry=>{
      if(!allowed.has(entry.artifactId)||typeof entry.title!=='string'||!entry.title.trim()||typeof entry.summary!=='string'||!Array.isArray(entry.tags)||entry.tags.some(tag=>typeof tag!=='string'||tag.length>40)||!Array.isArray(entry.relatedIds)||entry.relatedIds.some(id=>!allIds.has(id)))throw Error('资料整理引用了不存在或不属于本批的文件');
      return {...entry,title:redact(entry.title).slice(0,200),summary:redact(entry.summary).slice(0,4000),tags:entry.tags.slice(0,12),relatedIds:entry.relatedIds.slice(0,20)};
    });
    if(new Set(validated.map(entry=>entry.artifactId)).size!==validated.length)throw Error('资料整理重复引用了同一文件');
    if(new Set(validated.map(entry=>entry.artifactId)).size!==allowed.size)throw Error('资料整理没有完整覆盖本批文件');
    this.store.transaction(()=>{for(const entry of validated)this.db.prepare('INSERT INTO artifact_catalog(artifactId,title,summary,tags,relatedIds,jobId,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(artifactId) DO UPDATE SET title=excluded.title,summary=excluded.summary,tags=excluded.tags,relatedIds=excluded.relatedIds,jobId=excluded.jobId,updatedAt=excluded.updatedAt').run(entry.artifactId,entry.title,entry.summary,JSON.stringify(redact(entry.tags)),JSON.stringify(entry.relatedIds),job.id,this.store.now());});
    return `已整理 ${validated.length} 个文件：标题、摘要、标签和关联已写入数据库，原件保持原位。`;
  }
  async validateRepair(job,task) {
    this.requireDeliveryReceipt(job,task,'repair.json');const report=this.readOutput(task,'repair.json',job);if(typeof report.summary!=='string'||!Array.isArray(report.changes)||report.changes.length>20)throw Error('维护回执无效');
    if(!report.changes.length)return {summary:redact(report.summary).slice(0,4000),changes:[]};
    const repo=job.payload.repo,changes=[];
    for(const name of new Set(report.changes)){
      if(typeof name!=='string'||! /^(?:src|public)\/[\w\u4e00-\u9fff./-]+$/.test(name)||name.split('/').includes('..')||name.endsWith('.env'))throw Error('维护修改超出 src/public 范围，保留隔离方案供查看');
      const file=resolve(repo,name),target=resolve(this.root,name);
      if(!inside(repo,file)||!inside(this.root,target)||!existsSync(file)||lstatSync(file).isSymbolicLink()||lstatSync(file).size>500000||!inside(realpathSync(repo),realpathSync(file)))throw Error('维护交付路径无效');
      if(existsSync(target) && (lstatSync(target).isSymbolicLink()||!inside(realpathSync(this.root),realpathSync(target))))throw Error('线上维护目标经过目录跳转');
      const bytes=readFileSync(file);if(containsCredential(bytes.toString('utf8')))throw Error('维护代码包含凭据');
      if(/\.(?:mjs|cjs|js)$/.test(name))await this.shell(process.execPath,['--check',file],repo);
      const oldHash=existsSync(target)?hash(readFileSync(target)):null;
      if(hash(bytes)!==oldHash)changes.push({name,hash:hash(bytes),oldHash});
    }
    const testChanges=(await this.shell('git',['diff','--name-only','HEAD','--','test','package.json','package-lock.json','scripts'],repo)).stdout.trim();
    if(testChanges)throw Error('维护会话修改了验证基线或启动脚本，不自动部署');
    const tests=await this.shell(process.execPath,['--test','test/*.test.mjs'],repo);
    writeFileSync(join(task.cwd,'outputs',task.id,'validation.txt'),redact(tests.stdout).slice(0,100000));
    return {summary:redact(report.summary).slice(0,4000),changes,baseCommit:job.payload.baseCommit,repo};
  }
  async applyRepair(job) {
    const repair=job.payload.repair;
    if((await this.shell('git',['status','--porcelain'],this.root)).stdout.trim())return false;
    if((await this.shell('git',['rev-parse','HEAD'],this.root)).stdout.trim()!==repair.baseCommit)throw Error('源码版本已变化，维护方案保留但不覆盖新版本');
    const backup=join(this.runtime,'repairs',job.id,'backup');mkdirSync(backup,{recursive:true});
    const sources=new Map();
    for(const change of repair.changes){const target=resolve(this.root,change.name),source=readFileSync(resolve(repair.repo,change.name));if(hash(source)!==change.hash)throw Error('隔离方案在验证后变化，停止部署');sources.set(change.name,source);if((existsSync(target)?hash(readFileSync(target)):null)!==change.oldHash)throw Error('线上文件在维护期间变化，停止自动覆盖');if(existsSync(target)){const saved=join(backup,change.name);mkdirSync(dirname(saved),{recursive:true});copyFileSync(target,saved);}}
    for(const change of repair.changes)noLinks(this.root,resolve(this.root,change.name));
    const manifest={jobId:job.id,status:'pending',backup,changes:repair.changes,at:this.store.now()};
    writeFileSync(join(this.runtime,'deployment.json'),JSON.stringify(manifest,null,2));
    try{
      for(const change of repair.changes){const target=resolve(this.root,change.name);mkdirSync(dirname(target),{recursive:true});atomicWrite(target,sources.get(change.name));}
      await this.shell('git',['add','--',...repair.changes.map(change=>change.name)],this.root);
      const message=join(this.runtime,'repairs',job.id,'commit.txt');writeFileSync(message,'维护助手自动修复：'+repair.summary.slice(0,120)+'\n');
      await this.shell('git',['commit','--file',message],this.root);
    }catch(error){await this.shell(process.execPath,[join(this.root,'scripts','rollback-deployment.mjs')],this.root);throw Error('部署失败，已尝试校验回滚：'+error.message);}
    this.updateJob(job.id,{status:'deployed',result:repair.summary});this.store.meta('specialists:reload',job.id);
    this.hub.report({...this.store.task(job.taskId),status:'completed',result:'中控修复已完成隔离验证并部署，等待空闲时重载。\n'+repair.summary},'repair-deployed:'+job.id);return true;
  }
  async finish(job,task) {
    const approvalRecoveryRequired=this.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status='recovery_required' LIMIT 1").get(task.id);
    if(approvalRecoveryRequired) {
      this.updateJob(job.id,{status:'failed',error:'approval-recovery-required',nextRetryAt:null});
      this.db.prepare("UPDATE specialist_agents SET status='idle',currentJob=NULL,updatedAt=? WHERE kind=?").run(this.store.now(),job.kind);
      this.store.error(task.id,label(job.kind)+'任务在等待人工选择时中断；已停止自动接续，请到原会话核对。');this.onChange();return;
    }
    if(task.status==='interrupted' && task.engine==='dsh' && task.sessionId && task.error==='中控曾退出；请显式继续，防止重复执行。') {
      // DSH continues in its own process. Recover the existing job by following
      // its native journal, without creating a new task, prompt or attempt.
      this.store.event(task.id,'specialist.session-reattach',{sessionId:task.sessionId,jobId:job.id});
      this.hub.run({...task,reconnectOnly:true});this.onChange();return;
    }
    if(task.sessionId && resolve(task.cwd)===resolve(this.agent(job.kind).cwd)){this.db.prepare('UPDATE specialist_agents SET sessionId=?,sessionCwd=?,updatedAt=? WHERE kind=?').run(task.sessionId,task.cwd,this.store.now(),job.kind);this.db.prepare('UPDATE specialist_handoffs SET childSessionId=? WHERE kind=? AND childSessionId IS NULL').run(task.sessionId,job.kind);}
    if(task.status==='cancelled'){
      // A deliberate stop is not a specialist failure and should not notify
      // the user as though the engine had failed.
      this.updateJob(job.id,{status:'cancelled',error:null,nextRetryAt:null});
    }else if(['failed','interrupted'].includes(task.status)) {
      if(task.status==='interrupted'||this.hub.isContextLimit(task.error)){
        if(job.attempts<1){this.rotate(job.kind,task.status==='interrupted'?'service-interrupted':'context-limit');this.updateJob(job.id,{status:'queued',taskId:null,attempts:job.attempts+1});}
        else {this.updateJob(job.id,{status:'failed',error:task.error||task.status,nextRetryAt:null});this.hub.report(task,'specialist-failed:'+job.id);}
      }
      else {
        const transport=task.status==='failed'?retryClass(task.error):null;
        // Maintenance can retry only failures that indicate delivery/session
        // transport loss. Quota failures and all task/validation failures need
        // an explicit human decision. Librarian's separately validated quota
        // retry policy remains unchanged.
        const retry=job.kind==='maintenance'&&['network','session'].includes(transport)?transport:
          job.kind==='librarian'?transport:null;
        if(retry && job.attempts<MAX_AUTO_RETRIES){
          this.updateJob(job.id,{status:'failed',error:task.error||task.status,nextRetryAt:retry==='session'&&job.kind==='librarian'?this.store.now():retryAt(this.store.now(),job.attempts,retry)});
        }else {this.updateJob(job.id,{status:'failed',error:(transport?'transport_error:'+transport+':':'failure:')+(task.error||task.status),nextRetryAt:null});this.hub.report(task,'specialist-failed:'+job.id);}
      }
    }else{
      if(job.kind==='librarian'){
        const result=await this.catalog(job,task);this.updateJob(job.id,{status:'completed',result,error:null,nextRetryAt:null});
        if(String(job.dedupe||'').startsWith('catalog:'))this.store.event(task.id,'librarian.background-completed',{jobId:job.id});
        else this.hub.report({...task,result},'catalog-done:'+job.id);
      }
      else {const repair=await this.validateRepair(job,task);this.updateJob(job.id,repair.changes.length?{status:'ready',payload:{...job.payload,repair},result:repair.summary,error:null,nextRetryAt:null}:{status:'completed',result:repair.summary,error:null,nextRetryAt:null});this.hub.report({...task,status:repair.changes.length?'blocked':'completed',result:repair.summary+(repair.changes.length?'\n仅隔离修复完成，尚待部署验收。':'' )},'maintenance-done:'+job.id);}
      const message=this.db.prepare("SELECT data FROM events WHERE taskId=? AND type IN ('message','usage') AND json_type(data,'$.usage')='object' ORDER BY id DESC LIMIT 1").get(task.id);
      let usage;try{usage=JSON.parse(message?.data||'{}').usage;}catch{}
      const total=Number(usage?.inputTokens||0)+Number(usage?.cacheReadTokens||0)+Number(usage?.cacheWriteTokens||0);
      if(total>=this.contextLimit)this.rotate(job.kind,'usage-threshold');
    }
    this.db.prepare("UPDATE specialist_agents SET status='idle',currentJob=NULL,updatedAt=? WHERE kind=?").run(this.store.now(),job.kind);this.onChange();await this.notify();
  }
  async poll({gather=this.enabled}={}) {
    if(this.stopping)return;
    for(const row of this.db.prepare("SELECT id,kind,taskId FROM specialist_jobs WHERE status='running'").all()){if(!this.agent(row.kind).currentJob)this.db.prepare("UPDATE specialist_agents SET currentJob=?,status='working' WHERE kind=?").run(row.id,row.kind);if(!this.store.task(row.taskId)){this.updateJob(row.id,{status:'queued',taskId:null});this.db.prepare("UPDATE specialist_agents SET currentJob=NULL,status='idle' WHERE kind=?").run(row.kind);}}
    for(const kind of KINDS){const agent=this.agent(kind);if(agent.currentJob){const job=this.job(agent.currentJob),task=job?.taskId?this.store.task(job.taskId):null;if(task && ['completed','failed','interrupted','cancelled'].includes(task.status)){try{await this.finish(job,task);}catch(error){const category=String(error.message).startsWith('交付缺失：')?'deliverable_missing:':'deliverable_invalid:';this.updateJob(job.id,{status:'failed',error:category+error.message,nextRetryAt:null});this.db.prepare("UPDATE specialist_agents SET status='idle',currentJob=NULL WHERE kind=?").run(kind);this.store.error(task.id,label(kind)+'：'+error.message);this.hub.report({...task,status:'failed',error:'交付校验失败：'+error.message},'specialist-invalid:'+job.id);}}}}
    if(this.store.meta('specialists:reload'))return;
    // Older builds could mark a specialist job failed during shutdown before
    // the durable reattach path ran. Reconnect only the exact shutdown marker
    // with a saved DSH session and no interrupted approval; never replay its
    // original task prompt or consume a retry attempt.
    let occupied=this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role!='director' AND status IN ('queued','running','waiting')").get().n;
    if(occupied<this.hub.maxConcurrent)for(const kind of KINDS){
      const agent=this.agent(kind);if(agent.currentJob)continue;
      const row=this.db.prepare("SELECT j.id,j.taskId FROM specialist_jobs j JOIN tasks t ON t.id=j.taskId WHERE j.kind=? AND j.status='failed' AND t.status='interrupted' AND t.engine='dsh' AND t.sessionId IS NOT NULL AND t.sessionId!='' AND t.error=? AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.taskId=t.id AND a.status='recovery_required') ORDER BY j.updatedAt,j.createdAt LIMIT 1").get(kind,'中控曾退出；请显式继续，防止重复执行。');
      if(!row)continue;
      const task=this.store.task(row.taskId);if(!task)continue;
      this.store.transaction(()=>{
        this.updateJob(row.id,{status:'running',error:null,nextRetryAt:null});
        this.db.prepare("UPDATE specialist_agents SET status='working',currentJob=?,sessionId=?,updatedAt=? WHERE kind=?").run(row.id,task.sessionId,this.store.now(),kind);
        this.store.event(task.id,'specialist.session-reattach',{jobId:row.id,sessionId:task.sessionId,reason:'service-interrupted-no-replay'});
      });
      try{this.hub.run({...task,reconnectOnly:true});occupied++;}
      catch(error){
        this.updateJob(row.id,{status:'failed',error:error.message,nextRetryAt:null});
        this.db.prepare("UPDATE specialist_agents SET status='idle',currentJob=NULL,updatedAt=? WHERE kind=?").run(this.store.now(),kind);
        this.store.error(task.id,label(kind)+'原会话接回失败：'+error.message);
      }
    }
    // A recovery may correctly reuse a previously written catalog file when
    // the new DSH turn emits a fresh, task-bound receipt. Revalidate those
    // terminal deliveries instead of sending the task through another model
    // turn merely because the file's bytes and mtime stayed unchanged.
    if(!this.agent('librarian').currentJob){
      const deliveries=this.db.prepare("SELECT id,taskId FROM specialist_jobs WHERE kind='librarian' AND status='failed' AND error='deliverable_missing:交付缺失：交付文件未在本轮更新' ORDER BY updatedAt").all();
      for(const row of deliveries){
        const job=this.job(row.id),task=this.store.task(row.taskId);if(!job||task?.status!=='completed')continue;
        try{await this.finish(job,task);}catch(error){
          this.updateJob(job.id,{status:'failed',error:'deliverable_invalid:'+error.message,nextRetryAt:null});
          this.store.error(task.id,'资料管理员交付校验失败：'+error.message);
          this.hub.report({...task,status:'failed',error:'资料整理交付校验失败：'+error.message},'specialist-invalid:'+job.id);
        }
        if(this.agent('librarian').currentJob)break;
      }
    }
    const ready=this.db.prepare("SELECT id FROM specialist_jobs WHERE kind='maintenance' AND status='ready' ORDER BY createdAt LIMIT 1").get();
    if(ready && !this.db.prepare("SELECT id FROM tasks WHERE status IN ('running','waiting','queued') LIMIT 1").get()){try{if(await this.applyRepair(this.job(ready.id)))return;}catch(error){this.updateJob(ready.id,{status:'failed',error:error.message});this.store.error(null,'维护助手部署暂停：'+error.message);}}
    if(this.store.meta('specialists:manualRecovery'))return;
    if(gather)await this.gather();
    // Older error-triggered maintenance jobs were persisted without the
    // autoGenerated marker. Their transport retry deadline could also be lost
    // when DSH timed out while routing to the workspace. Reconcile only jobs
    // created by the error queue, with a real terminal maintenance task and
    // explicit source error IDs. If those errors have since been cleared,
    // close the stale diagnostic without starting another model turn.
    const legacyMaintenance=this.db.prepare("SELECT id,taskId,attempts,error,payload,dedupe FROM specialist_jobs WHERE kind='maintenance' AND status='failed' AND nextRetryAt IS NULL AND attempts<? AND dedupe LIKE 'error:%' ORDER BY createdAt").all(MAX_AUTO_RETRIES);
    for(const row of legacyMaintenance){
      const task=row.taskId?this.store.task(row.taskId):null;
      if(!task||task.status!=='failed'||task.role!=='maintenance')continue;
      let payload;try{payload=JSON.parse(row.payload);}catch{continue;}
      const ids=Array.isArray(payload.errorIds)?[...new Set(payload.errorIds.filter(id=>typeof id==='string'&&id))]:[];
      if(!ids.length||!String(payload.request||'').startsWith('诊断此错误'))continue;
      const active=this.db.prepare(`SELECT 1 FROM errors WHERE id IN (${ids.map(()=>'?').join(',')}) LIMIT 1`).get(...ids);
      if(!active){
        this.updateJob(row.id,{status:'completed',result:'对应错误已清理，跳过过期自动诊断。',error:null,nextRetryAt:null});
        this.store.event(task.id,'specialist.stale-diagnostic-skipped',{jobId:row.id,errorIds:ids,reason:'legacy-source-errors-cleared'});
        continue;
      }
      const retry=retryClass(row.error);
      if(!retry||!['network','session'].includes(retry))continue;
      const nextRetryAt=retryAt(this.store.now(),row.attempts,retry);
      this.updateJob(row.id,{nextRetryAt});
      this.store.event(task.id,'specialist.retry-scheduled',{jobId:row.id,reason:'legacy-maintenance-transport-failure',retryClass:retry,nextRetryAt});
    }
    // Older builds could clear nextRetryAt after a transport retry was
    // rejected solely because no engine session had been created yet. Recover
    // only failed librarian tasks whose persisted error still classifies as a
    // retryable provider/transport failure, whose original task is terminal,
    // and which are below the normal retry cap. Validation, delivery, approval
    // and cancellation outcomes remain untouched.
    const legacyRetries=this.db.prepare("SELECT id,taskId,attempts,error FROM specialist_jobs WHERE kind='librarian' AND status='failed' AND nextRetryAt IS NULL AND attempts<? ORDER BY createdAt").all(MAX_AUTO_RETRIES);
    for(const job of legacyRetries){
      const task=job.taskId?this.store.task(job.taskId):null,retry=retryClass(job.error);
      if(!task||task.status!=='failed'||!retry)continue;
      if(this.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status='recovery_required' LIMIT 1").get(task.id))continue;
      const nextRetryAt=retryAt(this.store.now(),job.attempts,retry);
      this.updateJob(job.id,{nextRetryAt});
      this.store.event(task.id,'specialist.retry-scheduled',{jobId:job.id,reason:'legacy-transient-failure',retryClass:retry,nextRetryAt});
    }
    const now=Date.parse(this.store.now());
    for(const kind of KINDS){if(this.agent(kind).currentJob)continue;const retry=this.db.prepare("SELECT id,nextRetryAt,attempts FROM specialist_jobs WHERE kind=? AND status='failed' AND nextRetryAt IS NOT NULL AND attempts<? ORDER BY nextRetryAt,createdAt LIMIT 1").get(kind,MAX_AUTO_RETRIES);if(retry && Date.parse(retry.nextRetryAt)<=now){
      if(this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").get().n>=this.hub.maxConcurrent)continue;
      try{await this.resume(retry.id,{automatic:true});}catch(error){if(error.message==='执行席位暂满'||/同时最多运行 \d+ 个执行任务/.test(error.message))continue;this.updateJob(retry.id,{status:'failed',error:error.message,nextRetryAt:null});this.db.prepare("UPDATE specialist_agents SET status='idle',currentJob=NULL,updatedAt=? WHERE kind=?").run(this.store.now(),kind);this.store.error(this.job(retry.id)?.taskId,label(kind)+'自动恢复失败：'+error.message);}
    }}
    for(const kind of KINDS){if(!this.agent(kind).currentJob){const queued=this.db.prepare("SELECT id FROM specialist_jobs WHERE kind=? AND status='queued' ORDER BY createdAt LIMIT 1").get(kind);if(queued)try{await this.start(this.job(queued.id));}catch(error){if(error.message==='执行席位暂满')continue;this.updateJob(queued.id,{status:'failed',error:error.message});this.store.error(null,label(kind)+'启动失败：'+error.message);}}}
    this.onChange();await this.notify();
  }
  async resume(id,{freshSession=false,engine,automatic=false}={}){
    const job=this.job(id);if(!job || job.status!=='failed')throw Error('只能继续已失败的专职任务');
    const task=job.taskId?this.store.task(job.taskId):null;
    if(!task && safePreflightRetry(job)){
      if(this.agent(job.kind).currentJob)throw Error('专职会话正在处理，请等它完成后再重试');
      this.updateJob(job.id,{status:'queued',attempts:job.attempts+1,error:null,nextRetryAt:null});
      this.onChange();return this.job(job.id);
    }
    if(!task)throw Error('该预检失败没有可恢复的任务会话；为避免重复执行副作用，不会自动重放');
    if(['queued','running','waiting'].includes(task.status))throw Error('任务仍在运行或等待中，不能恢复');
    if(task && this.db.prepare("SELECT 1 FROM approvals WHERE taskId=? AND status='recovery_required' LIMIT 1").get(task.id))throw Error('此专职会话中断前正在等待人工选择，请先到原 Agent 会话核对，不能从中枢自动接续。');
    const automaticRetryClass=retryClass(job.error);
    // A librarian may fail before DSH creates its session (for example, an
    // RPC timeout during session/create). Its retry policy already restricts
    // retries to classified transient failures and a bounded attempt count;
    // allow those retries to start a fresh session in the same specialist
    // workspace instead of rejecting them for the missing session ID.
    const sessionlessAutomaticRecovery=automatic && task && (
      (job.kind==='maintenance' && ['network','session'].includes(automaticRetryClass)) ||
      (job.kind==='librarian' && ['network','session','quota','receipt'].includes(automaticRetryClass))
    );
    if(!task?.sessionId && !sessionlessAutomaticRecovery)throw Error('该任务没有可恢复的引擎会话');
    if(this.agent(job.kind).currentJob)throw Error('专职会话正在处理另一个任务，请稍后继续');
    if(engine!==undefined && !['dsh','codex'].includes(engine))throw Error('请选择 dsh 或 codex');
    if(automatic && (!job.nextRetryAt||Date.parse(job.nextRetryAt)>Date.parse(this.store.now())||job.attempts>=MAX_AUTO_RETRIES ||
      !(job.kind==='librarian' ? !!automaticRetryClass : job.kind==='maintenance' && ['network','session'].includes(automaticRetryClass))))throw Error('专职任务自动重试尚未到期、故障类型不允许自动重试或已达到上限');
    if(automatic && (automaticRetryClass==='session' || automaticRetryClass==='receipt' || !task.sessionId))freshSession=true;
    if((freshSession || (engine && engine!==task.engine)) && this.db.prepare("SELECT COUNT(*) n FROM tasks WHERE role NOT IN ('director','coordinator') AND status IN ('running','waiting')").get().n>=this.hub.maxConcurrent)throw Error('执行席位暂满');
    if(engine && engine!==task.engine){freshSession=true;this.store.event(task.id,'specialist.engine-recovery',{parentEngine:task.engine,parentSessionId:task.sessionId,engine});this.store.update(task.id,{engine,model:engine==='codex'?this.hub.codexDefaultModel:null});this.db.prepare('UPDATE specialist_agents SET engine=? WHERE kind=?').run(engine,job.kind);}
    const outputName=job.kind==='librarian'?'catalog.json':'repair.json';
    const prompt='传输中断恢复。先检查本任务工作目录、原输出文件、已完成步骤与检查点，判断上一轮是否已产生有效结果；不要重复已经成功的副作用或覆盖有效交付。若工作尚未完成，只从检查点继续。程序将在收到最终回执后验证交付；不要等待入库结果。\n原任务要求（仅供核对，不代表可从头重做）：\n'+task.prompt+(job.kind==='librarian'?'\n本批唯一允许的文件ID：'+JSON.stringify(job.payload.artifactIds || [])+'。若本批为空，写 entries 为空数组，不复用上一批条目。':'')+`\n最后一行必须严格输出中控 JSON 回执：[HUB-RESULT] {"status":"completed","summary":"简要说明","artifacts":["outputs/${task.id}/${outputName}"]}。不要只写文件路径。`;
    if(freshSession){this.store.event(task.id,'specialist.session-recovery',{parentSessionId:task.sessionId,reason:task.error,previousResult:task.result,automaticTransportRetry:automatic===true});this.rotate(job.kind,automatic&&job.kind==='maintenance'?'transport-recovery':'invalid-request-recovery');this.store.update(task.id,{sessionId:null});}
    const deliveryFile=join(task.cwd,'outputs',task.id,outputName),deliveryBaseline=existsSync(deliveryFile)?{size:lstatSync(deliveryFile).size,mtimeMs:lstatSync(deliveryFile).mtimeMs}:null;
    const deliveryReceiptCursor=Number(this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE taskId=? AND type='task.receipt'").get(task.id).id);
    this.store.transaction(()=>{this.updateJob(id,{status:'running',error:null,nextRetryAt:null,attempts:job.attempts+1,payload:{...job.payload,deliveryBaseline,deliveryReceiptCursor}});this.db.prepare("UPDATE specialist_agents SET status='working',currentJob=?,sessionId=?,updatedAt=? WHERE kind=?").run(id,freshSession?null:task.sessionId,this.store.now(),job.kind);});
    try{if(freshSession)this.hub.run(this.store.task(task.id),prompt+'\n上一轮已知进展：'+String(task.result||'').slice(0,2000));else await this.hub.message(task.id,prompt);}
    catch(error){this.store.transaction(()=>{this.updateJob(id,{status:'failed',error:error.message,nextRetryAt:null});this.db.prepare("UPDATE specialist_agents SET status='idle',currentJob=NULL,updatedAt=? WHERE kind=?").run(this.store.now(),job.kind);});throw error;}
    this.onChange();return this.job(id);
  }
  setEngine(kind,engine){if(!KINDS.includes(kind)||!['dsh','codex'].includes(engine))throw Error('未知专职角色或引擎');const agent=this.agent(kind);if(agent.currentJob)throw Error('请在该专职任务结束后切换引擎');if(agent.engine!==engine){this.rotate(kind,'engine-change');this.db.prepare('UPDATE specialist_agents SET engine=?,updatedAt=? WHERE kind=?').run(engine,this.store.now(),kind);this.onChange();}return this.agent(kind);}
  decorate(records){return records.map(record=>{const row=this.db.prepare('SELECT * FROM artifact_catalog WHERE artifactId=?').get(record.id);return row?{...record,catalog:{title:row.title,summary:row.summary,tags:JSON.parse(row.tags),relatedIds:JSON.parse(row.relatedIds),jobId:row.jobId}}:record;});}
  async search(query){const ids=this.db.prepare('SELECT artifactId FROM artifact_catalog WHERE instr(lower(title || summary || tags),lower(?))>0').all(query);return (await Promise.all(ids.map(row=>this.archive.get(row.artifactId)))).filter(Boolean);}
}
