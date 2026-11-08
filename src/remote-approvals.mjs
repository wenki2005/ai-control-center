import { createHash } from 'node:crypto';
import { redact } from './redact.mjs';

const TTL = 5 * 60_000;
const METHODS = new Set([
  'commandExecution/requestApproval', 'item/commandExecution/requestApproval',
  'fileChange/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput',
]);
const stable = value => JSON.stringify(value);

export class RemoteApprovals {
  constructor({ store, clock = () => Date.now() }) {
    if (!store?.db) throw new TypeError('store.db is required');
    this.store = store;
    this.clock = clock;
    store.db.exec(`CREATE TABLE IF NOT EXISTS remote_native_approvals(
      id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, engine TEXT NOT NULL, sessionId TEXT NOT NULL,
      method TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, answer TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, answeredAt INTEGER
    ); CREATE INDEX IF NOT EXISTS remote_native_approvals_device_status ON remote_native_approvals(deviceId,status,createdAt);`);
  }

  #now() { const n = typeof this.clock === 'function' ? this.clock() : this.clock.now(); return Number(n); }
  #expire() { this.store.db.prepare("UPDATE remote_native_approvals SET status='expired' WHERE status='pending' AND expiresAt<=?").run(this.#now()); }
  #deviceId(device) { const id = device?.id ?? device?.deviceId; if (typeof id !== 'string' || !id) throw new Error('authenticated device required'); return id; }
  #assertWorkDevice(device) { this.#deviceId(device); if (device?.capabilities?.work !== true || device?.capabilities?.nativeSessions !== true || device?.capabilities?.messages !== true) throw new Error('device lacks remote work approval capabilities'); }
  #view(row) { return { id: row.id, deviceId: row.deviceId, engine: row.engine, sessionId: row.sessionId, method: row.method, question: row.question, options: JSON.parse(row.options), status: row.status, answer: row.answer, createdAt: row.createdAt, expiresAt: row.expiresAt, answeredAt: row.answeredAt }; }

  request(device, payload) {
    this.#assertWorkDevice(device);
    const deviceId = this.#deviceId(device);
    if (!payload || typeof payload.id !== 'string' || !payload.id || !['codex','dsh'].includes(payload.engine) || typeof payload.sessionId !== 'string' || !payload.sessionId || !METHODS.has(payload.method)) throw new Error('invalid approval request');
    if (typeof payload.question !== 'string' || payload.question.length > 12000) throw new Error('invalid approval question');
    if (payload.options !== undefined && (!Array.isArray(payload.options) || payload.options.some(o => !o || typeof o.label !== 'string' || typeof o.value !== 'string'))) throw new Error('invalid approval options');
    const options = (payload.options || []).map(o => ({ label: String(redact(o.label)), value: String(o.value) }));
    if (options.length > 100 || options.some(o => o.label.length>500 || o.value.length>500 || (payload.method==='item/tool/requestUserInput'?o.value!==o.label&&!['accept','decline'].includes(o.value):!['accept','decline'].includes(o.value)))) throw new Error('approval options must use accept/decline values');
    const safeQuestion = String(redact(payload.question));
    const content = { engine: payload.engine, sessionId: payload.sessionId, method: payload.method, question: payload.question, options: payload.options || [] };
    const fingerprint = createHash('sha256').update(stable(content)).digest('hex');
    this.#expire();
    const old = this.store.db.prepare('SELECT * FROM remote_native_approvals WHERE id=?').get(payload.id);
    if (old) { if (old.deviceId !== deviceId || old.fingerprint !== fingerprint) throw new Error('approval id conflict'); return this.#view(old); }
    const now = this.#now();
    this.store.db.prepare(`INSERT INTO remote_native_approvals(id,deviceId,engine,sessionId,method,question,options,fingerprint,status,createdAt,expiresAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(payload.id,deviceId,payload.engine,payload.sessionId,payload.method,safeQuestion,JSON.stringify(options),fingerprint,'pending',now,now+TTL);
    return this.#view(this.store.db.prepare('SELECT * FROM remote_native_approvals WHERE id=?').get(payload.id));
  }

  list({ device, includeAnswered = false } = {}) {
    this.#expire();
    if (device) this.#assertWorkDevice(device);
    const deviceId = device ? this.#deviceId(device) : null;
    const rows = deviceId
      ? this.store.db.prepare(`SELECT * FROM remote_native_approvals WHERE deviceId=? ${includeAnswered ? '' : "AND status='pending'"} ORDER BY createdAt`).all(deviceId)
      : this.store.db.prepare("SELECT * FROM remote_native_approvals WHERE status='pending' ORDER BY createdAt").all();
    return rows.map(row => this.#view(row));
  }

  answer(id, { answer }) {
    this.#expire();
    const row = this.store.db.prepare('SELECT * FROM remote_native_approvals WHERE id=?').get(String(id));
    if (!row) throw new Error('approval not found');
    if (row.status !== 'pending') throw new Error(`approval is ${row.status}`);
    const options = JSON.parse(row.options);
    const freeText = row.method === 'item/tool/requestUserInput' && options.length === 0 && typeof answer === 'string' && answer.length <= 12000;
    if (typeof answer !== 'string' || !(['accept','decline'].includes(answer) || options.some(o => o.label === answer) || freeText)) throw new Error('answer must be accept/decline, an offered option label, or user input text');
    this.store.db.prepare("UPDATE remote_native_approvals SET status='answered',answer=?,answeredAt=? WHERE id=? AND status='pending'").run(answer,this.#now(),String(id));
    return this.#view(this.store.db.prepare('SELECT * FROM remote_native_approvals WHERE id=?').get(String(id)));
  }

  decisions(device) {
    this.#assertWorkDevice(device);
    const deviceId = this.#deviceId(device);
    this.#expire();
    return this.store.db.prepare("SELECT * FROM remote_native_approvals WHERE deviceId=? AND status IN ('answered','expired') ORDER BY createdAt").all(deviceId).map(row => this.#view(row));
  }
}
