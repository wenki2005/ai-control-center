import { createHash } from 'node:crypto';
import{parseStopRequest}from'./hub/stop-request.mjs';

// Control phrases remain separate turns, especially confirmation and exit.
export function isImmediateQqInput(text) {
  if(parseStopRequest(text))return true;
  if(/^(?:菜单|功能菜单|帮助菜单|开启语音|切回语音|切回文字|关闭语音)$/u.test(String(text).trim()))return true;
  return /^(?:\/(?:hub|中枢)(?:\s|$)|(?:确认|取消|算了|不退出|不关闭|不停止|停止|停下|停掉|停一下|退出|关闭|结束|直连|进入直连|进入修复窗口|修复窗口|紧急修复|DSH直连|进入DSH直连|接管|返回原助手|保留原入口|选择\s|答复\s|answer\s|stop\b|cancel\b)|(?:请|麻烦|帮我)\s*(?:停止|停掉|终止))/iu.test(String(text).trim());
}

export function expectsIncomingMedia(text) {
  return /(?:我|等下|等会|稍等|待会|马上|准备|给你|发给你|我会).{0,18}(?:发|传|给).{0,10}(?:图|照片|截图|文件|文档)|(?:图|照片|截图|文件|文档).{0,10}(?:等下|稍后|马上).{0,8}(?:发|传)/u.test(String(text));
}
const hasMedia=record=>{try{return JSON.parse(record.attachments||'[]').length>0;}catch{return false;}};

