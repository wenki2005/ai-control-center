import { createHash } from 'node:crypto';
import { redact } from './redact.mjs';
import {cleanConversationalStyle} from './speech-style-policy.mjs';
import {progressDeliveryGate} from './report-progress.mjs';

export function conversationMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw Error('自然对话需要1至4条消息');
  return value.map(text => {
    if (typeof text !== 'string' || !text.trim() || text.length > 600 || /\[HUB-|PHONE_EXPLORE|NO_MESSAGE/.test(text)) throw Error('自然对话消息格式无效');
    return cleanConversationalStyle(redact(text.trim()));
  });
}

export class CompanionConversation {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_topics (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, sourceChatId INTEGER,
      quote TEXT, status TEXT NOT NULL DEFAULT 'open', createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL, lastOfferedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS companion_message_batches (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, anchorUserId INTEGER NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS companion_message_parts (
      outboxId TEXT PRIMARY KEY, batchId TEXT NOT NULL, ordinal INTEGER NOT NULL
    );`);
  }
  anchor() { return this.store.db.prepare("SELECT id FROM companion_chat WHERE role='user' AND retractedAt IS NULL ORDER BY id DESC LIMIT 1").get()?.id || 0; }
  queue(messages, key, { kind = 'proactive', anchorUserId = this.anchor() } = {}) {
    const parts = conversationMessages(messages);
    return this.store.transaction(() => {
      this.store.db.prepare('INSERT OR IGNORE INTO companion_message_batches(id,kind,anchorUserId,createdAt) VALUES(?,?,?,?)').run(key, kind, anchorUserId, this.store.now());
      return parts.map((text, index) => {
        const row = this.store.enqueue(text, `${key}:bubble:${index}`);
        this.store.db.prepare('INSERT OR IGNORE INTO companion_message_parts(outboxId,batchId,ordinal) VALUES(?,?,?)').run(row.id, key, index);
        return row;
      });
    });
  }
  topics(now = Date.now()) {
    return this.store.db.prepare(`SELECT id,text,kind,sourceChatId,quote,lastOfferedAt FROM companion_topics t
      WHERE status='open' AND expiresAt>? AND (lastOfferedAt IS NULL OR (kind='curiosity' AND lastOfferedAt<?))
      AND (kind='curiosity' OR EXISTS(SELECT 1 FROM companion_chat c WHERE c.id=t.sourceChatId AND c.role='user' AND c.retractedAt IS NULL AND instr(c.text,t.quote)>0))
      ORDER BY createdAt DESC LIMIT 8`)
      .all(new Date(now).toISOString(), new Date(now - 3*86400000).toISOString());
  }
  remember(candidates, now = Date.now()) {
    if (!Array.isArray(candidates)) return;
    for (const candidate of candidates.slice(0, 4)) {
      if (typeof candidate?.text !== 'string' || !candidate.text.trim() || candidate.text.length > 240) continue;
      const kind = candidate.kind === 'curiosity' ? 'curiosity' : 'followup';
      let source = null;
      if (kind === 'followup') {
        source = Number.isSafeInteger(candidate.sourceChatId) && this.store.db.prepare("SELECT text FROM companion_chat WHERE id=? AND role='user' AND retractedAt IS NULL").get(candidate.sourceChatId);
        if (!source || typeof candidate.quote !== 'string' || candidate.quote.length < 4 || !source.text.includes(candidate.quote)) continue;
      }
      const text = redact(candidate.text.trim());
      const id = createHash('sha256').update(kind + ':' + (source ? candidate.sourceChatId + ':' : '') + text.replace(/[\s\p{P}]/gu, '')).digest('hex').slice(0, 24);
      this.store.db.prepare('INSERT OR IGNORE INTO companion_topics(id,text,kind,sourceChatId,quote,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?)')
        .run(id, text, kind, source ? candidate.sourceChatId : null, source ? redact(candidate.quote).slice(0, 400) : null,
          new Date(now).toISOString(), new Date(now + (kind === 'followup' ? 7 : 2) * 86400000).toISOString());
    }
    // Topics are short-lived conversational leads, not user facts or memory.
    this.store.db.prepare("DELETE FROM companion_topics WHERE expiresAt<?").run(new Date(now - 7 * 86400000).toISOString());
  }
  offered(id, now = Date.now()) {
    if (typeof id === 'string') this.store.db.prepare("UPDATE companion_topics SET lastOfferedAt=? WHERE id=? AND status='open'").run(new Date(now).toISOString(), id);
  }
  closeTopic(id) {
    if (typeof id === 'string') this.store.db.prepare("UPDATE companion_topics SET status='closed' WHERE id=?").run(id);
  }
  cadence(lastInteraction, now = Date.now()) {
    const since = Date.parse(lastInteraction || '');
    const rows = Number.isFinite(since) ? this.store.db.prepare(`SELECT count(DISTINCT b.id) n FROM companion_message_batches b
      JOIN companion_message_parts p ON p.batchId=b.id JOIN outbox o ON o.id=p.outboxId
      WHERE b.kind='proactive' AND b.createdAt>? AND o.status='sent'`).get(new Date(since).toISOString()) : { n: 0 };
    const unanswered = Number(rows.n);
    const adaptive=this.store.meta('companion:adaptive-outreach')==='true';
    const away=Number.isFinite(since)?Math.max(0,(now-since)/60000):0;
    return { unanswered, cooldownMinutes: adaptive?(away>=180?15:away>=90?20:30):Math.min(120, 15 * 2 ** Math.min(unanswered, 3)),
      topics: this.topics(now).length };
  }
}

// Consulted immediately before each send, including after reconnect/reload.
export function conversationDeliveryGate(store, row) {
  const progress=progressDeliveryGate(store,row);
  if(!progress.allowed)return progress;
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_message_parts'").get()) return { allowed: true };
  const batch = store.db.prepare(`SELECT b.*,p.ordinal FROM companion_message_parts p JOIN companion_message_batches b ON b.id=p.batchId WHERE p.outboxId=?`).get(row.id);
  if (!batch) return { allowed: true };
  const anchor = store.db.prepare("SELECT id FROM companion_chat WHERE role='user' AND retractedAt IS NULL ORDER BY id DESC LIMIT 1").get()?.id || 0;
  const previous = store.db.prepare(`SELECT o.status FROM companion_message_parts p JOIN outbox o ON o.id=p.outboxId WHERE p.batchId=? AND p.ordinal<?`).all(batch.id, batch.ordinal);
  // Never send later bubbles past an uncertain or rejected earlier one.
  if (previous.some(item => ['pending','sending','uncertain'].includes(item.status))) return { allowed: false, wait: true };
  if ((anchor !== batch.anchorUserId && (batch.kind === 'proactive' || batch.ordinal > 0)) || previous.some(item => item.status !== 'sent')) {
    store.db.prepare(`UPDATE outbox SET status='suppressed',error=?,updatedAt=? WHERE status='pending' AND id IN
      (SELECT outboxId FROM companion_message_parts WHERE batchId=?)`).run('新消息到达，停止尚未发送的闲聊补充', store.now(), batch.id);
    return { allowed: false };
  }
  if (batch.kind === 'proactive' && store.meta('companion:proactive-enabled') === 'false') {
    store.notification(row.id, 'suppressed', '主动联系已关闭'); return { allowed: false };
  }
  return { allowed: true, kind: batch.kind };
}
