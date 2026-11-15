import { deliveryGroup } from './qq-delivery-ledger.mjs';

const PROGRESS = new Set(['progress-update', 'director-delay','work-companion']);
const PRESENCE_REPLY_GAP_MS = 90_000;

// A genuine reply or progress report takes priority over optional company.
// Exclude presence's own outbox group so it cannot suppress its own chunks.
export function workPresenceYieldsToReply(store,{now=Date.parse(store.now()),taskId,runVersion}={}) {
  const since=new Date(now-PRESENCE_REPLY_GAP_MS).toISOString();
  const recent=store.db.prepare(`SELECT 1 FROM outbox
    WHERE status IN ('pending','sending','sent') AND createdAt>=? AND updatedAt>=?
    AND coalesce(deliveryGroup,dedupe) NOT LIKE 'work-companion:%'
    AND coalesce(deliveryGroup,dedupe) NOT LIKE 'director-wait:%' LIMIT 1`)
    .get(new Date(now-10*60_000).toISOString(),since);
  if(recent)return true;
  return !!(taskId&&store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='report_requests' AND type='table'").get()&&
    store.db.prepare(`SELECT 1 FROM report_requests WHERE taskId=? AND kind IN ('progress-update','milestone')
      AND status IN ('pending','running','queued','partial') AND updatedAt>=?
      AND json_extract(request,'$.runVersion')=? LIMIT 1`).get(taskId,since,runVersion));
}

export function isProgressReportKind(kind) {
  return PROGRESS.has(String(kind || ''));
}

export function progressRequestIsCurrent(store, task) {
  if (!task || typeof task.id!=='string' || !Number.isSafeInteger(task.runVersion)) return false;
  const current = store.db.prepare('SELECT status,runVersion FROM tasks WHERE id=?').get(String(task.id));
  if(current?.status!=='running'||Number(current.runVersion)!==Number(task.runVersion))return false;
  if(task.presenceAnchorUserId!==undefined){
    const latest=store.db.prepare("SELECT id FROM companion_chat WHERE role='user' AND retractedAt IS NULL ORDER BY id DESC LIMIT 1").get()?.id||0;
    if(latest!==task.presenceAnchorUserId||store.meta('companion:work-presence-enabled')==='false'||store.meta('companion:proactive-enabled')==='false'||store.meta('companion:active-persona-id')!==task.presencePersonaId)return false;
    if(task.role==='director'&&String(store.db.prepare('SELECT result FROM tasks WHERE id=?').get(task.id)?.result||'').trim())return false;
    if(workPresenceYieldsToReply(store,{taskId:task.id,runVersion:task.runVersion}))return false;
  }
  return true;
}

export function progressDeliveryGate(store, row) {
  const db = store?.db;
  if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_requests'").get()) return { allowed: true };
  const key = row?.deliveryGroup || deliveryGroup(String(row?.dedupe || '')).group;
  const request = key ? db.prepare('SELECT * FROM report_requests WHERE key=?').get(key) : null;
  if (!request || !isProgressReportKind(request.kind)) return { allowed: true };
  let snapshot;
  try { snapshot = JSON.parse(request.request); } catch { snapshot = null; }
  if (snapshot?.id===request.taskId&&progressRequestIsCurrent(store, snapshot)) return { allowed: true };
  const group = row?.deliveryGroup || key;
  const now = store.now?.() || new Date().toISOString();
  if (group && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox'").get()) {
    db.prepare("UPDATE outbox SET status='suppressed',updatedAt=? WHERE deliveryGroup=? AND status='pending'").run(now, group);
  }
  db.prepare("UPDATE report_requests SET status='suppressed',leaseUntil=NULL,nextAttemptAt=NULL,updatedAt=? WHERE key=? AND status<>'suppressed'").run(now, key);
  const reason=request.kind==='work-companion'?'work-companion-no-longer-current':'task-finished-or-run-changed';
  const audit = JSON.stringify({key,reason});
  if (!db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='report.progress-suppressed' AND data=? LIMIT 1").get(request.taskId,audit)) store.event(request.taskId, 'report.progress-suppressed', {key,reason});
  return {allowed:false,suppressed:true,reason};
}
