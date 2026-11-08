import { createHash, randomUUID } from 'node:crypto';
import { redact } from '../redact.mjs';

const ACTIVE = new Set(['queued', 'running', 'waiting']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Durable, append-only user additions to an existing task. This module records
 * intent only; the hub owns safe scheduling and engine calls. */
export class TaskAmendments {
  constructor({ store }) {
    if (!store?.db) throw new TypeError('TaskAmendments requires a Store');
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_amendments (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL, sessionId TEXT, revision INTEGER NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, idempotencyKey TEXT UNIQUE,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, appliedAt TEXT,
      UNIQUE(taskId, revision)
    ); CREATE INDEX IF NOT EXISTS task_amendments_pending ON task_amendments(taskId,status,revision)`);
  }

  append(taskId, text, { idempotencyKey = null } = {}) {
    const task = this.store.task(taskId);
    if (!task) throw Error('找不到任务');
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw Error('补充内容需要 1–20000 个字符');
    if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200)) throw Error('幂等键无效');
    if (idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM task_amendments WHERE idempotencyKey=?').get(idempotencyKey);
      if (existing) {
        if (existing.taskId !== taskId) throw Error('幂等键已用于另一项任务');
        return { ...existing, duplicate: true, disposition: existing.status === 'applied' ? 'applied' : 'pending' };
      }
    }
    const now = this.store.now();
    const revision = Number(this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 revision FROM task_amendments WHERE taskId=?').get(taskId).revision);
    const row = { id: `a-${randomUUID()}`, taskId, sessionId: task.sessionId || null, revision,
      text: String(redact(text.trim())), status: 'pending', idempotencyKey, createdAt: now, updatedAt: now };
    try {
      this.db.prepare(`INSERT INTO task_amendments
        (id,taskId,sessionId,revision,text,status,idempotencyKey,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id,row.taskId,row.sessionId,row.revision,row.text,row.status,row.idempotencyKey,row.createdAt,row.updatedAt);
    } catch (error) {
      if (idempotencyKey) {
        const existing = this.db.prepare('SELECT * FROM task_amendments WHERE idempotencyKey=?').get(idempotencyKey);
        if (existing?.taskId === taskId) return { ...existing, duplicate: true, disposition: existing.status === 'applied' ? 'applied' : 'pending' };
      }
      throw error;
    }
    this.store.event(taskId, 'task.amendment-recorded', { amendmentId: row.id, revision, sessionId: row.sessionId, status: 'pending' });
    const disposition = task.status === 'queued' ? 'queued-merged' : ACTIVE.has(task.status) ? 'pending-after-run' : TERMINAL.has(task.status) ? 'ready-followup' : 'pending';
    return { ...row, disposition, accepted: true };
  }

  list(taskId, { status } = {}) {
    return (status
      ? this.db.prepare('SELECT * FROM task_amendments WHERE taskId=? AND status=? ORDER BY revision').all(taskId,status)
      : this.db.prepare('SELECT * FROM task_amendments WHERE taskId=? ORDER BY revision').all(taskId))
      .map(row => ({ ...row, sessionId: row.sessionId || null }));
  }

  pending(taskId) { return this.list(taskId, { status: 'pending' }); }
  hasPending(taskId) { return !!this.db.prepare("SELECT 1 FROM task_amendments WHERE taskId=? AND status='pending' LIMIT 1").get(taskId); }

  /** Claim pending additions only when caller has confirmed the original run is terminal. */
  claim(taskId, { allowQueued = false } = {}) {
    const task = this.store.task(taskId);
    if (!task || (ACTIVE.has(task.status) && !(allowQueued && task.status==='queued'))) return [];
    const rows = this.pending(taskId);
    if (!rows.length) return [];
    const now = this.store.now();
    const update = this.db.prepare("UPDATE task_amendments SET status='claimed',updatedAt=? WHERE id=? AND status='pending'");
    for (const row of rows) update.run(now,row.id);
    return rows.map(row => ({ ...row, status: 'claimed' }));
  }

  markApplied(ids) {
    const now = this.store.now(), update = this.db.prepare("UPDATE task_amendments SET status='applied',appliedAt=?,updatedAt=? WHERE id=? AND status='claimed'");
    for (const id of ids) update.run(now,now,id);
  }
  release(ids) {
    const now = this.store.now(), update = this.db.prepare("UPDATE task_amendments SET status='pending',updatedAt=? WHERE id=? AND status='claimed'");
    for (const id of ids) update.run(now,id);
  }
  format(rows) {
    return rows.map(row => `补充要求（第${row.revision}次，明确纠正以此为准）：\n${row.text}`).join('\n\n');
  }
}

export function amendmentIdempotencyKey(taskId, sourceMessageId) {
  return createHash('sha256').update(`${taskId}\0${sourceMessageId}`).digest('hex');
}
