import { basename, dirname, join, resolve } from 'node:path';

const ENGINES = new Set(['dsh', 'codex', 'workbuddy']);

function validEngine(engine) {
  return typeof engine === 'string' && ENGINES.has(engine);
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = resolve(left), b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function metadataFor(store, engine, cwd) {
  let value;
  const slot = slotForPath(engine, cwd);
  try { value = JSON.parse(store?.meta?.(`worker:fixed:${engine}${slot === 1 ? '' : `:${slot}`}`) || (slot === 1 ? store?.meta?.(`worker:fixed:${engine}`) : null) || 'null'); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.taskId !== 'string' || !value.taskId
    || !samePath(value.cwd, cwd)) return null;
  return value;
}

export function fixedWorkerSlotCount(engine) {
  if (!validEngine(engine)) throw new TypeError('Unsupported fixed worker engine');
  // Keep existing DSH work on its established slot and add one isolated
  // session for parallel work. Codex/WorkBuddy remain single-session workers.
  return engine === 'dsh' ? 2 : 1;
}

function slotCwd(workspaceRoot, engine, slot) {
  return join(workspaceRoot, '_workers', slot === 1 ? engine : `${engine}-${slot}`);
}

function slotForPath(engine, cwd) {
  if (typeof cwd !== 'string' || !cwd) return 1;
  const leaf = basename(cwd).toLowerCase();
  const match = new RegExp(`^${engine}-(\\d+)$`, 'u').exec(leaf);
  return match ? Number(match[1]) : 1;
}

/** Return the dedicated workspace and only the validated remembered session for this engine. */
export function fixedWorkerContext({ store, engine, workspaceRoot, slot = 1 } = {}) {
  if (!validEngine(engine)) throw new TypeError('Unsupported fixed worker engine');
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new TypeError('workspaceRoot is required');
  if (!Number.isInteger(slot) || slot < 1 || slot > fixedWorkerSlotCount(engine)) throw new TypeError('Invalid fixed worker slot');
  const cwd = slotCwd(workspaceRoot, engine, slot);
  const saved = metadataFor(store, engine, cwd);
  const context = { cwd, sessionId: saved?.sessionId ?? null, sourceTaskId: saved?.taskId ?? null };
  Object.defineProperty(context, 'slot', { value: slot, enumerable: false });
  return context;
}

/** Choose an idle slot first; if all are busy, choose the one with the shortest queue. */
export function selectFixedWorkerContext({ store, engine, workspaceRoot } = {}) {
  const contexts = Array.from({ length: fixedWorkerSlotCount(engine) }, (_, index) => fixedWorkerContext({ store, engine, workspaceRoot, slot: index + 1 }));
  const loads = contexts.map(context => store?.db?.prepare(`SELECT COUNT(*) AS n FROM tasks t
    WHERE t.role='worker' AND t.engine=? AND t.cwd=? AND t.status IN ('queued','running','waiting')
      AND EXISTS (SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker')`).get(engine, context.cwd)?.n ?? 0);
  return contexts[loads.indexOf(Math.min(...loads))] ?? contexts[0];
}

export function fixedWorkerHasPending({ store, engine, slot, workspaceRoot } = {}) {
  if (!validEngine(engine) || !store?.db || !workspaceRoot || !Number.isInteger(slot)) return false;
  const cwd = slotCwd(workspaceRoot, engine, slot);
  return Boolean(store.db.prepare(`SELECT 1 FROM tasks t
    WHERE t.role='worker' AND t.engine=? AND t.cwd=? AND t.status IN ('queued','running','waiting')
      AND EXISTS (SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker') LIMIT 1`).get(engine, cwd));
}

export function fixedWorkerSlotForTask(task, workspaceRoot) {
  if (!task?.engine || !task?.cwd || !validEngine(task.engine)) return 1;
  for (let slot = 1; slot <= fixedWorkerSlotCount(task.engine); slot++) {
    if (samePath(task.cwd, slotCwd(workspaceRoot, task.engine, slot))) return slot;
  }
  return 1;
}

/** Remember a session only when Hub explicitly marked this worker as fixed-slot work. */
export function rememberFixedWorker({ store, task, sessionId } = {}) {
  if (!store?.db || !task || task.role !== 'worker' || !validEngine(task.engine)
    || typeof task.id !== 'string' || !task.id
    || typeof sessionId !== 'string' || !sessionId) return false;
  const marker = store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.fixed-worker' LIMIT 1").get(task.id);
  if (!marker) return false;
  const cwd = typeof task.cwd === 'string' ? task.cwd : '';
  // The task itself must already be in the dedicated slot. Never adopt a user session.
  const slot = slotForPath(task.engine, cwd);
  if (!cwd || ![task.engine, `${task.engine}-${slot}`].includes(basename(cwd).toLowerCase()) || basename(dirname(cwd)).toLowerCase() !== '_workers' || slot > fixedWorkerSlotCount(task.engine)) return false;
  store.meta(`worker:fixed:${task.engine}${slot === 1 ? '' : `:${slot}`}`, JSON.stringify({ sessionId, cwd, taskId: task.id }));
  return true;
}

/** True only while a marked fixed-slot worker for this engine is active. */
export function fixedWorkerBusy({ store, engine, slot = null, excludingTaskId = null, workspaceRoot = null } = {}) {
  if (!validEngine(engine) || !store?.db) return false;
  if (slot !== null && (!Number.isInteger(slot) || slot < 1 || slot > fixedWorkerSlotCount(engine))) return false;
  const sql = `SELECT 1 FROM tasks t
    WHERE t.role='worker' AND t.engine=? AND t.status IN ('running','waiting')
      AND (? IS NULL OR t.id<>?)
      AND EXISTS (SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker')`;
  const row = slot === null ? store.db.prepare(`${sql} LIMIT 1`).get(engine, excludingTaskId, excludingTaskId)
    : workspaceRoot ? store.db.prepare(`${sql} AND t.cwd=? LIMIT 1`).get(engine, excludingTaskId, excludingTaskId, slotCwd(workspaceRoot, engine, slot))
      : null;
  return Boolean(row);
}
