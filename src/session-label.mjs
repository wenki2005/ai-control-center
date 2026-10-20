import { redact } from './redact.mjs';

// Human-facing session name. Native session IDs remain internal routing data;
// this label is safe to show in the hub and QQ notifications.
export function sessionDisplayName(task = {}) {
  const role = task.role === 'director' ? '主管' : task.role === 'coordinator' ? '二级主管' : task.role === 'librarian' ? '资料整理' : task.role === 'maintenance' ? '维护' : '任务';
  const prompt = redact(String(task.prompt ?? ''))
    .replace(/\b(?:session|thread)-[a-z0-9-]{8,}\b/gi, '')
    .replace(/\bt-[a-z0-9-]{6,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  let summary = /(?:执行目标|一级主管整理的目标|用户原话)[：:]\s*(.+)/u.exec(prompt)?.[1] || prompt;
  summary=summary.replace(/\[HUB-[A-Z-]+\]/gu,'').split(/(?:。|[；;]|完成后|禁止|不要)/u)[0].trim();
  if (/同项目接续记录|主管会话接续记录/.test(prompt)) {
    summary = role === '维护' ? '继续维护中控' : role === '资料整理' ? '继续整理资料' : role === '主管' ? '主管会话接续' : '任务会话接续';
  }
  summary = summary ? summary.slice(0, 36) + (summary.length > 36 ? '…' : '') : '未命名任务';
  return `中枢派发 · ${role} · ${summary}`.slice(0, 120);
}
