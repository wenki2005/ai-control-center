import { createHash, randomUUID } from 'node:crypto';
import { SAFE_COMPUTER_TOOLS } from './tool-policy.mjs';
import { INTERACTIVE_COMPUTER_TOOLS, READ_ONLY_COMPUTER_TOOLS, validateComputerAction } from './action-contract.mjs';

export { SAFE_COMPUTER_TOOLS } from './tool-policy.mjs';

const ACTION_STATES = new Set(['awaiting_approval','invoking','verification_required','verified','recovered','failed','denied','blocked','cancelled','uncertain']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function safeSummary(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('A human-readable action summary is required');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function snapshotArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Action arguments must be an object');
  let encoded;
  try { encoded = JSON.stringify(args); } catch { throw new TypeError('Action arguments must be JSON serializable'); }
  if (typeof encoded !== 'string') throw new TypeError('Action arguments must be JSON serializable');
  let snapshot;
  try { snapshot = JSON.parse(encoded); } catch { throw new TypeError('Action arguments must be JSON serializable'); }
  return { snapshot, digest: createHash('sha256').update(encoded).digest('hex') };
}

/** Approval broker for one-shot desktop actions. Arguments/results remain memory-only. */
export class ComputerControlBroker {
  // Each deployment must opt into a subset of the read-only pilot tools.
  constructor({ store, lease, client, allowedTools = [], interactiveAllowed = false, clock = () => Date.now(), leaseTtlMs = 60_000, approvalTtlMs = 10 * 60_000 } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('ComputerControlBroker requires a Store');
    if (!lease || typeof lease.acquire !== 'function' || typeof lease.release !== 'function') throw new TypeError('ComputerControlBroker requires a DesktopLease');
    if (!client || typeof client.call !== 'function') throw new TypeError('ComputerControlBroker requires a CUA client');
    const permitted = interactiveAllowed ? [...READ_ONLY_COMPUTER_TOOLS, ...INTERACTIVE_COMPUTER_TOOLS] : READ_ONLY_COMPUTER_TOOLS;
    if (!Array.isArray(allowedTools) || !allowedTools.length || allowedTools.some((v) => !permitted.includes(v))) {
      throw new TypeError('allowedTools must be a non-empty subset of the explicitly enabled broker tool allowlist');
    }
    if (interactiveAllowed && (!allowedTools.includes('type_text') || !allowedTools.includes('get_window_state'))) throw new TypeError('Interactive mode requires type_text and get_window_state for post-action verification');
    this.store = store;
    this.lease = lease;
    this.client = client;
    this.allowedTools = new Set(allowedTools);
    this.interactiveAllowed = interactiveAllowed;
    this.clock = clock;
    this.leaseTtlMs = leaseTtlMs;
    if (!Number.isSafeInteger(approvalTtlMs) || approvalTtlMs < 1_000 || approvalTtlMs > 24 * 60 * 60_000) throw new TypeError('approvalTtlMs must be between 1 second and 24 hours');
    this.approvalTtlMs = approvalTtlMs;
    this.waiters = new Map();
    this.liveArgs = new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS computer_actions (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL,
      argsDigest TEXT,
      status TEXT NOT NULL, correlationId TEXT NOT NULL UNIQUE, leaseToken TEXT,
      outcome TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS computer_actions_task_created ON computer_actions(taskId,createdAt)`);
    const columns = new Set(store.db.prepare('PRAGMA table_info(computer_actions)').all().map((row) => row.name));
    if (!columns.has('argsDigest')) store.db.exec('ALTER TABLE computer_actions ADD COLUMN argsDigest TEXT');
    this.#recoverAfterRestart();
  }

  #recoverAfterRestart() {
    const now = this.store.now();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE computer_actions SET status='cancelled',outcome=?,updatedAt=? WHERE status='awaiting_approval'")
        .run('中枢重启后原动作参数已不可用；已取消，请重新提交。', now);
      const interrupted = this.store.db.prepare("SELECT id,taskId,leaseToken FROM computer_actions WHERE status IN ('invoking','verification_required')").all();
      for (const row of interrupted) {
        if (row.leaseToken) this.lease.markUncertain(row.taskId, row.leaseToken);
        this.store.db.prepare("UPDATE computer_actions SET status='uncertain',outcome=?,updatedAt=? WHERE id=?")
          .run('中枢重启时动作结果未确认；为避免重复操作已锁定桌面。', now, row.id);
      }
      // Any lease surviving broker construction may belong to a process that
      // exited between input and verification. Never infer that it is idle.
      const current = this.lease.current();
      if (current?.state === 'active') this.lease.markUncertain(current.taskId, current.token);
    });
  }

  submit({ taskId, tool, args = {} }) {
    this.expireStaleApprovals();
    if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) throw new TypeError('A valid taskId is required');
    if (!this.allowedTools.has(tool)) throw new Error('Computer tool is not allowed');
    if (tool === 'type_text' && !this.interactiveAllowed) throw new Error('Interactive computer input is not enabled');
    const summary = validateComputerAction(tool, args);
    const { snapshot, digest } = snapshotArgs(args);
    const safe = safeSummary(summary), id = `ca-${randomUUID()}`, correlationId = randomUUID(), now = this.store.now();
    this.store.db.prepare(`INSERT INTO computer_actions(id,taskId,tool,summary,argsDigest,status,correlationId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,'awaiting_approval',?,?,?)`).run(id, taskId, tool, safe, digest, correlationId, now, now);
    // Never retain the caller's mutable object: approval must authorize the
    // exact argument snapshot that was submitted, even if the producer later
    // reuses or mutates its request object.
    this.liveArgs.set(id, snapshot);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.waiters.set(id, { promise, resolve });
    return this.get(id);
  }

  get(id) {
    const row = this.store.db.prepare('SELECT id,taskId,tool,summary,status,correlationId,outcome,createdAt,updatedAt FROM computer_actions WHERE id=?').get(id);
    if (!row || !ACTION_STATES.has(row.status)) return null;
    if (row.status === 'awaiting_approval') row.expiresAt = this.#expiryFor(row.createdAt);
    return row;
  }
  list({ taskId } = {}) {
    this.expireStaleApprovals();
    const rows = taskId === undefined
      ? this.store.db.prepare('SELECT id FROM computer_actions ORDER BY createdAt DESC').all()
      : this.store.db.prepare('SELECT id FROM computer_actions WHERE taskId=? ORDER BY createdAt DESC').all(taskId);
    return rows.map(({ id }) => this.get(id));
  }

  #expiryFor(createdAt) {
    const timestamp = Date.parse(createdAt);
    return Number.isFinite(timestamp) ? new Date(timestamp + this.approvalTtlMs).toISOString() : null;
  }

  expireStaleApprovals() {
    const nowMs = this.clock();
    const now = this.store.now();
    const rows = this.store.db.prepare("SELECT id,createdAt FROM computer_actions WHERE status='awaiting_approval'").all();
    const expired = [];
    for (const row of rows) {
      const expiry = this.#expiryFor(row.createdAt);
      if (!expiry || nowMs >= Date.parse(expiry)) {
        this.liveArgs.delete(row.id);
        expired.push(row.id);
      }
    }
    if (expired.length) this.store.transaction(() => {
      const update = this.store.db.prepare("UPDATE computer_actions SET status='cancelled',outcome=?,updatedAt=? WHERE id=? AND status='awaiting_approval'");
      for (const id of expired) update.run('审批已过期，动作已取消；如仍需要，请重新提交。', now, id);
    });
    for (const id of expired) {
      const waiter = this.waiters.get(id);
      if (waiter) { waiter.resolve(this.get(id)); this.waiters.delete(id); }
    }
    return expired.length;
  }

  wait(actionId) {
    const existing = this.waiters.get(actionId);
    if (existing) return existing.promise;
    return Promise.resolve(this.get(actionId));
  }

  async approve(actionId, { onResult } = {}) {
    this.expireStaleApprovals();
    const action = this.get(actionId);
    if (!action) throw new Error('Computer action not found');
    if (action.status === 'invoking') return this.wait(actionId);
    if (action.status !== 'awaiting_approval') return action; // idempotent duplicate answer
    const args = this.liveArgs.get(actionId);
    const persistedDigest = this.store.db.prepare('SELECT argsDigest FROM computer_actions WHERE id=?').get(actionId)?.argsDigest;
    if (!args || !persistedDigest || createHash('sha256').update(JSON.stringify(args)).digest('hex') !== persistedDigest) {
      return this.#finish(actionId, 'uncertain', '动作参数与提交审批时不一致；为避免操作错误已停止。');
    }
    const leaseToken = randomUUID();
    const acquired = this.lease.acquire(action.taskId, { ttlMs: this.leaseTtlMs, token: leaseToken });
    if (!acquired) return this.#finish(actionId, 'blocked', '桌面正被其他动作占用或等待安全恢复；稍后确认桌面空闲后重新提交。');
    const changed = this.store.db.prepare("UPDATE computer_actions SET status='invoking',leaseToken=?,updatedAt=? WHERE id=? AND status='awaiting_approval'")
      .run(leaseToken, this.store.now(), actionId).changes === 1;
    if (!changed) {
      this.lease.release(action.taskId, leaseToken, { verifiedQuiescent: true });
      return this.get(actionId);
    }
    this.liveArgs.delete(actionId);
    let rawResult;
    try {
      rawResult = await this.client.call(action.tool, snapshotArgs(args).snapshot);
    } catch {
      this.lease.markUncertain(action.taskId, leaseToken);
      return this.#finish(actionId, 'uncertain', '调用中断或结果不确定；不会自动重试。');
    }
    if(rawResult?.isError===true) {
      if(action.tool==='type_text') {
        this.lease.markUncertain(action.taskId,leaseToken);
        return this.#finish(actionId,'uncertain','输入工具返回错误，不能确认是否已有文字送达；桌面已锁定，请检查目标窗口。');
      }
      if(!this.lease.release(action.taskId,leaseToken,{verifiedQuiescent:true})) {
        this.lease.markUncertain(action.taskId,leaseToken);
        return this.#finish(actionId,'uncertain','只读检查返回错误且桌面租约状态不一致；需要人工检查。');
      }
      rawResult=undefined;
      return this.#finish(actionId,'failed','只读检查未成功；没有发送输入操作，请核对目标后重新申请。');
    }
    if (action.tool === 'type_text') {
      let observed;
      try { observed = await this.client.call('get_window_state', { pid: args.pid, window_id: args.window_id }); }
      catch {
        this.lease.markUncertain(action.taskId, leaseToken);
        return this.#finish(actionId, 'uncertain', '文本输入后无法重新读取目标窗口；为避免重复已锁定桌面。');
      }
      const leaseAfterObserve=this.lease.current();
      if(observed?.isError===true || leaseAfterObserve?.state!=='active' || leaseAfterObserve.token!==leaseToken || leaseAfterObserve.taskId!==action.taskId) {
        this.lease.markUncertain(action.taskId,leaseToken);
        return this.#finish(actionId,'uncertain','文本输入后窗口复核未能确认；为避免重复已锁定桌面。');
      }
      this.store.db.prepare("UPDATE computer_actions SET status='verification_required',outcome=?,updatedAt=? WHERE id=? AND status='invoking'")
        .run('文本已送达，等待你检查目标窗口并确认结果。',this.store.now(),actionId);
      let lostLease=false;
      const renewer=setInterval(()=>{try{if(!this.lease.renew(action.taskId,leaseToken,{ttlMs:this.leaseTtlMs}))lostLease=true;}catch{lostLease=true;}},Math.max(1000,Math.floor(this.leaseTtlMs/3)));
      try {
        if(typeof onResult==='function') await onResult({action,result:observed});
      } catch {
        // The text was already sent. Leave the action and desktop lease pending for manual review.
      } finally { clearInterval(renewer); }
      if(lostLease) {
        this.lease.markUncertain(action.taskId,leaseToken);
        return this.#finish(actionId,'uncertain','窗口复核期间桌面租约失效；请检查桌面后手动恢复。');
      }
      return this.get(actionId);
    }
    const lease = this.lease.current();
    const persistedAction = this.get(actionId);
    if (persistedAction?.status !== 'invoking' || lease?.state !== 'active' || lease.token !== leaseToken || lease.taskId !== action.taskId || !this.lease.release(action.taskId, leaseToken, { verifiedQuiescent: true })) {
      this.lease.markUncertain(action.taskId, leaseToken);
      return this.#finish(actionId, 'uncertain', '只读检查已返回，但桌面租约状态不一致；需要人工检查。');
    }
    let outcome = '只读检查已完成。';
    if (typeof onResult === 'function') {
      try {
        await onResult({ action, result: rawResult });
        outcome = '只读检查结果已交给本机视觉会话。';
      } catch {
        outcome = '只读检查已完成，但暂时无法启动视觉分析。';
      }
    }
    // The callback can forward the result to a local model, but this broker
    // never persists or returns raw screen content.
    rawResult = undefined;
    return this.#finish(actionId, 'verified', outcome);
  }

  deny(actionId) { return this.#answerWithoutCall(actionId, 'denied', '用户拒绝了此动作。'); }
  cancel(actionId) { return this.#answerWithoutCall(actionId, 'cancelled', '动作已取消。'); }

  #answerWithoutCall(actionId, status, outcome) {
    const action = this.get(actionId);
    if (!action) throw new Error('Computer action not found');
    if (action.status !== 'awaiting_approval') return action;
    this.liveArgs.delete(actionId);
    return this.#finish(actionId, status, outcome);
  }

  verify(actionId, { verified, summary } = {}) {
    const action = this.get(actionId);
    if (!action) throw new Error('Computer action not found');
    if (action.status !== 'verification_required') return action;
    const outcome = safeSummary(summary || (verified ? '已确认动作结果。' : '结果未通过验证。'));
    const row = this.store.db.prepare('SELECT leaseToken FROM computer_actions WHERE id=?').get(actionId);
    if (verified !== true) {
      this.lease.markUncertain(action.taskId, row.leaseToken);
      return this.#finish(actionId, 'uncertain', outcome);
    }
    if (!this.lease.release(action.taskId, row.leaseToken, { verifiedQuiescent: true })) {
      this.lease.markUncertain(action.taskId, row.leaseToken);
      return this.#finish(actionId, 'uncertain', '验证完成但桌面租约状态不一致；需人工检查。');
    }
    return this.#finish(actionId, 'verified', outcome);
  }

  recover(actionId, { operatorConfirmedQuiescent = false } = {}) {
    const action=this.get(actionId);
    if(!action)throw new Error('Computer action not found');
    if(action.status==='recovered')return action;
    if(action.status!=='uncertain')return action;
    if(operatorConfirmedQuiescent!==true)throw new Error('必须先由用户检查并确认桌面已经空闲');
    const token=this.store.db.prepare('SELECT leaseToken FROM computer_actions WHERE id=?').get(actionId)?.leaseToken;
    if(!token || !this.lease.recoverUncertain(action.taskId,token,{operatorConfirmedQuiescent:true}))return action;
    return this.#finish(actionId,'recovered','用户已人工检查桌面空闲，操作锁已释放；原动作不会自动重试。');
  }

  #finish(id, status, outcome) {
    const safe = safeSummary(outcome);
    this.store.db.prepare("UPDATE computer_actions SET status=?,outcome=?,updatedAt=? WHERE id=? AND status IN ('awaiting_approval','invoking','verification_required','uncertain')")
      .run(status, safe, this.store.now(), id);
    const action = this.get(id), waiter = this.waiters.get(id);
    if (waiter) { waiter.resolve(action); this.waiters.delete(id); }
    return action;
  }
}
