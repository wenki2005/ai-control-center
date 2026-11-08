import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact } from '../redact.mjs';

const reader = fileURLToPath(new URL('../../scripts/read-dsh-history.py', import.meta.url));
const maxOutput = 32 * 1024 * 1024;
const safe = (root, path) => path === root || path.startsWith(root + sep);

function runPython(path) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python', [reader, path], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    const chunks = []; let size = 0; let stderr = '';
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > maxOutput) { child.kill(); reject(new Error('Transcript exceeds 32 MB')); } else chunks.push(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 2048); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`History reader failed: ${stderr}`)));
  });
}

export async function prepareSessionTranscript({ store, companion, sessionId, backupPath, title }) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('Invalid sessionId');
  const root = await realpath(backupPath);
  const manifestPath = join(root, 'manifest.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Invalid manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.sessionId !== sessionId || !Array.isArray(manifest.directories)) throw new Error('Backup session mismatch');
  const rows = [];let histories=0;
  for (const dir of manifest.directories) {
    if (!Array.isArray(dir.files) || typeof dir.slug !== 'string' || typeof dir.variant !== 'string') throw new Error('Invalid manifest entry');
    for (const entry of dir.files) {
      const file = typeof entry === 'string' ? entry : entry?.path;
      if (typeof file !== 'string' || (typeof entry === 'object' && entry.type !== 'file')) continue;
      if (!/\.jsonl(?:\.zstd)?$/u.test(file)) continue;
      const path = resolve(root, 'sessions', dir.slug, dir.variant, file);
      if (!safe(root, path)) throw new Error('Backup path escapes root');
      const actual = await realpath(path);
      if (!safe(root, actual)) throw new Error('Backup symlink escapes root');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('History file must be a regular file');
      const parsed = await runPython(path);
      histories++;
      for (const line of parsed.split(/\r?\n/)) if (line) rows.push(JSON.parse(line));
    }
  }
  if(!histories)throw Error('No readable raw conversation found; refusing archive');
  const body = rows.map((r) => `## ${r.type === 'user' ? '输入（原生日志user槽位）' : '助手'}${r.seq != null ? ` · seq ${r.seq}` : ''}${r.time ? ` · ${r.time}` : ''}\n\n${redact(r.text)}`).join('\n\n');
  const transcriptPath = join(root, `${sessionId}.transcript.md`);
  await writeFile(transcriptPath, `# ${redact(title || sessionId)}\n\n> 原生日志包含系统派发的工作输入；user槽位不等于人类原话。用户事实只依据中枢canonical消息和来源核对。完整原始数据另存于本备份的sessions目录。\n\n${body}\n`, { flag: 'wx' }).catch(async (e) => { if (e.code !== 'EEXIST') throw e; });
  const candidates = [];
  if (store?.db && companion?.saveMemory) {
    const tasks = store.db.prepare("SELECT id,prompt,sessionId,createdAt FROM tasks WHERE sessionId=? AND role<>'direct'").all(sessionId);
    for (const task of tasks) {
      const chats = store.db.prepare("SELECT c.id,c.text,c.createdAt FROM companion_chat c WHERE c.role='user' AND c.text=? AND c.retractedAt IS NULL AND NOT EXISTS(SELECT 1 FROM chat_context_exclusions x WHERE x.chatId=c.id)").all(task.prompt);
      for (const chat of chats) {
        const text = String(chat.text || '').trim();
        const prefix=`用户原话（${chat.createdAt || task.createdAt || '日期未知'}）：`;
        if (!text || /(?:\b(?:test|testing|acceptance|repair)\b|修复|验收|测试|工作提示词|系统提示词|[？?])/i.test(text) || prefix.length+text.length > 1000) continue;
        if (!/(记住|长期|工作单位|公司|偏好|重要经历|我曾经|我经历过|我(?:一直|通常|经常).{0,20}(?:喜欢|讨厌|习惯|住|工作|过敏|忌口))/i.test(text)) continue;
        const source = `archive:chat:${chat.id}`;
        if (candidates.includes(source)) continue;
        if(store.db.prepare('SELECT id FROM companion_memories WHERE source=? LIMIT 1').get(source))continue;
        companion.saveMemory({ text: prefix+text, status: 'pending', source });
        candidates.push(source);
      }
    }
  }
  return { transcriptPath, messageCount: rows.length, memoryCandidates: candidates };
}
