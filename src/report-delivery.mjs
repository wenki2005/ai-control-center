// Persists a narrator report and the exact chunks Hub.notification placed in
// the durable outbox. Hub.notification enqueues synchronously before it kicks
// its asynchronous sender, so the manifest can be captured in this transaction.
export function ensureReportDeliverySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS report_notifications(
    key TEXT PRIMARY KEY,taskId TEXT,body TEXT NOT NULL,manifest TEXT,status TEXT NOT NULL DEFAULT 'queued',createdAt TEXT,updatedAt TEXT
  ); CREATE TABLE IF NOT EXISTS report_requests(
    key TEXT PRIMARY KEY,taskId TEXT NOT NULL,request TEXT NOT NULL,kind TEXT NOT NULL,situation TEXT NOT NULL,artifacts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,nextAttemptAt TEXT,leaseUntil TEXT,updatedAt TEXT NOT NULL
  )`);
  const cols=new Set(db.prepare('PRAGMA table_info(report_notifications)').all().map(row=>row.name));
  if(!cols.has('taskId'))db.exec('ALTER TABLE report_notifications ADD COLUMN taskId TEXT');
  if(!cols.has('manifest'))db.exec('ALTER TABLE report_notifications ADD COLUMN manifest TEXT');
  if(!cols.has('status'))db.exec("ALTER TABLE report_notifications ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'");
  if(!cols.has('createdAt'))db.exec('ALTER TABLE report_notifications ADD COLUMN createdAt TEXT');
  if(!cols.has('updatedAt'))db.exec('ALTER TABLE report_notifications ADD COLUMN updatedAt TEXT');
}

export function persistNamedRequest(store,{key,task,kind,situation,artifacts=[]}) {
  ensureReportDeliverySchema(store.db);
  const request=JSON.stringify(task);
  store.db.prepare(`INSERT OR IGNORE INTO report_requests(key,taskId,request,kind,situation,artifacts,status,attempts,updatedAt)
    VALUES(?,?,?,?,?,?,'pending',0,?)`).run(key,String(task.id),request,String(kind||'status-update'),String(situation||''),JSON.stringify(artifacts),store.now());
  return store.db.prepare('SELECT * FROM report_requests WHERE key=?').get(key);
}

export function claimNamedRequest(store,key,{leaseMs=120000}={}) {
  const now=store.now(),leaseUntil=new Date(Date.parse(now)+leaseMs).toISOString();
  const previous=store.db.prepare("SELECT status,attempts,leaseUntil FROM report_requests WHERE key=?").get(key);
  if(previous?.status==='running'&&(!previous.leaseUntil||previous.leaseUntil<=now)&&Number(previous.attempts||0)>=2) {
    store.db.prepare("UPDATE report_requests SET status='uncertain',leaseUntil=NULL,updatedAt=? WHERE key=?").run(now,key);
    return null;
  }
  const changed=store.db.prepare(`UPDATE report_requests SET status='running',leaseUntil=?,attempts=attempts+CASE WHEN status='running' THEN 1 ELSE 0 END,updatedAt=? WHERE key=? AND
    ((status='pending' AND (nextAttemptAt IS NULL OR nextAttemptAt<=?)) OR (status='running' AND (leaseUntil IS NULL OR leaseUntil<=?)))`)
    .run(leaseUntil,now,key,now,now).changes;
  return changed?store.db.prepare('SELECT * FROM report_requests WHERE key=?').get(key):null;
}

export function settleNamedRequest(store,key,status='queued') {
  store.db.prepare('UPDATE report_requests SET status=?,leaseUntil=NULL,nextAttemptAt=NULL,updatedAt=? WHERE key=?').run(status,store.now(),key);
}

export function releaseNamedRequest(store,key) {
  store.db.prepare("UPDATE report_requests SET status='pending',leaseUntil=NULL,nextAttemptAt=NULL,updatedAt=? WHERE key=? AND status='running'")
    .run(store.now(),key);
}

export function failNamedRequest(store,key,error,{maxAttempts=3}={}) {
  const row=store.db.prepare('SELECT attempts FROM report_requests WHERE key=?').get(key);
  if(!row)return null;
  const attempts=Number(row.attempts||0)+1,status=attempts>=maxAttempts?'uncertain':'pending';
  const delay=Math.min(60000,1000*2**attempts),next=status==='pending'?new Date(Date.now()+delay).toISOString():null;
  store.db.prepare('UPDATE report_requests SET status=?,attempts=?,nextAttemptAt=?,leaseUntil=NULL,updatedAt=? WHERE key=?')
    .run(status,attempts,next,store.now(),key);
  return {attempts,status,error:String(error?.message||error||'').slice(0,300)};
}

export function pendingNamedRequests(store) {
  ensureReportDeliverySchema(store.db);
  return store.db.prepare(`SELECT * FROM report_requests WHERE
    (status='pending' AND (nextAttemptAt IS NULL OR nextAttemptAt<=?)) OR status='running' ORDER BY updatedAt LIMIT 20`)
    .all(store.now());
}

export function getReportDelivery(store,key) {
  ensureReportDeliverySchema(store.db);
  return store.db.prepare('SELECT * FROM report_notifications WHERE key=?').get(key)||null;
}

export function reconcileNamedReportDelivery(store,key) {
  const row=getReportDelivery(store,key);
  if(!row)return null;
  let manifest=JSON.parse(row.manifest||'[]');
  if(!manifest.length) {
    const prefix=`${key}:part:`;
    manifest=store.db.prepare('SELECT id,dedupe,status FROM outbox WHERE substr(dedupe,1,?)=? ORDER BY rowid')
      .all(prefix.length,prefix).filter(part=>/^\d+$/.test(part.dedupe.slice(prefix.length)));
    if(manifest.length)store.db.prepare('UPDATE report_notifications SET manifest=? WHERE key=?').run(JSON.stringify(manifest.map(({id,dedupe,status})=>({id,dedupe,status}))),key);
  }
  const statuses=manifest.map(part=>store.db.prepare('SELECT status FROM outbox WHERE id=?').get(part.id)?.status||'missing');
  let status='queued';
  if(!statuses.length||statuses.includes('missing')||statuses.includes('uncertain'))status='uncertain';
  else if(statuses.every(value=>value==='sent'))status='sent';
  else if(statuses.every(value=>value==='sent'||value==='suppressed')&&statuses.includes('suppressed'))status='suppressed';
  else if(statuses.includes('sent')||statuses.includes('suppressed'))status='partial';
  store.db.prepare('UPDATE report_notifications SET status=?,updatedAt=? WHERE key=?').run(status,store.now(),key);
  return {...row,status};
}

export function reconcileAllNamedReportDeliveries(store) {
  ensureReportDeliverySchema(store.db);
  for(const row of store.db.prepare('SELECT key FROM report_notifications').all())reconcileNamedReportDelivery(store,row.key);
}

export function enqueueNamedReportDelivery({store,hub,key,dedupe,text,taskId=null}) {
  ensureReportDeliverySchema(store.db);
  return persistDelivery({store,hub,key,text,taskId,dedupe,table:'report_notifications'});
}

export function enqueueReportDelivery({store,hub,key,text,taskId=null}) {
  return persistDelivery({store,hub,key,text,taskId,dedupe:`task-report:${key}`,table:'return_reports'});
}

function persistDelivery({store,hub,key,text,taskId,dedupe,table}) {
  const db=store.db,base=`task-report:${key}`;
  const tableName=table;
  const baseDedupe=tableName==='return_reports'?base:String(dedupe);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current=db.prepare(`SELECT body,manifest FROM ${tableName} WHERE key=?`).get(key);
    if(current?.body) {
      const manifest=JSON.parse(current.manifest||'[]');
      db.exec('COMMIT');
      return {body:current.body,manifest,reused:true};
    }
    const body=String(text);
    // Save the first body before queuing. If notification throws, the full
    // transaction (including this write and Hub's outbox inserts) rolls back.
    if(tableName==='return_reports')db.prepare('UPDATE return_reports SET body=?,updatedAt=? WHERE key=?').run(body,store.now(),key);
    else db.prepare('INSERT INTO report_notifications(key,taskId,body,manifest,status,createdAt,updatedAt) VALUES(?,?,?,\'[]\',\'queued\',?,?)')
      .run(key,taskId,body,store.now(),store.now());
    const delivered=hub.notification(body,baseDedupe,{deferNotify:true});
    const prefix=baseDedupe+':part:';
    const rows=Array.isArray(delivered)?delivered.map(({id,dedupe,status})=>({id,dedupe,status})):
      db.prepare("SELECT id,dedupe,status FROM outbox WHERE substr(dedupe,1,?)=? ORDER BY rowid").all(prefix.length,prefix)
        .filter(row=>/^\d+$/.test(row.dedupe.slice(prefix.length)));
    if(!rows.length)throw new Error('汇报正文未写入 QQ outbox');
    if(rows.some((row,index)=>row.dedupe!==`${prefix}${index}`))throw new Error('汇报分段清单不完整');
    const manifest=rows.map(({id,dedupe,status})=>({id,dedupe,status}));
    if(tableName==='return_reports')db.prepare("UPDATE return_reports SET status='queued',manifest=?,updatedAt=? WHERE key=?")
      .run(JSON.stringify(manifest),store.now(),key);
    else db.prepare("UPDATE report_notifications SET status='queued',manifest=?,updatedAt=? WHERE key=?")
      .run(JSON.stringify(manifest),store.now(),key);
    db.exec('COMMIT');
    void hub.notify?.();
    return {body,manifest,reused:false};
  } catch(error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function reportChunkRows(store,key) {
  const prefix=`task-report:${key}:part:`;
  return store.db.prepare('SELECT id,dedupe,status FROM outbox WHERE substr(dedupe,1,?)=? ORDER BY rowid')
    .all(prefix.length,prefix).filter(row=>/^\d+$/.test(row.dedupe.slice(prefix.length)));
}
