import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redact } from './redact.mjs';

const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_NOTE_FILES = 500;
const MAX_NOTE_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_API_NOTE_CHARS = 20_000;
const ZONE = 'Asia/Shanghai';
const OMIT_NAME = /^(?:\.git|\.hg|\.svn|node_modules|\.cache|cache|tmp|temp|build|dist|coverage|credentials?|secrets?|\.ssh|\.codex|\.dsh)$/i;
const OMIT_SECRET = /(?:^|[._-])(?:credential|secret|token|password|api[-_]?key|auth)(?:[._-]|$)/i;
const OMIT_CONTENT = /(?:任务报告|执行报告|工作报告|总结报告|人格规则|人格设定|系统提示词|system prompt|persona rules|agent instructions|AGENTS\.md)/i;

function digest(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function dateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function localDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const p = dateParts(date); return `${p.year}-${p.month}-${p.day}`;
}
function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d ? value : null;
}
function findEventDate(text, recordedAt) {
  const source = String(text || '');
  const full = /(?<!\d)(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?!\d)/g;
  const explicit = new Set();
  let match;
  while ((match = full.exec(source))) {
    const day = validDay(`${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`);
    if (day) explicit.add(day);
  }
  const base = localDay(recordedAt);
  const relative = new Set();
  if (base && /今天/.test(source)) relative.add(base);
  if (base && /昨天/.test(source)) relative.add(shiftDay(base, -1));
  const dates = new Set([...explicit, ...relative]);
  if (dates.size > 1) return { occurredAt: null, dateBasis: '日期不明' };
  if (explicit.size === 1) return { occurredAt: [...explicit][0], dateBasis: '明确日期' };
  if (relative.size === 1) return { occurredAt: [...relative][0], dateBasis: '相对日期' };
  return { occurredAt: null, dateBasis: '日期不明' };
}
function splitNoteSegments(content) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  const parts = [];
  let block = [];
  let pendingDateHeader = null;
  const flush = () => {
    const text = block.join('\n').trim();
    if (text) parts.push(text);
    block = [];
  };
  const dateHeader = /^\s{0,3}(?:#{1,6}\s*)?(?:(?:20\d{2})[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+.+)?|今天(?:\s*[:：-]\s*.*)?|昨天(?:\s*[:：-]\s*.*)?)\s*#*\s*$/;
  for (const line of lines) {
    if (dateHeader.test(line)) {
      flush();
      pendingDateHeader = line.trim();
    } else if (!line.trim()) {
      if (block.length) flush();
    } else {
      if (!block.length && pendingDateHeader) block.push(pendingDateHeader);
      pendingDateHeader = null;
      block.push(line);
    }
  }
  flush();
  return parts;
}
function safeText(value) { return String(redact(String(value ?? ''))).replace(/\0/g, '').trim(); }
function safeTitle(value, fallback) {
  const cleaned = safeText(value).replace(/[\r\n\t]+/g, ' ').slice(0, 180);
  return cleaned || fallback;
}
function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function safeRecorded(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}
function escapeMarkdown(value) { return String(value ?? '').replace(/\r/g, '').trim(); }
function normalizeDuplicateText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '');
}
function timelineCategory(row) {
  if (row.sourceKind === 'diary') return 'diary';
  if (row.sourceKind === 'fact') return /历史事实/.test(`${row.title}\n${row.sourceLabel}`) ? 'fact:history' : 'fact:current';
  if (row.sourceKind === 'note' || row.sourceKind === 'note-file') return 'note';
  return row.sourceKind;
}
function timelineDateKey(row) {
  return row.occurredAt ? `date:${row.occurredAt}` : `unknown:${localDay(row.recordedAt) || 'unknown'}`;
}
function numberSignature(text) { return (String(text).match(/\d+(?:\.\d+)?/g) || []).join('|'); }
function negationSignature(text) {
  return (String(text).match(/从不|没有|不是|不会|不再|未曾|不|没|无|非|未/g) || []).sort().join('|');
}
function characterBigrams(text) {
  const chars = Array.from(text);
  const result = new Set();
  for (let i = 0; i + 1 < chars.length; i++) result.add(chars[i] + chars[i + 1]);
  return result;
}
function isConservativeSimilar(left, right) {
  if (left.length > 20000 || right.length > 20000) return false;
  const a = normalizeDuplicateText(left), b = normalizeDuplicateText(right);
  if (a.length < 8 || b.length < 8 || a === b) return false;
  if (numberSignature(left) !== numberSignature(right) || negationSignature(left) !== negationSignature(right)) return false;
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (ratio < 0.82) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const aa = characterBigrams(a), bb = characterBigrams(b);
  let overlap = 0;
  for (const gram of aa) if (bb.has(gram)) overlap++;
  const jaccard = overlap / Math.max(1, aa.size + bb.size - overlap);
  return jaccard >= 0.86;
}
function compareTimelineRows(a, b) {
  if (a.occurredAt && b.occurredAt) return b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt);
  if (a.occurredAt) return -1;
  if (b.occurredAt) return 1;
  return b.recordedAt.localeCompare(a.recordedAt);
}

