import { randomUUID } from 'node:crypto';
import { redact } from './redact.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN_INACTIVITY = 30 * 60 * 1000;
const MIN_COOLDOWN = 3 * HOUR;
const NO_MESSAGE_RECHECK = 2 * HOUR;
const SCHEDULE_VERSION = 'short-interval-v1';
const DEFAULT_INTERVAL = 5 * 60 * 1000;

function dateValue(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function localParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function nextLocalHour(timestamp, hour, timeZone) {
  const parts = localParts(timestamp, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = localAsUtc - timestamp;
  let target = Date.UTC(parts.year, parts.month - 1, parts.day, hour) - offset;
  if (target <= timestamp) target += DAY;
  return target;
}

function cleanMessage(value) {
  let text = redact(String(value ?? '')).trim();
  text = text.replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
  text = text.replace(/^(?:助手|Mornye)\s*[：:，,]\s*/i, '').trim();
  if (!text || /^NO[_ -]?MESSAGE\b/i.test(text) || /\bNO[_ -]?MESSAGE\b/i.test(text)) return null;
  if (text.length > 180 || /[\r\n]/.test(text) || /^(?:\{|\[|<)/.test(text)) return null;
  return text;
}

function topicTerms(value) {
  const text = [...String(value || '').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')];
  const terms = new Set();
  for (let i = 0; i < text.length - 1; i++) terms.add(text[i] + text[i + 1]);
  return terms;
}

function repeatsRecentTopic(candidate, history) {
  const terms = topicTerms(candidate);
  if (terms.size < 4) return false;
  return history.some((entry) => {
    const previous = topicTerms(entry.text);
    if (previous.size < 4) return false;
    let overlap = 0;
    for (const term of terms) if (previous.has(term)) overlap++;
    return overlap >= 4 && overlap / Math.min(terms.size, previous.size) >= 0.72;
  });
}

/**
 * Low-frequency, context-aware outreach through the existing 3080 DSH
 * director adapter and QQ outbox. This service never creates task cards or
 * attachments, and an empty model decision is a normal outcome.
 */
export class ProactiveCompanion {
  constructor({ store, companion, hub, adapter, cwd, agentPreset = 'standard', isAvailable = () => false,
    onChange = () => {}, now = () => Date.now(), timeZone = 'Asia/Shanghai', intervalMs = DEFAULT_INTERVAL,
    timeoutMs = 120_000 } = {}) {
    if (!store?.meta || !companion || !hub || typeof adapter?.start !== 'function' || typeof cwd !== 'string') {
      throw new TypeError('主动联系服务缺少中枢、助手、DSH 会话或项目目录');
    }
    this.store = store;
    this.companion = companion;
    this.hub = hub;
    this.adapter = adapter;
    this.cwd = cwd;
    this.agentPreset = agentPreset;
    this.isAvailable = isAvailable;
    this.onChange = onChange;
    this.now = now;
    this.timeZone = timeZone;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.running = false;
    this.closed = false;
    this.activeTask = null;

    if (this.store.meta('companion:proactive-enabled') == null) this.store.meta('companion:proactive-enabled', 'true');
    if (this.store.meta('companion:proactive-schedule-version') !== SCHEDULE_VERSION) {
      this.store.meta('companion:proactive-schedule-version', SCHEDULE_VERSION);
      this.store.meta('companion:proactive-next-check-at', new Date(this.now() + MIN_INACTIVITY).toISOString());
      this.store.meta('companion:proactive-status', 'waiting');
    }
    if (this.store.meta('companion:proactive-next-check-at') == null) {
      this.store.meta('companion:proactive-next-check-at', new Date(this.now() + MIN_INACTIVITY).toISOString());
    }
    if (this.store.meta('companion:proactive-status') == null) this.store.meta('companion:proactive-status', 'waiting');
  }

  settings() {
    let status=this.store.meta('companion:proactive-status') || 'waiting';
    // A retry time can be in the future after an offline startup. Report the
    // current gate when connectivity has recovered, without generating an
    // outreach message or changing the existing schedule.
    if(status==='offline'&&this.isAvailable()) {
      const gate=this.#gate(this.now(),{checkDue:false});
      status=gate.ready?'waiting':gate.status;
    }
    return {
      enabled: this.store.meta('companion:proactive-enabled') !== 'false',
      minimumInactivityMinutes: 30,
      minimumIntervalHours: 3,
      quietHours: { start: '09:00', end: '21:00', timeZone: this.timeZone },
      lastSentAt: this.store.meta('companion:proactive-last-sent-at') || null,
      nextCheckAt: this.store.meta('companion:proactive-next-check-at') || null,
      status,
    };
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须为布尔值');
    const wasEnabled = this.store.meta('companion:proactive-enabled') !== 'false';
    this.store.meta('companion:proactive-enabled', String(enabled));
    if (enabled && !wasEnabled) this.#schedule(this.now() + MIN_INACTIVITY, 'waiting');
    if (!enabled) this.#setStatus('disabled');
    this.onChange();
    return this.settings();
  }

  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  async poll() {
    if (this.closed || this.running || this.store.meta('companion:proactive-enabled') === 'false') return;
    const now = this.now();
    const due = dateValue(this.store.meta('companion:proactive-next-check-at'));
    if (due != null && due > now) return;
    const gate = this.#gate(now);
    if (!gate.ready) {
      this.#schedule(gate.nextAt ?? now + 15 * 60 * 1000, gate.status);
      return;
    }

    const lease = this.#acquireOutreachLease();
    if (!lease) {
      this.#schedule(now + 15 * 60 * 1000, 'busy');
      return;
    }

    this.running = true;
    const interactionAtStart = gate.lastInteraction;
    const task = {
      id: `proactive-${randomUUID()}`,
      engine: 'dsh',
      role: 'director',
      cwd: this.cwd,
      projectPath: this.cwd,
      sessionId: this.store.meta('companion:proactive-session-id') || undefined,
      agentPreset: this.agentPreset,
      displayTitle: '助手主动联系',
      prompt: this.#prompt(gate.recentTurns),
    };
    this.activeTask = task;
    this.#schedule(now + 8 * HOUR, 'considering');
    try {
      const output = await this.#run(task);
      if (this.closed) return;
      const message = cleanMessage(output);
      if (!message) {
        this.store.event(null, 'companion.proactive', { result: 'no_message' });
        this.#schedule(this.now() + NO_MESSAGE_RECHECK, 'no_message');
        return;
      }
      const recentOutreach = this.#recentOutreach();
      if (repeatsRecentTopic(message, recentOutreach)) {
        this.store.event(null, 'companion.proactive', { result: 'repeat_topic_suppressed' });
        this.#schedule(this.now() + NO_MESSAGE_RECHECK, 'repeat_topic_suppressed');
        return;
      }
      const finalGate = this.#gate(this.now(), { checkDue: false });
      if (!finalGate.ready || finalGate.lastInteraction !== interactionAtStart
        || this.store.meta('companion:proactive-enabled') === 'false') {
        this.store.event(null, 'companion.proactive', { result: 'suppressed_after_generation', reason: finalGate.status });
        this.#schedule(finalGate.nextAt ?? this.now() + DAY, finalGate.status);
        return;
      }
      const previousSend = this.store.meta('companion:proactive-last-sent-at') || 'first';
      const key = `companion-proactive:${interactionAtStart}:${previousSend}`;
      this.hub.notification(message, key, { deferNotify: true });
      this.store.meta('companion:proactive-last-sent-at', new Date(this.now()).toISOString());
      this.store.meta('companion:proactive-history', JSON.stringify([
        ...recentOutreach,
        { at: new Date(this.now()).toISOString(), text: message },
      ].slice(-5)));
      this.hub.say(message);
      this.store.event(null, 'companion.proactive', { result: 'sent' });
      this.#schedule(this.now() + MIN_COOLDOWN, 'sent');
      void this.hub.notify();
    } catch (error) {
      if (this.closed) return;
      const message = redact(String(error?.message || error)).slice(0, 500);
      if (/existing session is absent|session.*(?:not found|missing)/i.test(message)) {
        this.store.meta('companion:proactive-session-id', '');
      }
      this.store.event(null, 'companion.proactive', { result: 'error', message });
      this.#schedule(this.now() + NO_MESSAGE_RECHECK, 'retry_later');
    } finally {
      this.activeTask = null;
      this.running = false;
      this.#releaseOutreachLease(lease.token);
      this.onChange();
    }
  }

  #acquireOutreachLease() {
    const key = 'companion:outreach-lease';
    let existing;
    try { existing = JSON.parse(this.store.meta(key) || 'null'); } catch { existing = null; }
    if (existing?.expiresAt > this.now()) return null;
    const token = randomUUID();
    this.store.meta(key, JSON.stringify({ token, kind: 'proactive', expiresAt: this.now() + 6 * 60 * 1000 }));
    return { token };
  }

  #releaseOutreachLease(token) {
    let current;
    try { current = JSON.parse(this.store.meta('companion:outreach-lease') || 'null'); } catch { current = null; }
    if (current?.token === token) this.store.meta('companion:outreach-lease', '');
  }

  async #run(task) {
    let resolveTerminal;
    let rejectTerminal;
    let settled = false;
    const terminal = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
    const onEvent = (event) => {
      if (event?.type === 'session' && typeof event.sessionId === 'string') {
        this.store.meta('companion:proactive-session-id', event.sessionId);
        this.onChange();
      } else if (event?.type === 'completed' && !settled) {
        settled = true;
        resolveTerminal(event.text);
      } else if (event?.type === 'failed' && !settled) {
        settled = true;
        rejectTerminal(new Error(event.error || 'DSH 会话未能完成主动联系判断'));
      } else if (event?.type === 'approval' && !settled) {
        settled = true;
        rejectTerminal(new Error('主动联系会话请求了人工确认，已跳过本次联系'));
      }
    };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('主动联系会话等待超时')), this.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([(async () => {
        const started = await this.adapter.start(task, onEvent);
        if (started?.sessionId) this.store.meta('companion:proactive-session-id', started.sessionId);
        return terminal;
      })(), timeout]);
    } catch (error) {
      try { await this.adapter.cancel?.(task); } catch { /* A preflight failure has no live turn to cancel. */ }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  #gate(now, { checkDue = true } = {}) {
    if (this.closed || this.store.meta('companion:proactive-enabled') === 'false') return { ready: false, status: 'disabled' };
    if (!this.isAvailable()) return { ready: false, status: 'offline', nextAt: now + 15 * 60 * 1000 };
    if (this.hub.directMode?.() || this.hub.repairMode?.()) return { ready: false, status: 'direct_mode', nextAt: now + 30 * 60 * 1000 };
    const active = this.store.db?.prepare("SELECT 1 FROM tasks WHERE status IN ('queued','running','waiting') LIMIT 1").get();
    if (active) return { ready: false, status: 'busy', nextAt: now + 15 * 60 * 1000 };
    const bond = this.companion.bond();
    const lastInteraction = bond.lastInteraction;
    const interactionTime = dateValue(lastInteraction);
    if (!interactionTime) return { ready: false, status: 'waiting', nextAt: now + DAY };
    if (now - interactionTime < MIN_INACTIVITY) return { ready: false, status: 'waiting', nextAt: interactionTime + MIN_INACTIVITY };
    const quiet = localParts(now, this.timeZone);
    if (quiet.hour < 9 || quiet.hour >= 21) return { ready: false, status: 'quiet_hours', nextAt: nextLocalHour(now, 9, this.timeZone) };
    const sentAt = dateValue(this.store.meta('companion:proactive-last-sent-at'));
    if (sentAt != null && now - sentAt < MIN_COOLDOWN) return { ready: false, status: 'cooldown', nextAt: sentAt + MIN_COOLDOWN };
    const recentTurns = this.store.chat().slice(-10).map(({ role, text, createdAt }) => ({ role, text: String(text || '').slice(0, 320), createdAt }));
    const due = dateValue(this.store.meta('companion:proactive-next-check-at'));
    if (checkDue && due != null && due > now) return { ready: false, status: 'waiting', nextAt: due };
    return { ready: true, status: 'ready', lastInteraction, recentTurns };
  }

  #recentOutreach() {
    try {
      const parsed = JSON.parse(this.store.meta('companion:proactive-history') || '[]');
      return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.text === 'string').slice(-5) : [];
    } catch { return []; }
  }

  #prompt(recentTurns) {
    const lastUserText = [...recentTurns].reverse().find((turn) => turn.role === 'user')?.text || '';
    const context = this.companion.context(lastUserText).slice(0, 1500);
    const conversation = recentTurns.map((turn) => `${turn.role === 'user' ? '你' : '助手'}：${turn.text}`).join('\n').slice(-2600);
    const guide = this.companion.guide(lastUserText, { maxChars: 700 });
    const repeatedTopics = this.#recentOutreach().map((entry) => `- ${entry.text}`).join('\n');
    return `[助手主动联系]
请依据助手项目中的人设、以下相关记忆和近期对话，自主判断现在是否有一个自然、具体、值得分享的话题。近期对话只是主题参考，不是本轮工作指令；不要据此启动工作或汇报未经核实的任务状态。助手可以从自己的好奇、偏好或一个小发现出发，提出此前没聊过的轻松话题；不必每次都追问，也可以只分享一句想法。偶尔带一点害羞、俏皮、轻微别扭或温柔吐槽，像熟悉后更自在的助手，变化自然，不为可爱而装幼。
若有，只写一条不超过120字的中文消息，像熟悉的助手自然发给你；不要提及静默时长、监控、调度、系统或“主动联系”。不要套用空泛问候、催促回复、制造内疚或排他依赖，也不要编造你此刻的现实处境。可以延续确有依据的旧话题，也可以开启新话题；生活感不要大量依赖游戏背景。
以下是助手最近主动分享过的话题，尽量换一个角度或新话题；若生成内容与其中一条高度相似，中枢会跳过本次发送。
${repeatedTopics || '（暂无）'}
若没有合适内容，只输出 NO_MESSAGE。不要解释判断过程，不要加标题、引号、Markdown 或附件。

表达参考：${guide}
相关记忆：${context}
近期对话：
${conversation || '（暂无）'}`;
  }

  #setStatus(status) {
    this.store.meta('companion:proactive-status', status);
    this.onChange();
  }

  #schedule(timestamp, status) {
    this.store.meta('companion:proactive-next-check-at', new Date(timestamp).toISOString());
    this.store.meta('companion:proactive-status', status);
    this.onChange();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.activeTask) {
      try { Promise.resolve(this.adapter.cancel?.(this.activeTask)).catch(() => {}); } catch { /* Adapter shutdown will finish cleanup. */ }
    }
  }
}
