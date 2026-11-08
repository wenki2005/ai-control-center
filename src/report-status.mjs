import { redact } from './redact.mjs';

const local = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(new Date(value)) + '（上海时间）' : null;

export function reportStatus(store, { task, query = '' } = {}) {
  if (typeof query !== 'string' || query.length > 160 || (task !== undefined && (typeof task !== 'string' || !/^t-[\w-]{1,100}$/.test(task)))) throw Error('任务查询参数无效');
  const rows = task ? store.db.prepare("SELECT * FROM tasks WHERE role='worker' AND id=?").all(task)
    : store.db.prepare("SELECT * FROM tasks WHERE role='worker' AND instr(lower(prompt),lower(?))>0 ORDER BY createdAt DESC LIMIT 5").all(query.trim());
  return { timezone: 'Asia/Shanghai', evidence: 'QQ发送接口确认成功只表示已发送，不代表用户已读；未找到回执不等于已确认漏发。', tasks: rows.map(row => {
    // Current reports use their stable return_reports key for outbox dedupe;
    // task status/runVersion are not part of that key. Read the persisted
    // manifest first so status follows the exact chunks expected for this task.
    const report = store.db.prepare('SELECT key,manifest,snapshot,status FROM return_reports WHERE taskId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(row.id);
    let previousRun=false;try{const snapshot=JSON.parse(report?.snapshot||'{}');previousRun=snapshot.runVersion!==undefined&&snapshot.runVersion!==row.runVersion;}catch{}
    let parts = [];
    if (report) {
      let manifest = [];
      try { manifest = JSON.parse(report.manifest || '[]'); } catch {}
      if (manifest.length) parts = manifest.map(part => store.db.prepare('SELECT status,createdAt,updatedAt FROM outbox WHERE id=?').get(part.id) || { status: 'missing', createdAt: null, updatedAt: null });
      else {
        const prefix = `task-report:${report.key}:part:`;
        parts = store.db.prepare('SELECT dedupe,status,createdAt,updatedAt FROM outbox WHERE substr(dedupe,1,?)=? ORDER BY createdAt,rowid')
          .all(prefix.length, prefix).filter(part => /^\d+$/.test(String(part.dedupe || '').slice(prefix.length)));
      }
    }
    // Legacy director turns sent chunks under a run-version key.
    if (!parts.length && row.role === 'director') {
      const prefix = `completed:${row.id}:${row.runVersion}:part:`;
      parts = store.db.prepare('SELECT dedupe,status,createdAt,updatedAt FROM outbox WHERE substr(dedupe,1,?)=? ORDER BY createdAt,rowid').all(prefix.length, prefix);
    }
    const delivery = !parts.length ? 'unverified' : parts.every(x => x.status === 'sent') ? 'sent'
      : parts.some(x => ['uncertain','missing'].includes(x.status)) ? 'uncertain' : parts.some(x => ['pending','sending'].includes(x.status)) ? 'pending'
      : parts.some(x => x.status === 'sent') ? 'partial' : 'suppressed';
    const sentAt = delivery === 'sent' ? parts.map(x => x.updatedAt).sort().at(-1) : null;
    return { reference: row.id, title: redact(row.prompt).slice(0, 130), engine: row.engine, status: row.status,
      finishedAt: ['completed','failed','cancelled'].includes(row.status) ? local(row.updatedAt) : null,
      delivery:previousRun?'unverified':delivery, ...(previousRun?{previousDelivery:delivery}:{}), partCount: previousRun?0:parts.length, confirmedParts: previousRun?0:parts.filter(x => x.status === 'sent').length, deliveredAt: previousRun?null:local(sentAt) };
  }) };
}
