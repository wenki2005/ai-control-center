import { basename, dirname, join, resolve } from 'node:path';
import { workTopicScore } from '../hub/work-handoff.mjs';

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
  // DSH has a separate fourth seat for the phone. Ordinary seats are lazy.
  return engine === 'workbuddy' ? 1 : 3;
}

export function isFixedWorkerSlot(engine,slot) {
  return validEngine(engine)&&Number.isInteger(slot)&&slot>=1&&slot<=fixedWorkerSlotCount(engine)+(engine==='dsh'?1:0);
}

// Only explicit assignment phrases in the user's request can pin a seat.
export function requestedFixedWorker(text) {
  const request=String(text??'').normalize('NFKC');
  const match=/^\s*(?:(?:请|麻烦|帮我)\s*)?(?:交给|派给|发给|用|让)\s*(?:(DSH|Codex|WorkBuddy)\s*(?:的\s*)?固定(?:工作)?(?:会话|席位)\s*(?:第\s*)?([一二三]|\d+)?(?:\s*(?:号|席))?|(手机专用(?:会话|席位)))/iu.exec(request);
  if(!match)return null;
  if(match[3])return {engine:'dsh',slot:4};
  const engine=match[1].toLowerCase();
  if(engine==='dsh'&&!match[2])return null;
  return {engine,slot:({'一':1,'二':2,'三':3}[match[2]]??Number(match[2]||1))};
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
  if (!isFixedWorkerSlot(engine,slot)) throw new TypeError('Invalid fixed worker slot');
  const cwd = slotCwd(workspaceRoot, engine, slot);
  const saved = metadataFor(store, engine, cwd);
  const context = { cwd, sessionId: saved?.sessionId ?? null, sourceTaskId: saved?.taskId ?? null };
  Object.defineProperty(context, 'slot', { value: slot, enumerable: false });
  return context;
}

/** Choose an idle slot first; if all are busy, choose the one with the shortest queue. */
export function selectFixedWorkerContext({ store, engine, workspaceRoot, preferredSlot, prompt='' } = {}) {
  if(engine==='dsh'&&preferredSlot===4)return fixedWorkerContext({store,engine,workspaceRoot,slot:4});
  const contexts = Array.from({ length: fixedWorkerSlotCount(engine) }, (_, index) => fixedWorkerContext({ store, engine, workspaceRoot, slot: index + 1 }));
  const loads = contexts.map(context => store?.db?.prepare(`SELECT COUNT(*) AS n FROM tasks t
    WHERE t.role='worker' AND t.engine=? AND t.cwd=? AND t.status IN ('queued','running','waiting')
      AND EXISTS (SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker')`).get(engine, context.cwd)?.n ?? 0);
  const minimum=Math.min(...loads),preferred=contexts.findIndex(context=>context.slot===preferredSlot);
  const affinity=contexts.map((context,index)=>({index,score:prompt&&loads[index]===0&&context.sourceTaskId?workTopicScore(prompt,store.task(context.sourceTaskId)||{}):0})).sort((a,b)=>b.score-a.score);
  if(affinity[0]?.score>=0.55)return contexts[affinity[0].index];
  if(preferred>=0&&loads[preferred]===minimum)return contexts[preferred];
  return contexts[loads.indexOf(minimum)] ?? contexts[0];
}

export function fixedWorkerHasPending({ store, engine, slot, workspaceRoot } = {}) {
  if (!store?.db || !workspaceRoot || !isFixedWorkerSlot(engine,slot)) return false;
  const cwd = slotCwd(workspaceRoot, engine, slot);
  return Boolean(store.db.prepare(`SELECT 1 FROM tasks t
    WHERE t.role='worker' AND t.engine=? AND t.cwd=? AND t.status IN ('queued','running','waiting')
      AND EXISTS (SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker') LIMIT 1`).get(engine, cwd));
}

export function fixedWorkerSlotForTask(task, workspaceRoot) {
  if (!task?.engine || !task?.cwd || !validEngine(task.engine)) return 1;
  const slot=slotForPath(task.engine,task.cwd);
  if (isFixedWorkerSlot(task.engine,slot)&&samePath(task.cwd,slotCwd(workspaceRoot,task.engine,slot))) return slot;
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
  if (!cwd || ![task.engine, `${task.engine}-${slot}`].includes(basename(cwd).toLowerCase()) || basename(dirname(cwd)).toLowerCase() !== '_workers' || (slot > fixedWorkerSlotCount(task.engine) && !(task.engine==='dsh'&&slot===4))) return false;
  store.meta(`worker:fixed:${task.engine}${slot === 1 ? '' : `:${slot}`}`, JSON.stringify({ sessionId, cwd, taskId: task.id }));
  return true;
}

/** True only while a marked fixed-slot worker for this engine is active. */
export function fixedWorkerBusy({ store, engine, slot = null, excludingTaskId = null, workspaceRoot = null } = {}) {
  if (!validEngine(engine) || !store?.db) return false;
  if (slot !== null && !isFixedWorkerSlot(engine,slot)) return false;
  const sql = `SELECT 1 FROM tasks t
    WHERE t.role='worker' AND t.engine=? AND t.status IN ('running','waiting')
      AND (? IS NULL OR t.id<>?)
      AND EXISTS (SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.fixed-worker')`;
  const row = slot === null ? store.db.prepare(`${sql} LIMIT 1`).get(engine, excludingTaskId, excludingTaskId)
    : workspaceRoot ? store.db.prepare(`${sql} AND t.cwd=? LIMIT 1`).get(engine, excludingTaskId, excludingTaskId, slotCwd(workspaceRoot, engine, slot))
      : null;
  return Boolean(row);
}

