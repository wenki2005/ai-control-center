import { deliveryGroup } from './qq-delivery-ledger.mjs';

const PROGRESS = new Set(['progress-update', 'director-delay']);

export function isProgressReportKind(kind) {
  return PROGRESS.has(String(kind || ''));
}

export function progressRequestIsCurrent(store, task) {
  if (!task || typeof task.id!=='string' || !Number.isSafeInteger(task.runVersion)) return false;
  const current = store.db.prepare('SELECT status,runVersion FROM tasks WHERE id=?').get(String(task.id));
  return current?.status === 'running' && Number(current.runVersion) === Number(task.runVersion);
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
  const audit = JSON.stringify({ key, reason: 'task-finished-or-run-changed' });
  if (!db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='report.progress-suppressed' AND data=? LIMIT 1").get(request.taskId,audit)) store.event(request.taskId, 'report.progress-suppressed', { key, reason: 'task-finished-or-run-changed' });
  return { allowed: false, suppressed: true, reason: 'task-finished-or-run-changed' };
}