export class MemoryTimeline {
  constructor({ store, root, notesRoot = join(root, 'notes') } = {}) {
    if (!store?.db || !root) throw new TypeError('MemoryTimeline 需要 store.db 和 root');
    this.store = store;
    this.db = store.db;
    this.root = resolve(root);
    this.notesRoot = resolve(notesRoot);
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.notesRoot, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_entries(
        id TEXT PRIMARY KEY, sourceKind TEXT NOT NULL, sourceId TEXT NOT NULL,
        sourceHash TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        occurredAt TEXT, recordedAt TEXT NOT NULL, dateBasis TEXT NOT NULL,
        sourceLabel TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        UNIQUE(sourceKind,sourceId)
      );
      CREATE INDEX IF NOT EXISTS timeline_entries_active_date ON timeline_entries(active,occurredAt,recordedAt);
      CREATE TABLE IF NOT EXISTS timeline_notes(
        id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL,
        occurredAt TEXT, recordedAt TEXT NOT NULL, dateBasis TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);
  }

  #now() { return safeRecorded(typeof this.store.now === 'function' ? this.store.now() : new Date()); }
  #entryId(kind, sourceId) { return `tl-${digest(`${kind}\0${sourceId}`).slice(0, 32)}`; }
  #upsert(item) {
    const cleanedText = safeText(item.text);
    if (!cleanedText || OMIT_CONTENT.test(`${item.title || ''}\n${cleanedText.slice(0, 500)}`)) return;
    const title = safeTitle(item.title, cleanedText.split(/[\r\n。！？.!?]/, 1)[0].slice(0, 80) || '未命名记录');
    const recordedAt = safeRecorded(item.recordedAt);
    const sourceLabel = safeTitle(item.sourceLabel, item.sourceKind);
    const hash = digest(JSON.stringify([title, cleanedText, item.occurredAt || null, recordedAt, item.dateBasis, sourceLabel]));
    const id = this.#entryId(item.sourceKind, item.sourceId);
    this.db.prepare(`INSERT INTO timeline_entries(id,sourceKind,sourceId,sourceHash,title,text,occurredAt,recordedAt,dateBasis,sourceLabel,active,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(sourceKind,sourceId) DO UPDATE SET sourceHash=excluded.sourceHash,title=excluded.title,text=excluded.text,
      occurredAt=excluded.occurredAt,recordedAt=excluded.recordedAt,dateBasis=excluded.dateBasis,sourceLabel=excluded.sourceLabel,active=1,updatedAt=excluded.updatedAt
      WHERE timeline_entries.sourceHash<>excluded.sourceHash OR timeline_entries.active<>1`).run(
      id, item.sourceKind, String(item.sourceId), hash, title, cleanedText, item.occurredAt || null,
      recordedAt, item.dateBasis || '日期不明', sourceLabel, this.#now(), this.#now());
  }

