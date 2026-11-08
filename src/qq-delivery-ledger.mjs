import {redact} from './redact.mjs';
// Delivery evidence belongs to a particular attempt, never to message text.
export function deliveryGroup(key) {const m=/^(.*):part:(\d+)$/.exec(key);return m?{group:m[1],index:Number(m[2])}:{group:key,index:0};}
export function ensureDeliveryLedger(store) {
  const columns=new Set(store.db.prepare('PRAGMA table_info(outbox)').all().map(r=>r.name));
  if(!columns.has('deliveryGroup')){
    store.db.exec('ALTER TABLE outbox ADD COLUMN deliveryGroup TEXT; ALTER TABLE outbox ADD COLUMN partIndex INTEGER');
    store.transaction(()=>{for(const r of store.db.prepare('SELECT id,dedupe FROM outbox').all()){const g=deliveryGroup(r.dedupe);store.db.prepare('UPDATE outbox SET deliveryGroup=?,partIndex=? WHERE id=?').run(g.group,g.index,r.id);}});
  }
  store.db.exec('CREATE INDEX IF NOT EXISTS outbox_group_parts ON outbox(deliveryGroup,partIndex,status); CREATE INDEX IF NOT EXISTS outbox_pending_order ON outbox(status,createdAt)');
  store.db.exec(`CREATE TABLE IF NOT EXISTS qq_delivery_attempts(
    outboxId TEXT NOT NULL,attempt INTEGER NOT NULL,deliveryId TEXT,
    startedAt TEXT NOT NULL,finishedAt TEXT,status TEXT NOT NULL,
    platformMessageId TEXT,error TEXT,PRIMARY KEY(outboxId,attempt))`);
}

export function beginDelivery(store,row) {
  const current=store.db.prepare('SELECT attempts FROM outbox WHERE id=?').get(row.id);
  store.db.prepare(`INSERT INTO qq_delivery_attempts(outboxId,attempt,deliveryId,startedAt,status)
    VALUES(?,?,?,?,'sending')`).run(row.id,current.attempts,row.messageId,store.now());
}

export function finishDelivery(store,row,status,{receipt,error=null}={}) {
  error=error===null?null:redact(String(error)).slice(0,4000);
  store.transaction(()=>{
    const current=store.db.prepare('SELECT attempts FROM outbox WHERE id=?').get(row.id);
    store.notification(row.id,status,error);
    store.db.prepare(`UPDATE qq_delivery_attempts SET status=?,finishedAt=?,platformMessageId=?,error=?
      WHERE outboxId=? AND attempt=?`).run(status,store.now(),receipt?.message_id==null?null:String(receipt.message_id),error,row.id,current.attempts);
    store.event(null,'qq.delivery',{outboxId:row.id,dedupe:row.dedupe,deliveryId:row.messageId,attempt:current.attempts,status,messageId:receipt?.message_id});
  });
}

export function reconcileDeliveryLeases(store) {
  store.db.prepare(`UPDATE qq_delivery_attempts SET status='uncertain',finishedAt=? WHERE status='sending'
    AND EXISTS(SELECT 1 FROM outbox o WHERE o.id=outboxId AND o.status='uncertain')`).run(store.now());
}

export function requireSendReceipt(receipt) {
  const id=receipt?.message_id;
  if(id===undefined||id===null||String(id).trim()===''||String(id)==='0') {
    throw Object.assign(Error('QQ 返回成功但缺少平台消息回执，发送结果无法确认'),{uncertain:true});
  }
  return receipt;
}

export function eligibleNotifications(store,{allowPending=true}={}) {
  const states=allowPending?"'sent','suppressed','pending'":"'sent','suppressed'";
  return store.db.prepare(`SELECT o.* FROM outbox o WHERE o.status='pending'
    AND (SELECT count(*) FROM outbox p WHERE p.deliveryGroup=o.deliveryGroup AND p.partIndex<o.partIndex AND p.status IN (${states}))=o.partIndex
    ORDER BY o.createdAt,o.rowid LIMIT 10`).all();
}
export function predecessorReady(store,row) {
  return store.db.prepare("SELECT count(*) n FROM outbox WHERE deliveryGroup=? AND partIndex<? AND status IN ('sent','suppressed')").get(row.deliveryGroup,row.partIndex).n===row.partIndex;
}