/** Durable short input window. Meaning is interpreted by the supervisor, not a second classifier. */
export class QqIncomingBatches {
  constructor({store,deliver,onError=()=>{},windowMs=2000,maxWaitMs=8000,mediaGraceMs=8000,attachmentWaitMs=120000}) {
    Object.assign(this,{store,deliver,onError,windowMs,maxWaitMs,mediaGraceMs,attachmentWaitMs});
    this.db=store.db;this.timers=new Map();this.running=new Set();this.operations=new Map();this.closed=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS qq_input_batches(
      id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,readyAt INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qq_input_batch_parts(
      messageId TEXT PRIMARY KEY,batchId TEXT NOT NULL REFERENCES qq_input_batches(id));`);
    // Original inbox records and stable message keys survive a service reload.
    this.db.prepare("UPDATE qq_input_batches SET status='pending' WHERE status='delivering'").run();
    // A failed delivery can leave its inbox parts pending with a future retry
    // time. Re-arm the durable batch itself; relying on the inbox poll loses
    // it because that poll intentionally hides not-yet-due messages.
    for(const batch of this.db.prepare("SELECT * FROM qq_input_batches WHERE status IN ('pending','retry') ORDER BY createdAt").all())this.arm(batch);
  }
  parts(id) {
    return this.db.prepare(`SELECT i.* FROM qq_input_batch_parts p JOIN inbox i ON i.messageId=p.messageId
      WHERE p.batchId=? ORDER BY i.createdAt,i.rowid`).all(id);
  }
  contains(messageId) {return !!this.db.prepare('SELECT 1 FROM qq_input_batch_parts WHERE messageId=?').get(messageId);}
  schedule(record) {
    const existing=this.db.prepare('SELECT b.* FROM qq_input_batch_parts p JOIN qq_input_batches b ON b.id=p.batchId WHERE p.messageId=?').get(record.messageId);
    if(existing){if(['pending','retry'].includes(existing.status))this.arm(existing);return;}
    const now=Date.now();
    let batch=this.db.prepare("SELECT * FROM qq_input_batches WHERE status='pending' AND readyAt>? ORDER BY createdAt DESC LIMIT 1").get(now);
    if(batch) {
      const parts=this.parts(batch.id);
      const chars=parts.reduce((n,p)=>n+p.text.length+1,record.text.length);
      const images=parts.reduce((n,p)=>n+JSON.parse(p.attachments||'[]').length,JSON.parse(record.attachments||'[]').length);
      if(chars>18000||images>4||parts.length>=12){this.db.prepare('UPDATE qq_input_batches SET readyAt=? WHERE id=?').run(now,batch.id);this.arm({...batch,readyAt:now});batch=null;}
    }
    if(!batch) {
      const id='qq-burst:'+createHash('sha256').update(record.messageId).digest('hex').slice(0,24);
      batch={id,createdAt:now,readyAt:now+this.windowMs,status:'pending'};
      this.db.prepare('INSERT INTO qq_input_batches VALUES(?,?,?,?)').run(id,now,batch.readyAt,batch.status);
    } else {
      batch.readyAt=Math.min(now+this.windowMs,batch.createdAt+this.maxWaitMs);
      this.db.prepare('UPDATE qq_input_batches SET readyAt=? WHERE id=?').run(batch.readyAt,batch.id);
    }
    this.db.prepare('INSERT INTO qq_input_batch_parts VALUES(?,?)').run(record.messageId,batch.id);
    const members=this.parts(batch.id),media=members.some(hasMedia),waiting=members.some(p=>expectsIncomingMedia(p.text));
    if(media||waiting){
      batch.readyAt=media?Math.min(now+this.mediaGraceMs,batch.createdAt+this.attachmentWaitMs+this.mediaGraceMs):Math.min(now+this.attachmentWaitMs,batch.createdAt+this.attachmentWaitMs);
      this.db.prepare('UPDATE qq_input_batches SET readyAt=? WHERE id=?').run(batch.readyAt,batch.id);
    }
    this.arm(batch);
  }
  arm(batch) {
    if(this.closed||this.running.has(batch.id))return;
    clearTimeout(this.timers.get(batch.id));
    const timer=setTimeout(()=>{this.timers.delete(batch.id);void this.run(batch.id).catch(this.onError);},Math.max(0,batch.readyAt-Date.now()));
    timer.unref?.();this.timers.set(batch.id,timer);
  }
  run(id) {
    if(this.operations.has(id))return this.operations.get(id);
    const operation=this.deliverBatch(id);
    this.operations.set(id,operation);
    const clear=()=>this.operations.delete(id);
    void operation.then(clear,clear);return operation;
  }
  async deliverBatch(id) {
    if(this.closed||this.running.has(id))return;
    clearTimeout(this.timers.get(id));this.timers.delete(id);this.running.add(id);
    try {
      const parts=this.parts(id).filter(p=>p.status==='pending');
      if(!parts.length){this.db.prepare("UPDATE qq_input_batches SET status='done' WHERE id=?").run(id);return;}
      this.db.prepare("UPDATE qq_input_batches SET status='delivering' WHERE id=?").run(id);
      const record={...parts[0],text:parts.map(p=>p.text).join('\n'),
        attachments:JSON.stringify(parts.flatMap(p=>JSON.parse(p.attachments||'[]'))),
        memberIds:parts.map(p=>p.messageId),originalMessages:parts.map(p=>({text:p.text,createdAt:p.createdAt}))};
      await this.deliver(record);
      const pending=this.parts(id).filter(p=>p.status==='pending');
      const readyAt=pending.length?Math.max(Date.now()+1000,...pending.map(p=>Date.parse(p.nextAttemptAt)||0)):Date.now();
      this.db.prepare('UPDATE qq_input_batches SET status=?,readyAt=? WHERE id=?').run(pending.length?'retry':'done',readyAt,id);
    } catch(error) {
      this.db.prepare("UPDATE qq_input_batches SET status='retry',readyAt=? WHERE id=?").run(Date.now()+5000,id);
      throw error;
    } finally {this.running.delete(id);}
  }
  async flush() {
    for(const row of this.db.prepare("SELECT id FROM qq_input_batches WHERE status IN ('pending','retry') ORDER BY createdAt").all())await this.run(row.id);
    await this.settled();
  }
  async settled() {await Promise.allSettled([...this.operations.values()]);}
  close() {this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();}
}
