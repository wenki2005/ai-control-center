import {EventJournal} from './observability/event-journal.mjs';
import {ensureDeliveryLedger,deliveryGroup} from './qq-delivery-ledger.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { redact } from './redact.mjs';
import { companionFtsQuery, companionSearchDocument } from './companion-search.mjs';

// OneBot does not expose a client supplied idempotency key for
// send_private_msg. Keep a stable local id for every logical notification so
// retries can be correlated and deduplicated in our own durable outbox.
export function stableNotificationId(dedupe) {
  return 'qqm-' + createHash('sha256').update(String(dedupe)).digest('hex').slice(0, 24);
}

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 10000 });
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, engine TEXT NOT NULL, prompt TEXT NOT NULL,
        cwd TEXT NOT NULL, projectPath TEXT, sessionId TEXT, model TEXT, status TEXT NOT NULL, result TEXT, error TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, runVersion INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'worker');
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),
        requestId TEXT NOT NULL,kind TEXT NOT NULL,question TEXT NOT NULL,options TEXT,raw TEXT,
        status TEXT NOT NULL,answer TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(taskId,requestId));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,taskId TEXT,type TEXT NOT NULL,data TEXT,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errors(id TEXT PRIMARY KEY,taskId TEXT,message TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT,role TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_context_exclusions(chatId INTEGER PRIMARY KEY REFERENCES chat(id),source TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE VIEW IF NOT EXISTS companion_chat AS SELECT c.* FROM chat c
        WHERE NOT EXISTS(SELECT 1 FROM chat_context_exclusions x WHERE x.chatId=c.id);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,dedupe TEXT UNIQUE,text TEXT NOT NULL,status TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachment_outbox(id TEXT PRIMARY KEY,dedupe TEXT UNIQUE,artifactId TEXT NOT NULL,
        filePath TEXT NOT NULL,image INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,attempts INTEGER DEFAULT 0,
        error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound(messageId TEXT PRIMARY KEY,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(messageId TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,attachments TEXT NOT NULL DEFAULT '[]',attempts INTEGER NOT NULL DEFAULT 0,lastError TEXT,nextAttemptAt TEXT);
      CREATE TABLE IF NOT EXISTS collection_jobs(taskId TEXT PRIMARY KEY,status TEXT NOT NULL,error TEXT,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS director_handoffs(
        id TEXT PRIMARY KEY,parentSessionId TEXT NOT NULL,childSessionId TEXT,sourceTaskId TEXT,targetTaskId TEXT,
        reason TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
      );
    `);
    const columns=new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(row=>row.name));
    if(!columns.has('runVersion'))this.db.exec('ALTER TABLE tasks ADD COLUMN runVersion INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('role'))this.db.exec("ALTER TABLE tasks ADD COLUMN role TEXT NOT NULL DEFAULT 'worker'");
    if(!columns.has('projectPath'))this.db.exec('ALTER TABLE tasks ADD COLUMN projectPath TEXT');
    if(!this.db.prepare('PRAGMA table_info(chat)').all().some(column=>column.name==='retractedAt'))this.db.exec('ALTER TABLE chat ADD COLUMN retractedAt TEXT');
    const inboxColumns=new Set(this.db.prepare('PRAGMA table_info(inbox)').all().map(row=>row.name));
    if(!inboxColumns.has('attachments'))this.db.exec("ALTER TABLE inbox ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    if(!inboxColumns.has('attempts'))this.db.exec('ALTER TABLE inbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if(!inboxColumns.has('lastError'))this.db.exec('ALTER TABLE inbox ADD COLUMN lastError TEXT');
    if(!inboxColumns.has('nextAttemptAt'))this.db.exec('ALTER TABLE inbox ADD COLUMN nextAttemptAt TEXT');
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_task_type_id ON events(taskId,type,id);
      CREATE INDEX IF NOT EXISTS events_type_id ON events(type,id);
      CREATE INDEX IF NOT EXISTS events_created_type ON events(createdAt,type);
      CREATE INDEX IF NOT EXISTS tasks_role_status_created ON tasks(role,status,createdAt);
      CREATE INDEX IF NOT EXISTS tasks_session_role_created ON tasks(sessionId,role,createdAt)`);
    const outboxColumns=new Set(this.db.prepare('PRAGMA table_info(outbox)').all().map(row=>row.name));
    if(!outboxColumns.has('messageId'))this.db.exec('ALTER TABLE outbox ADD COLUMN messageId TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS outbox_message_id_unique ON outbox(messageId)');
    for(const row of this.db.prepare('SELECT id,dedupe FROM outbox WHERE messageId IS NULL OR messageId=\'\'').all()) {
      this.db.prepare('UPDATE outbox SET messageId=? WHERE id=?').run(stableNotificationId(row.dedupe),row.id);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS events_task_type_time ON events(taskId,type,createdAt)');
    this.db.exec('CREATE INDEX IF NOT EXISTS tasks_session_role_created ON tasks(sessionId,role,createdAt); CREATE INDEX IF NOT EXISTS events_task_type_id ON events(taskId,type,id)');
    this.db.exec("CREATE INDEX IF NOT EXISTS events_dispatch_child ON events(json_extract(data,'$.workerId')) WHERE type='director.worker-created' AND json_valid(data)");
    this.db.exec('CREATE INDEX IF NOT EXISTS tasks_created_order ON tasks(createdAt DESC)');
    ensureDeliveryLedger(this);
    this.#initializeCompanionSearch();
  }
  #initializeCompanionSearch() {
    this.companionSearchAvailable=false;
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS companion_chat_fts USING fts5(tokens)');
      if(this.meta('companion:chat-fts-version')!=='1') {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec('DELETE FROM companion_chat_fts');
          const insert=this.db.prepare('INSERT INTO companion_chat_fts(rowid,tokens) VALUES(?,?)');
          for(const row of this.db.prepare('SELECT id,text FROM chat ORDER BY id').iterate()) {
            const tokens=companionSearchDocument(row.text);
            if(tokens)insert.run(row.id,tokens);
          }
          this.meta('companion:chat-fts-version','1');
          this.db.exec('COMMIT');
        } catch(error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }
      this.companionSearchAvailable=true;
    } catch {
      this.companionSearchAvailable=false;
    }
  }
  now() { return new Date().toISOString(); }
  createTask({id = 't-' + randomUUID().slice(0, 8), engine, prompt, cwd, projectPath=null, model,role='worker',sessionId}) {
    const now = this.now();
    this.db.prepare('INSERT INTO tasks(id,engine,prompt,cwd,projectPath,model,status,createdAt,updatedAt,role,sessionId) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, engine, redact(prompt), cwd, projectPath || null, model || null, 'queued', now, now,role,sessionId || null);
    return this.task(id);
  }
  task(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) || null; }
  tasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC LIMIT 200').all(); }
  taskSummaries() { return this.db.prepare('SELECT id,engine,role,prompt,model,status,sessionId,cwd,projectPath,createdAt,updatedAt FROM tasks ORDER BY createdAt DESC LIMIT 200').all(); }
  allTasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC').all(); }
  update(id, patch) {
    const allowed = new Set(['sessionId','status','result','error','prompt','model','runVersion','engine','projectPath']);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.task(id);
    this.db.prepare(`UPDATE tasks SET ${entries.map(([k]) => k + '=?').join(',')},updatedAt=? WHERE id=?`)
      .run(...entries.map(([,v]) => redact(v) ?? null), this.now(), id);
    return this.task(id);
  }
  event(taskId, type, data) {
    this.eventJournal ||= new EventJournal(this.db);
    this.eventJournal.write(taskId,type,redact(data),this.now());
  }

  error(taskId, message) {
    const record = { id:randomUUID(),taskId:taskId || null,message:redact(String(message)).slice(0,4000),createdAt:this.now() };
    this.db.prepare('INSERT INTO errors VALUES(?,?,?,?)').run(record.id,record.taskId,record.message,record.createdAt); return record;
  }
  errors() { return this.db.prepare('SELECT * FROM errors ORDER BY createdAt DESC LIMIT 100').all(); }
  allErrors() { return this.db.prepare('SELECT * FROM errors ORDER BY createdAt DESC').all(); }
  clearErrors(ids=[],{reason='cleared'}={}) {
    const values=[...new Set(ids.filter(Boolean).map(String))];
    if(!values.length)return 0;
    const placeholders=values.map(()=>'?').join(',');
    return this.transaction(()=>{
      const records=this.db.prepare(`SELECT id,taskId,message FROM errors WHERE id IN (${placeholders})`).all(...values);
      const now=this.now();
      const audit=this.db.prepare('INSERT INTO events(taskId,type,data,createdAt) VALUES(?,?,?,?)');
      for(const record of records) audit.run(record.taskId,'error.cleared',JSON.stringify(redact({errorId:record.id,reason:String(reason),message:record.message})),now);
      return this.db.prepare(`DELETE FROM errors WHERE id IN (${placeholders})`).run(...values).changes;
    });
  }
  say(role,text,{source='companion'}={}) {
    const safe=redact(String(text)).slice(0,20000);
    const result=this.db.prepare('INSERT INTO chat(role,text,createdAt) VALUES(?,?,?)').run(role,safe,this.now());
    if(source!=='companion')this.db.prepare('INSERT INTO chat_context_exclusions(chatId,source,createdAt) VALUES(?,?,?)').run(result.lastInsertRowid,String(source),this.now());
    if(this.companionSearchAvailable) {
      try {
        const tokens=companionSearchDocument(safe);
        if(tokens)this.db.prepare('INSERT INTO companion_chat_fts(rowid,tokens) VALUES(?,?)').run(result.lastInsertRowid,tokens);
      } catch {
        this.companionSearchAvailable=false;
      }
    }
    return Number(result.lastInsertRowid);
  }
  searchChat(query,{limit=80}={}) {
    if(!this.companionSearchAvailable)return [];
    const match=companionFtsQuery(query);
    if(!match)return [];
    const bounded=Math.max(1,Math.min(200,Number(limit)||80));
    try {
      return this.db.prepare(`SELECT c.id,c.role,c.text,c.createdAt,bm25(companion_chat_fts) AS searchRank
        FROM companion_chat_fts JOIN chat c ON c.id=companion_chat_fts.rowid
        WHERE companion_chat_fts MATCH ? AND NOT EXISTS(SELECT 1 FROM chat_context_exclusions x WHERE x.chatId=c.id)
        ORDER BY bm25(companion_chat_fts),c.id DESC LIMIT ?`).all(match,bounded);
    } catch {
      this.companionSearchAvailable=false;
      return [];
    }
  }
  chat() { return this.db.prepare('SELECT * FROM (SELECT * FROM chat ORDER BY id DESC LIMIT 100) ORDER BY id').all(); }
  conversationChat() { return this.db.prepare('SELECT * FROM (SELECT * FROM companion_chat WHERE retractedAt IS NULL ORDER BY id DESC LIMIT 100) ORDER BY id').all(); }
  approval(taskId, event) {
    const requestId=String(event.requestId), now=this.now();
    this.db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      'a-'+randomUUID().slice(0,8),taskId,requestId,event.kind || 'question',redact(event.question || '请选择'),
      JSON.stringify(redact(event.options || [])),JSON.stringify(redact(event.raw || {})),'pending',null,now,now);
    return this.decodeApproval(this.db.prepare('SELECT * FROM approvals WHERE taskId=? AND requestId=?').get(taskId,requestId));
  }
  decodeApproval(row) { return row ? {...row, options:JSON.parse(row.options || '[]'),raw:JSON.parse(row.raw || '{}')} : null; }
  getApproval(id) { return this.decodeApproval(this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id)); }
  approvals() { return this.db.prepare('SELECT * FROM approvals ORDER BY createdAt DESC LIMIT 200').all().map(r=>this.decodeApproval(r)); }
  setApproval(id,status,answer=null) { this.db.prepare('UPDATE approvals SET status=?,answer=?,updatedAt=? WHERE id=?').run(status,redact(answer),this.now(),id); }
  recover({outboxGraceMs=0}={}) {
    // Queued tasks have not reached an engine yet, so leave them queued for
    // normal dispatch after startup. Only sessions that were actually active
    // need reconnecting to their saved engine session.
    const rows=this.db.prepare("SELECT * FROM tasks WHERE status IN ('running','waiting')").all();
    for(const task of rows) {
      this.update(task.id,{status:'interrupted',error:'中控曾退出；请显式继续，防止重复执行。'});
      this.db.prepare("UPDATE approvals SET status='recovery_required',updatedAt=? WHERE taskId=? AND status IN ('pending','resolving')").run(this.now(),task.id);
    }
    if(outboxGraceMs>0)this.reclaimStaleNotifications(outboxGraceMs);
    else {
      const changed=this.db.prepare("UPDATE outbox SET status='uncertain',error=?,updatedAt=? WHERE status='sending'")
        .run('中枢重启时 QQ 发送结果未确认，为避免重复已停止自动重发。',this.now()).changes;
      if(changed)this.error(null,`中枢重启时有 ${changed} 条 QQ 消息发送结果不确定，已停止自动重发以避免重复。`);
    }
    if(outboxGraceMs>0)this.reclaimStaleAttachments(outboxGraceMs);
    else {
      const changed=this.db.prepare("UPDATE attachment_outbox SET status='uncertain',error=?,updatedAt=? WHERE status='sending'")
        .run('中枢重启时 QQ 附件发送结果未确认，为避免重复已停止自动重发。',this.now()).changes;
      if(changed)this.error(null,`中枢重启时有 ${changed} 个 QQ 附件发送结果不确定，已停止自动重发以避免重复。`);
    }
    return rows;
  }
  enqueue(text,dedupe) {
    const now=this.now();
    if(!String(dedupe || '').trim())throw Error('QQ 通知必须提供稳定去重键');
    const messageId=stableNotificationId(dedupe),group=deliveryGroup(String(dedupe));
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,dedupe,text,status,createdAt,updatedAt,messageId,deliveryGroup,partIndex) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),String(dedupe),redact(String(text)).slice(0,1800),'pending',now,now,messageId,group.group,group.index);
    return this.db.prepare('SELECT * FROM outbox WHERE dedupe=?').get(String(dedupe));
  }
  pendingNotifications() { return this.db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY createdAt,rowid LIMIT 10").all(); }
  claimNotification(id) {
    return this.db.prepare("UPDATE outbox SET status='sending',attempts=attempts+1,error=NULL,updatedAt=? WHERE id=? AND status='pending'")
      .run(this.now(),id).changes===1;
  }
  enqueueAttachment({artifactId,filePath,image=false,dedupe}) {
    const now=this.now(),key=String(dedupe || `artifact:${artifactId}`);
    if(!String(artifactId || '').trim() || !String(filePath || '').trim())throw Error('附件队列缺少文件信息');
    this.db.prepare('INSERT OR IGNORE INTO attachment_outbox(id,dedupe,artifactId,filePath,image,status,attempts,error,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),key,String(artifactId),String(filePath),image?1:0,'pending',0,null,now,now);
    return this.db.prepare('SELECT * FROM attachment_outbox WHERE dedupe=?').get(key);
  }
  pendingAttachments() { return this.db.prepare("SELECT * FROM attachment_outbox WHERE status='pending' ORDER BY createdAt,rowid LIMIT 10").all(); }
  claimAttachment(id) {
    return this.db.prepare("UPDATE attachment_outbox SET status='sending',attempts=attempts+1,error=NULL,updatedAt=? WHERE id=? AND status='pending'")
      .run(this.now(),id).changes===1;
  }
  reclaimStaleNotifications(maxAgeMs=120000) {
    const cutoff=new Date(Date.now()-Math.max(0,maxAgeMs)).toISOString();
    const changed=this.db.prepare("UPDATE outbox SET status='uncertain',error=?,updatedAt=? WHERE status='sending' AND updatedAt<?")
      .run('发送结果未确认，已停止自动重发以避免重复',this.now(),cutoff).changes;
    if(changed)this.error(null,`有 ${changed} 条 QQ 消息发送结果长时间未确认，已停止自动重发以避免重复。`);
    return changed;
  }
  reclaimStaleAttachments(maxAgeMs=120000) {
    const cutoff=new Date(Date.now()-Math.max(0,maxAgeMs)).toISOString();
    const changed=this.db.prepare("UPDATE attachment_outbox SET status='uncertain',error=?,updatedAt=? WHERE status='sending' AND updatedAt<?")
      .run('附件发送结果未确认，已停止自动重发以避免重复',this.now(),cutoff).changes;
    if(changed)this.error(null,`有 ${changed} 个 QQ 附件发送结果长时间未确认，已停止自动重发以避免重复。`);
    return changed;
  }
  notification(id,status,error=null) {
    const safeError=error===null?null:redact(String(error)).slice(0,4000);
    this.db.prepare('UPDATE outbox SET status=?,attempts=attempts+?,error=?,updatedAt=? WHERE id=? AND status<>\'sent\'')
      .run(status,status==='sending'?1:0,safeError,this.now(),id);
  }
  attachment(id,status,error=null) {
    const safeError=error===null?null:redact(String(error)).slice(0,4000);
    this.db.prepare('UPDATE attachment_outbox SET status=?,attempts=attempts+?,error=?,updatedAt=? WHERE id=? AND status<>\'sent\'')
      .run(status,status==='sending'?1:0,safeError,this.now(),id);
  }
  inbound(id) {
    const result=this.db.prepare('INSERT OR IGNORE INTO inbound VALUES(?,?)').run(String(id),this.now());
    return result.changes>0;
  }
  saveIncoming(id,text,attachments=[]) {const now=this.now(),safe=Array.isArray(attachments)?attachments.slice(0,4).filter(value=>typeof value==='string' || (value&&typeof value==='object'&&typeof value.path==='string')).map(value=>typeof value==='string'?value:{path:String(value.path),originalName:String(value.originalName||''),size:Number(value.size)||0,mimeType:String(value.mimeType||'application/octet-stream'),extension:String(value.extension||''),isImage:value.isImage===true,source:String(value.source||'qq'),messageId:String(value.messageId||id),receivedAt:String(value.receivedAt||now)}):[];this.db.prepare('INSERT OR IGNORE INTO inbox(messageId,text,status,createdAt,updatedAt,attachments) VALUES(?,?,?,?,?,?)').run(String(id),redact(text),'pending',now,now,JSON.stringify(redact(safe)));return this.db.prepare('SELECT * FROM inbox WHERE messageId=?').get(String(id));}
  incomingDone(id){this.db.prepare("UPDATE inbox SET status='done',lastError=NULL,nextAttemptAt=NULL,updatedAt=? WHERE messageId=?").run(this.now(),String(id));}
  retryIncoming(id,error,{maxAttempts=12,delayMs=5000}={}) {
    const row=this.db.prepare('SELECT attempts FROM inbox WHERE messageId=?').get(String(id));
    if(!row)return null;
    const attempts=Number(row.attempts||0)+1,now=this.now(),failed=attempts>=maxAttempts;
    const nextAttemptAt=failed?null:new Date(Date.parse(now)+Math.max(1000,Number(delayMs)||5000)).toISOString();
    this.db.prepare("UPDATE inbox SET status=?,attempts=?,lastError=?,nextAttemptAt=?,updatedAt=? WHERE messageId=?")
      .run(failed?'failed':'pending',attempts,redact(String(error||'')).slice(0,4000),nextAttemptAt,now,String(id));
    return {attempts,status:failed?'failed':'pending',nextAttemptAt};
  }
  failIncoming(id,error){this.db.prepare("UPDATE inbox SET status='failed',lastError=?,nextAttemptAt=NULL,updatedAt=? WHERE messageId=?").run(redact(String(error||'')).slice(0,4000),this.now(),String(id));}
  pendingIncoming(){return this.db.prepare("SELECT * FROM inbox WHERE status='pending' AND (nextAttemptAt IS NULL OR nextAttemptAt<=?) ORDER BY createdAt").all(this.now());}
  transaction(action) {this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  collection(taskId,status,error=null) {this.db.prepare('INSERT INTO collection_jobs VALUES(?,?,?,?) ON CONFLICT(taskId) DO UPDATE SET status=excluded.status,error=excluded.error,updatedAt=excluded.updatedAt').run(taskId,status,redact(error),this.now());}
  pendingCollections() {return this.db.prepare("SELECT * FROM collection_jobs WHERE status='pending'").all();}
  createDirectorHandoff({id='h-'+randomUUID().slice(0,12),parentSessionId,sourceTaskId=null,reason,payload,status='prepared'}) {
    const now=this.now();
    this.db.prepare('INSERT INTO director_handoffs(id,parentSessionId,sourceTaskId,reason,payload,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,String(parentSessionId),sourceTaskId,redact(String(reason)),JSON.stringify(redact(payload)),status,now,now);
    return this.directorHandoff(id);
  }
  directorHandoff(id) {
    const row=this.db.prepare('SELECT * FROM director_handoffs WHERE id=?').get(id);
    return row?{...row,payload:JSON.parse(row.payload)}:null;
  }
  directorHandoffs() {return this.db.prepare('SELECT id FROM director_handoffs ORDER BY createdAt').all().map(({id})=>this.directorHandoff(id));}
  linkDirectorHandoff(id,{childSessionId,targetTaskId,status='started',attempts}={}) {
    if(!this.directorHandoff(id))throw Error('找不到主管会话接续记录');
    this.db.prepare('UPDATE director_handoffs SET childSessionId=COALESCE(?,childSessionId),targetTaskId=COALESCE(?,targetTaskId),status=?,attempts=COALESCE(?,attempts),updatedAt=? WHERE id=?')
      .run(childSessionId||null,targetTaskId||null,status,attempts??null,this.now(),id);
    return this.directorHandoff(id);
  }
  meta(key,value){if(value!==undefined)this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;}
  close() { this.eventJournal?.close();this.db.close(); }
}