  #tableExists(name) { return !!this.db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  #syncMissing(kind, seen) {
    const deactivate = this.db.prepare('UPDATE timeline_entries SET active=0,updatedAt=? WHERE sourceKind=? AND sourceId=? AND active=1');
    for (const row of this.db.prepare('SELECT sourceId FROM timeline_entries WHERE sourceKind=? AND active=1').all(kind)) {
      if (!seen.has(String(row.sourceId))) deactivate.run(this.#now(), kind, row.sourceId);
    }
  }
  #refreshTableSources(seen) {
    if (this.#tableExists('companion_memories')) {
      seen.set('memory', new Set());
      for (const row of this.db.prepare("SELECT id,text,source,createdAt,updatedAt FROM companion_memories WHERE status='active'").all()) {
        const text = safeText(row.text);
        const date = findEventDate(text, row.createdAt || row.updatedAt);
        this.#upsert({ sourceKind: 'memory', sourceId: row.id, title: text.split(/[\r\n。！？.!?]/, 1)[0], text,
          occurredAt: date.occurredAt, dateBasis: date.dateBasis, recordedAt: row.createdAt || row.updatedAt,
          sourceLabel: `记忆${row.source ? ` · ${safeText(row.source)}` : ''}` });
        if (text && !OMIT_CONTENT.test(text.slice(0, 500))) seen.get('memory').add(String(row.id));
      }
      this.#syncMissing('memory', seen.get('memory'));
    }
    if (this.#tableExists('companion_facts')) {
      seen.set('fact', new Set());
      for (const row of this.db.prepare("SELECT id,key,value,source,validFrom,validTo,status,createdAt,updatedAt FROM companion_facts WHERE status IN ('active','superseded')").all()) {
        const historical = row.status === 'superseded';
        const text = historical
          ? `历史事实：${safeText(row.key)}：${safeText(row.value)}\n有效期：${safeText(row.validFrom || '未记录')} 至 ${safeText(row.validTo || '未记录')}\n状态：已失效（${safeText(row.status)}）`
          : `${safeText(row.key)}：${safeText(row.value)}`;
        const effective = validDay(String(row.validFrom || '').slice(0, 10));
        this.#upsert({ sourceKind: 'fact', sourceId: row.id || row.key, title: historical ? `历史事实 · ${row.key}` : row.key, text,
          occurredAt: effective, dateBasis: effective ? '事实生效日期' : '日期不明',
          recordedAt: row.createdAt || row.updatedAt, sourceLabel: `${historical ? '历史事实' : '事实'}${row.source ? ` · ${safeText(row.source)}` : ''}` });
        if (text && !OMIT_CONTENT.test(text.slice(0, 500))) seen.get('fact').add(String(row.id || row.key));
      }
      this.#syncMissing('fact', seen.get('fact'));
    }
    if (this.#tableExists('companion_diary')) {
      seen.set('diary', new Set());
      for (const row of this.db.prepare('SELECT id,day,title,content,createdAt FROM companion_diary').all()) {
        const day = validDay(String(row.day || '').slice(0, 10));
        this.#upsert({ sourceKind: 'diary', sourceId: row.id, title: row.title, text: row.content,
          occurredAt: day, dateBasis: day ? '记录日期' : '日期不明', recordedAt: row.createdAt, sourceLabel: '日记日期（非用户事实）' });
        const cleaned = safeText(row.content);
        if (cleaned && !OMIT_CONTENT.test(`${row.title || ''}\n${cleaned.slice(0, 500)}`)) seen.get('diary').add(String(row.id));
      }
      this.#syncMissing('diary', seen.get('diary'));
    }
    seen.set('note', new Set());
    for (const row of this.db.prepare('SELECT id,title,text,occurredAt,recordedAt,dateBasis FROM timeline_notes').all()) {
      this.#upsert({ sourceKind: 'note', sourceId: row.id, title: row.title, text: row.text,
        occurredAt: row.occurredAt, dateBasis: row.dateBasis, recordedAt: row.recordedAt, sourceLabel: '手动笔记' });
      if (safeText(row.text) && !OMIT_CONTENT.test(`${row.title || ''}\n${String(row.text).slice(0, 500)}`)) seen.get('note').add(String(row.id));
    }
    this.#syncMissing('note', seen.get('note'));
  }

  #walkNotes() {
    if (!existsSync(this.notesRoot)) return { items: [], complete: true };
    let base, rootBase;
    try {
      base = realpathSync(this.notesRoot);
      rootBase = realpathSync(this.root);
    } catch { return { items: [], complete: false }; }
    if (!isWithin(rootBase, base)) return { items: [], complete: false };
    const found = [];
    let fileCount = 0, totalBytes = 0;
    let incomplete = false;
    const walk = (dir, depth) => {
      let entries;
      try { entries = this.#safeReadDir(dir, base); } catch { return; }
      for (const ent of entries) {
        if (fileCount >= MAX_NOTE_FILES || totalBytes >= MAX_NOTE_TOTAL_BYTES) { incomplete = true; return; }
        if (ent.name.startsWith('.') || OMIT_NAME.test(ent.name) || OMIT_SECRET.test(ent.name)) continue;
        const full = join(dir, ent.name);
        try {
          const st = lstatSync(full);
          if (st.isSymbolicLink()) {
            const target = realpathSync(full);
            if (!isWithin(base, target)) continue;
            const targetStat = statSync(target);
            if (targetStat.isDirectory() && depth < 2) walk(target, depth + 1);
            else if (targetStat.isFile() && ['.md', '.txt'].includes(extname(full).toLowerCase())) { fileCount++; totalBytes += Math.min(targetStat.size, MAX_NOTE_BYTES); this.#addFile(full, target, targetStat, found); }
          } else if (st.isDirectory() && depth < 2) walk(full, depth + 1);
          else if (st.isFile() && ['.md', '.txt'].includes(extname(full).toLowerCase())) { fileCount++; totalBytes += Math.min(st.size, MAX_NOTE_BYTES); this.#addFile(full, full, st, found); }
        } catch { /* skip unreadable or raced paths */ }
      }
    };
    walk(base, 0);
    return { items: found, complete: !incomplete };
  }
  #safeReadDir(dir, base) {
    if (!isWithin(base, realpathSync(dir))) return [];
    // Kept local to avoid adding a broad filesystem traversal dependency.
    return readdirSync(dir, { withFileTypes: true });
  }
  #addFile(labelPath, actualPath, st, found) {
    const ext = extname(labelPath).toLowerCase();
    if (!['.md', '.txt'].includes(ext) || OMIT_SECRET.test(labelPath) || st.size > MAX_NOTE_BYTES) return;
    const text = safeText(readFileSync(actualPath, 'utf8'));
    if (!text || OMIT_CONTENT.test(`${labelPath}\n${text.slice(0, 500)}`)) return;
    const recordedAt = new Date(st.mtimeMs).toISOString();
    const rel = relative(this.notesRoot, labelPath).split(/[\\/]/).join('/');
    const segments = splitNoteSegments(text);
    const duplicates = new Map();
    for (const segment of segments) {
      if (OMIT_CONTENT.test(segment.slice(0, 500))) continue;
      const segmentHash = digest(segment);
      const occurrence = duplicates.get(segmentHash) || 0;
      duplicates.set(segmentHash, occurrence + 1);
      const date = findEventDate(segment, recordedAt);
      const titleLine = segment.split(/[\r\n]/).map(line => line.replace(/^\s{0,3}#{1,6}\s*/, '').trim()).find(Boolean) || basename(labelPath);
      found.push({ sourceKind: 'note-file', sourceId: `${rel}#${segmentHash.slice(0, 20)}-${occurrence + 1}`,
        title: titleLine.split(/[。！？.!?]/, 1)[0].slice(0, 80),
        text: segment, occurredAt: date.occurredAt, dateBasis: date.dateBasis, recordedAt,
        sourceLabel: `笔记文件 · ${rel} · 段落 ${found.length + 1}` });
    }
  }

  refresh() {
    const scan = this.#walkNotes();
    const action = () => {
      const seen = new Map();
      this.#refreshTableSources(seen);
      seen.set('note-file', new Set());
      for (const item of scan.items) {
        this.#upsert(item);
        seen.get('note-file').add(String(item.sourceId));
      }
      if (scan.complete) this.#syncMissing('note-file', seen.get('note-file'));
    };
    if (typeof this.store.transaction === 'function') this.store.transaction(action);
    else {
      this.db.exec('BEGIN IMMEDIATE');
      try { action(); this.db.exec('COMMIT'); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    return this.list();
  }

  addNote({ text, occurredAt, title } = {}) {
    if (String(text ?? '').length > MAX_API_NOTE_CHARS) throw new RangeError(`笔记内容不能超过 ${MAX_API_NOTE_CHARS} 个字符`);
    const clean = safeText(text);
    if (!clean) throw new TypeError('笔记内容不能为空');
    const recordedAt = this.#now();
    let eventDate = null;
    let dateBasis = eventDate ? '明确日期' : null;
    if (occurredAt != null && String(occurredAt).trim() !== '') {
      eventDate = validDay(String(occurredAt).trim());
      if (!eventDate) throw new TypeError('occurredAt 必须是有效的 YYYY-MM-DD 日期');
      dateBasis = '明确日期';
    } else {
      const inferred = findEventDate(clean, recordedAt);
      eventDate = inferred.occurredAt; dateBasis = inferred.dateBasis;
    }
    const id = randomUUID();
    const noteTitle = safeTitle(title, clean.split(/[\r\n。！？.!?]/, 1)[0].slice(0, 80) || '随手记');
    this.db.prepare('INSERT INTO timeline_notes(id,title,text,occurredAt,recordedAt,dateBasis,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(id, noteTitle, clean, eventDate, recordedAt, dateBasis || '日期不明', recordedAt);
    this.refresh();
    return this.db.prepare('SELECT id,title,text,occurredAt,recordedAt,dateBasis,sourceKind,sourceId,sourceLabel FROM timeline_entries WHERE sourceKind=? AND sourceId=?').get('note', id);
  }

  #rows() {
    return this.db.prepare(`SELECT id,title,text,occurredAt,recordedAt,dateBasis,sourceKind,sourceId,sourceLabel
      FROM timeline_entries WHERE active=1`).all();
  }
  #groupRows(rows) {
    const exactGroups = new Map();
    for (const row of rows) {
      const normalized = normalizeDuplicateText(row.text);
      const exactKey = `${timelineCategory(row)}\0${timelineDateKey(row)}\0${numberSignature(row.text)}\0${negationSignature(row.text)}\0${normalized || `empty:${row.id}`}`;
      if (!exactGroups.has(exactKey)) exactGroups.set(exactKey, []);
      exactGroups.get(exactKey).push(row);
    }
    const groups = [...exactGroups.values()].map(items => {
      items.sort((a, b) => `${a.sourceKind}\0${a.sourceId}`.localeCompare(`${b.sourceKind}\0${b.sourceId}`));
      const primary = items[0];
      return {
        ...primary,
        recordedAt: items.reduce((latest, item) => item.recordedAt > latest ? item.recordedAt : latest, primary.recordedAt),
        sourceRefs: items.map(item => ({ id: item.id, sourceKind: item.sourceKind, sourceId: item.sourceId,
          sourceLabel: item.sourceLabel, recordedAt: item.recordedAt, dateBasis: item.dateBasis, title: item.title })),
        variants: items.map(item => ({ id: item.id, sourceKind: item.sourceKind, sourceId: item.sourceId,
          title: item.title, text: item.text, sourceLabel: item.sourceLabel, recordedAt: item.recordedAt })),
        relatedIds: [],
      };
    });

    const buckets = new Map();
    for (const group of groups) {
      const bucketKey = `${timelineCategory(group)}\0${timelineDateKey(group)}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      buckets.get(bucketKey).push(group);
    }
    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < Math.min(bucket.length, i + 21); j++) {
        if (isConservativeSimilar(bucket[i].text, bucket[j].text)) {
          bucket[i].relatedIds.push(bucket[j].id);
          bucket[j].relatedIds.push(bucket[i].id);
        }
      }
    }
    return groups.sort(compareTimelineRows);
  }
  list({ q = '', from, to, limit = 100 } = {}) {
    const max = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
    const query = String(q || '').trim().toLocaleLowerCase();
    const lo = validDay(String(from || '').slice(0, 10)), hi = validDay(String(to || '').slice(0, 10));
    const filtered = this.#rows().filter(row => {
      if ((lo || hi) && !row.occurredAt) return false;
      if (lo && row.occurredAt < lo) return false;
      if (hi && row.occurredAt > hi) return false;
      return true;
    });
    return this.#groupRows(filtered).filter(row => !query ||
      `${row.title}\n${row.text}\n${row.sourceRefs.map(ref => `${ref.sourceLabel}\n${ref.title}`).join('\n')}\n${row.variants.map(item => item.text).join('\n')}`
        .toLocaleLowerCase().includes(query)).slice(0, max);
  }
  search(q, limit = 100) { return this.list({ q, limit }); }

  exportMarkdown() {
    mkdirSync(this.root, { recursive: true });
    const rows = this.#groupRows(this.#rows());
    const known = rows.filter(row => row.occurredAt), unknown = rows.filter(row => !row.occurredAt);
    const titles = new Map(rows.map(row => [row.id, row.title]));
    const format = row => `### ${escapeMarkdown(row.title)}\n\n- 日期：${row.occurredAt || '日期不明'}（${row.dateBasis}）\n- 关联条目：${row.relatedIds.length ? row.relatedIds.map(id=>escapeMarkdown(titles.get(id)||'相关记录')).join('、') : '无'}\n\n${row.variants.map((variant, index) => {
      const source = row.sourceRefs[index];
      return `#### 原始记录 ${index + 1}：${escapeMarkdown(variant.title)}\n\n- 记录时间：${source.recordedAt}\n- 日期依据：${source.dateBasis}\n- 来源：${escapeMarkdown(source.sourceLabel)}\n\n${escapeMarkdown(variant.text)}\n`;
    }).join('\n')}`;
    const output = `# 时间线\n\n> 由 AI 中控从已启用记忆、事实、日记和 notes 笔记整理。日期依据与来源会保留；日记日期不代表用户事实。\n\n## 有日期的条目\n\n${known.map(format).join('\n') || '（暂无）\n'}\n## 日期不明的条目\n\n${unknown.map(format).join('\n') || '（暂无）\n'}`;
    const target = join(this.root, '时间线.md');
    let previous = null;
    try { previous = readFileSync(target, 'utf8'); } catch { /* first export */ }
    if (previous !== output) {
      const temp = join(this.root, `.timeline-${process.pid}-${randomUUID()}.tmp`);
      writeFileSync(temp, output, { encoding: 'utf8', flag: 'wx' });
      renameSync(temp, target);
    }
    return output;
  }
}

