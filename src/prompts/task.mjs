import { shanghaiClock } from '../companion.mjs';
import { SESSION_PROTOCOLS } from './session-documents.mjs';

const mailPattern = /(?:邮箱|邮件|电子邮件|收件箱|发邮件|回邮件|邮件地址|邮件附件|agently-cli|agent mail)/iu;

function bounded(value, limit = 6000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Build a bounded prompt using only state supplied by the Hub. */
export function buildTaskPrompt(input = {}) {
  const { task, engines, prompt, companionGuide = '', behaviorPolicy = null,
    taskContext, executionContext, documentPaths, now, persona,alreadyDispatched=false,sessionDocuments } = input || {};
  const activeTask = task && typeof task === 'object' ? task : {};
  const role = activeTask.role;
  const userPrompt = String((prompt === undefined ? activeTask.prompt : prompt) ?? '');
  const director = role === 'director';
  const coordinator = role === 'coordinator';
  const worker = role === 'worker';
  const directorReport = director && userPrompt.startsWith('[内部工作回报]');
  const frontdeskOnly = director && userPrompt.startsWith('[前台回应]');
  let report = {};
  if (directorReport) try { report = JSON.parse(userPrompt.slice('[内部工作回报]\n'.length).split(/\r?\n/, 1)[0]); } catch {}
  const progressReport = directorReport && report.kind === 'progress';
  const needsTaskState = (director && !directorReport && !frontdeskOnly) || coordinator;
  const needsProjectDocs = !!sessionDocuments;
  const enginesJson = JSON.stringify(Array.isArray(engines) ? engines : []);
  const personaName = typeof persona?.name === 'string' && persona.name.trim() ? persona.name.trim() : '助手';
  const personaAddress = typeof persona?.address === 'string' ? persona.address.trim() : '';
  const clock = director && !directorReport ? shanghaiClock(typeof now === 'function' ? now() : now instanceof Date ? now : undefined) : '';
  const context = executionContext && typeof executionContext === 'object' ? bounded(executionContext) : '';
  const state = needsTaskState ? String(typeof taskContext === 'function' ? taskContext() : taskContext ?? '').slice(0, 1800) : '';
  const lines = [];

  if (worker) {
    lines.push('你是固定工作会话，直接完成下面的具体请求；遵循用户明确的范围和交付要求，必要时使用当前引擎可用的能力，完成后简洁说明结果与实际产物路径。');
    if (context) { const {recentConversation,...facts}=executionContext; if(facts.fileDelivery&&Array.isArray(recentConversation))facts.fileReference=recentConversation.slice(-4); lines.push(`已核实的任务交接上下文（只作事实参考，目标以当前用户任务为准）：\n${bounded(facts)}`); }
    if (mailPattern.test(userPrompt)) lines.push('邮件任务：DSH 使用 agently-mail 技能和 agently-cli，先读技能说明；Codex 只使用当前实际可用的邮件连接。遵守确认规则；连接可用不代表邮件已发送。');
    lines.push('用户任务：\n' + userPrompt);
    return { text: lines.join('\n\n'), needsProjectDocs, directorReport, needsTaskState: false, frontdeskOnly, coordinator };
  }

  if (sessionDocuments) lines.push(sessionDocuments);
  // Fixtures and standalone callers without a document store initialize the
  // same protocol once. Persistent sessions never repeat it on later turns.
  if (sessionDocuments === undefined && !activeTask.sessionId && (director || coordinator)) {
    lines.push(SESSION_PROTOCOLS[directorReport ? 'report' : director ? 'director' : 'coordinator']);
    if (director && !directorReport) {
      lines.push(`你是${personaName}。${personaAddress ? `称呼用户“${personaAddress}”。` : '不使用固定称呼。'}${persona?.style || ''}\n${persona?.background || ''}`);
      if (behaviorPolicy) lines.push(`行为偏好：${bounded(behaviorPolicy, 1800)}`);
    }
  }
  if (director) {
    if (directorReport) {
      lines.push(progressReport ? '这是内部进度回报。依据提供的快照自然简短汇报；不重派、不执行新工作、不编造。' : '这是内部结果回报。只依据已归档结果整理；不重派、不执行新工作、不提问。');
      if (!progressReport && documentPaths?.persona) lines.push(`首次结果回报措辞参考：${documentPaths.persona}`);
      lines.push('不要显示内部编号、日志或长文件清单。');
    } else {
      if (companionGuide) lines.push(`本轮陪伴提示：${String(companionGuide)}`);
      if (alreadyDispatched) lines.push('本轮已派单，直接回应当前进度，不重复派单。');
    }
    if (clock) lines.push(`上海时间：${clock}。`);
  } else if (coordinator) {
    lines.push(`可用引擎：${enginesJson}。`);
  } else {
    lines.push('按用户目标完成工作，必要时澄清，如实汇报。');
  }

  if (state) lines.push(`当前任务状态：\n${state}`);
  if (context) {
    if ((director && !directorReport) || coordinator) {
      // The native session already contains earlier chat. Only the referenced
      // work facts cross this boundary; never duplicate six old chat turns.
      const { recentConversation, userRequest, goal, ...facts } = executionContext;
      if (userRequest && userRequest !== activeTask.prompt) facts.userRequest = userRequest;
      if (goal && goal !== activeTask.prompt && goal !== userRequest) facts.goal = goal;
      if (coordinator && !facts.previousWork && !facts.relevantWork && Array.isArray(recentConversation)) facts.recentUserContext=recentConversation.filter(item=>item.role==='user').slice(-2).map(item=>({text:String(item.text||'').slice(0,240)}));
      if (Object.keys(facts).length) lines.push(`相关工作：${bounded(facts)}`);
    } else lines.push(`原始任务交接：\n${context}`);
  }
  if (mailPattern.test(userPrompt) && !director && !coordinator) lines.push('邮件任务遵守当前引擎的实际能力与确认规则；不要把连接可用当作已发送。');
  const sessionContext=lines.filter(Boolean).join('\n\n');
  lines.push('用户任务：\n' + userPrompt);
  return { text: lines.filter(Boolean).join('\n\n'), sessionContext, needsProjectDocs, directorReport, needsTaskState, frontdeskOnly, coordinator };
}
