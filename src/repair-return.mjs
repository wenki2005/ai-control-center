import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { redact } from './redact.mjs';

const MAX_READ = 1024 * 1024;
const MAX_AGE = 12 * 60 * 60 * 1000;

function bodyOf(payload) {
  const parts = Array.isArray(payload?.content) ? payload.content : [];
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').join('') || String(payload?.text || '');
}

/** Durable poller for replies returned by a directly addressed Codex thread. */
export class RepairReturns {
  constructor({ store, notify = async () => {}, onReply = () => {}, threadId, sessionRoot }) {
    if (!store?.db) throw new TypeError('RepairReturns requires a store with db');
    Object.assign(this, { store, notify, onReply, threadId: String(threadId || ''), sessionRoot });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS repair_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, offset INTEGER NOT NULL,
      pending TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, queuedAt INTEGER NOT NULL,
      turnId TEXT, userSeen INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      notifiedAt INTEGER, watcherKey TEXT
    ); CREATE INDEX IF NOT EXISTS repair_returns_pending ON repair_returns(status, queuedAt);
    CREATE TABLE IF NOT EXISTS repair_return_deliveries (
      deliveryKey TEXT PRIMARY KEY, turnId TEXT NOT NULL, text TEXT NOT NULL, notifiedAt INTEGER NOT NULL
    );`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(repair_returns)').all().map(column => column.name));
    if (!columns.has('watcherKey')) this.db.exec('ALTER TABLE repair_returns ADD COLUMN watcherKey TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS repair_returns_watcher_key ON repair_returns(watcherKey) WHERE watcherKey IS NOT NULL');
    for (const row of this.db.prepare('SELECT id,file,offset,text,queuedAt FROM repair_returns WHERE watcherKey IS NULL').all()) {
      this.db.prepare('UPDATE repair_returns SET watcherKey=? WHERE id=?').run(this.#watcherKey(row.file, row.offset, row.text, row.queuedAt), row.id);
    }
    this.polling = false;
  }

  #watcherKey(file, offset, text, queuedAt) {
    return createHash('sha256').update(`${this.threadId}\0${file}\0${offset}\0${queuedAt}\0${text}`).digest('hex');
  }

  queue({ file, offset, text, queuedAt = Date.now(), turnId = null, userSeen = false, watcherKey = null }) {
    if (!file || !Number.isSafeInteger(Number(offset)) || Number(offset) < 0 || typeof text !== 'string' || !text) throw new TypeError('Invalid repair return watcher');
    const key = String(watcherKey || this.#watcherKey(String(file), Number(offset), text, Number(queuedAt)));
    this.db.prepare(`INSERT OR IGNORE INTO repair_returns(file,offset,text,queuedAt,turnId,userSeen,watcherKey)
      VALUES(?,?,?,?,?,?,?)`).run(String(file), Number(offset), text, Number(queuedAt), turnId == null ? null : String(turnId), userSeen ? 1 : 0, key);
    return Number(this.db.prepare('SELECT id FROM repair_returns WHERE watcherKey=?').get(key)?.id || 0);
  }

  async poll({ now = Date.now() } = {}) {
    if (this.polling) return;
    this.polling = true;
    try {
    const rows = this.db.prepare("SELECT * FROM repair_returns WHERE status='pending' ORDER BY id").all();
    for (const row of rows) {
      if (now - row.queuedAt >= MAX_AGE) {
        this.db.prepare("UPDATE repair_returns SET status='expired' WHERE id=? AND status='pending'").run(row.id);
        try { this.store.event?.(null, 'repair.return-expired', { id: row.id, threadId: this.threadId }); } catch { /* event logging is optional */ }
        continue;
      }
      await this.#scan(row);
    }
    } finally { this.polling = false; }
  }

  cancel(id) {
    this.db.prepare("UPDATE repair_returns SET status='cancelled' WHERE id=? AND status='pending'").run(id);
  }

  async #scan(row) {
    let size;
    try { size = (await stat(row.file)).size; } catch { return; }
    let offset = Number(row.offset), pending;
    try { pending = row.pending ? Buffer.from(row.pending, 'base64') : Buffer.alloc(0); } catch { pending = Buffer.alloc(0); }
    if (size < offset) { offset = 0; pending = Buffer.alloc(0); }
    if (size <= offset) return;
    const length = Math.min(size - offset, MAX_READ);
    let chunk;
    try {
      const handle = await open(row.file, 'r');
      try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); chunk = buffer.subarray(0, bytesRead); offset += bytesRead; }
      finally { await handle.close(); }
    } catch { return; }
    const combined = Buffer.concat([pending, chunk]);
    const lines = [];
    let start = 0;
    for (let i = 0; i < combined.length; i++) if (combined[i] === 0x0a) {
      let line = combined.subarray(start, i); if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      lines.push(line.toString('utf8')); start = i + 1;
    }
    pending = combined.subarray(start);
    let userSeen = Boolean(row.userSeen), turnId = row.turnId;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      const payload = record?.payload || {};
      const meta = payload.internal_chat_message_metadata_passthrough || {};
      if (payload.type === 'message' && payload.role === 'user') {
        const body = bodyOf(payload);
        if (body.includes(row.text)) { userSeen = true; turnId = meta.turn_id || payload.turn_id || turnId || null; }
        continue;
      }
      if (payload.type !== 'task_complete' || !userSeen) continue;
      const completedTurn = payload.turn_id || null;
      if (turnId && completedTurn && String(turnId) !== String(completedTurn)) continue;
      const resolvedTurn = turnId || completedTurn;
      if (!resolvedTurn) continue;
      const result = String(payload.last_agent_message || '').trim();
      if (!result) continue;
      const clean = String(redact(result)).trim();
      if (!clean) continue;
      const key = `repair-window-result:${this.threadId}:${resolvedTurn}`;
      const existing = this.db.prepare('SELECT 1 FROM repair_return_deliveries WHERE deliveryKey=?').get(key);
      if (existing) {
        this.db.prepare("UPDATE repair_returns SET status='delivered',offset=?,pending='',turnId=?,userSeen=1,notifiedAt=COALESCE(notifiedAt,?) WHERE id=? AND status='pending'")
          .run(offset, String(resolvedTurn), Date.now(), row.id);
        return;
      }
      // The downstream key is stable. Notify first, then commit delivery so a
      // crash in between can safely retry through the downstream deduplicator.
      try { await this.notify(clean, key); } catch { return; }
      const deliveredAt = Date.now();
      const transaction = this.db.prepare('INSERT OR IGNORE INTO repair_return_deliveries(deliveryKey,turnId,text,notifiedAt) VALUES(?,?,?,?)');
      const inserted = transaction.run(key, String(resolvedTurn), clean, deliveredAt);
      this.db.prepare("UPDATE repair_returns SET status='delivered',offset=?,pending='',turnId=?,userSeen=1,notifiedAt=? WHERE id=? AND status='pending'")
        .run(offset, String(resolvedTurn), deliveredAt, row.id);
      if (Number(inserted.changes) > 0) try { this.onReply(clean); } catch { /* UI callback must not break scanning */ }
      return;
    }
    this.db.prepare("UPDATE repair_returns SET offset=?,pending=?,turnId=?,userSeen=? WHERE id=? AND status='pending'")
      .run(offset, pending.toString('base64'), turnId == null ? null : String(turnId), userSeen ? 1 : 0, row.id);
  }
}
