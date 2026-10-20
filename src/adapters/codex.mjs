import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const DEFAULT_CODEX = 'codex';
const SERVER_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

function sandboxPolicy(mode, cwd) {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false };
}

function safeError(value) {
  return String(value ?? 'Unknown Codex app-server error')
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|token[=: ]+\S+)/gi, '[redacted]')
    .slice(0, 4000);
}

function codexEnvironment(options) {
  const env = { ...process.env, ...(options.env ?? {}) };
  if (!options.proxyUrl) return env;
  const proxy = new URL(options.proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new TypeError('Codex proxy URL must use HTTP or HTTPS');
  const proxyUrl = proxy.href;
  env.HTTP_PROXY = env.http_proxy = proxyUrl;
  env.HTTPS_PROXY = env.https_proxy = proxyUrl;
  env.ALL_PROXY = env.all_proxy = proxyUrl;
  const noProxy = [...new Set([
    ...(env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    'localhost', '127.0.0.1', '::1',
  ])].join(',');
  env.NO_PROXY = env.no_proxy = noProxy;
  return env;
}

function finalText(turn) {
  return (turn?.items ?? [])
    .filter((item) => item?.type === 'agentMessage')
    .map((item) => typeof item.text === 'string' ? item.text : (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join(''))
    .filter(Boolean)
    .join('\n');
}

function approvalQuestion(method, params) {
  if (method === 'item/tool/requestUserInput') {
    const questions = params.questions ?? [];
    if (questions.some((question) => question.isSecret === true)) return {
      kind: 'question', isSecret: true, options: [],
      question: 'The engine is requesting a sensitive answer. Enter it only if you intend to share it with Codex.',
    };
    const multi = questions.length > 1;
    return {
      kind: 'question',
      question: questions.map((q) => `${multi ? `[${q.id}] ` : ''}${q.question}${q.options?.length ? `\n${q.options.map((o) => `• ${o.label}: ${o.description}`).join('\n')}` : ''}`).join('\n\n') + (multi ? '\n\nReply with a JSON object keyed by question ID.' : ''),
      options: multi ? [] : questions.flatMap((q) => q.options ?? []).map((option) => option.label),
      isSecret: false,
    };
  }
  const summary = params.command?.join?.(' ') ?? params.command ?? params.reason ?? params.question ?? method;
  return {
    kind: method.includes('fileChange') || method === 'applyPatchApproval' ? 'file-change' : 'command',
    question: String(summary),
    options: ['approve', 'deny'],
  };
}

function approvalResponse(method, approval, answer) {
  const value = typeof answer === 'string' ? answer.trim() : answer;
  if (method === 'item/tool/requestUserInput') {
    const params = approval.params;
    const questions = params.questions ?? [];
    const answers = {};
    let values = value;
    if (questions.length > 1 && typeof values === 'string') {
      try { values = JSON.parse(values); } catch { throw new Error('Multiple Codex questions require a JSON object keyed by question ID'); }
    }
    if (questions.length > 1 && (!values || typeof values !== 'object' || Array.isArray(values))) {
      throw new Error('Multiple Codex questions require a JSON object keyed by question ID');
    }
    for (const question of questions) {
      if (questions.length > 1 && !Object.hasOwn(values, question.id)) throw new Error(`Missing answer for Codex question ${question.id}`);
      const selected = typeof values === 'object' && values !== null ? values[question.id] : values;
      answers[question.id] = { answers: [String(selected ?? '')] };
    }
    return { answers };
  }
  if (method === 'mcpServer/elicitation/request') {
    if (typeof value === 'object' && value !== null) return value;
    return { action: /^(approve|accept|allow|yes|y|同意|允许|批准|通过|是)$/i.test(String(value)) ? 'accept' : 'decline' };
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: /^(approve|accept|allow|yes|y|同意|允许|批准|通过|是)$/i.test(String(value)) ? 'approved' : { denied: { rejection: String(value || 'Denied by user') } } };
  }
  if (method === 'item/permissions/requestApproval') {
    const permissions = /^(approve|accept|allow|yes|y|同意|允许|批准|通过|是)$/i.test(String(value));
    return { permissions: permissions ? (approval.params.permissions ?? {}) : {} };
  }
  return { decision: /^(approve|accept|allow|yes|y|同意|允许|批准|通过|是)$/i.test(String(value)) ? 'accept' : 'decline' };
}

export function createCodexAdapter(options = {}) {
  const executable = options.codexPath ?? options.binaryPath ?? options.command ?? DEFAULT_CODEX;
  const sandboxMode = options.sandboxMode ?? 'workspace-write';
  if (!SANDBOX_MODES.has(sandboxMode)) throw new TypeError(`Unsupported Codex sandbox mode: ${sandboxMode}`);
  const active = new Map();
  // Result narration is serialized and reuses one native thread. Keep at most
  // one idle app-server alive for that thread; worker turns remain isolated.
  let reporterIdle = null;
  let closed = false;

  function detachIdle(record) {
    if (reporterIdle === record) reporterIdle = null;
  }

  function cleanupChild(record) {
    detachIdle(record);
    record.busy = false;
    record.lines?.close();
    record.lines = null;
    const child = record.child;
    record.child = null;
    record.ready = false;
    record.connecting = null;
    if (record.task?.role === 'reporter') {
      for (const [id, current] of active) if (current === record) active.delete(id);
    }
    if (child && !child.killed) child.kill();
  }

  function finishConnectionTurn(record) {
    if (record.pending.size !== 0) return;
    if (record.task?.role === 'reporter' && record.ready && record.child && !record.child.killed && !record.failed) {
      // Rebind the record only when the next reporter task explicitly resumes
      // this same native session. Do not reuse it for ordinary worker tasks.
      reporterIdle = record;
      return;
    }
    cleanupChild(record);
  }

  async function ensureConnection(record) {
    if (record.ready) return;
    if (record.connecting) return record.connecting;
    record.connecting = new Promise((resolve, reject) => {
      const child = (options.spawn ?? spawn)(executable, ['app-server', '--stdio'], {
        cwd: record.task.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: codexEnvironment(options),
      });
      record.child = child;
      record.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      record.lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        void handleMessage(record, message).catch((error) => fail(record, error));
      });
      child.stderr.on('data', () => { /* diagnostics may contain private runtime details */ });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (record.child !== child) return;
        detachIdle(record);
        const error = new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})`);
        for (const pending of record.pending.values()) pending.reject(error);
        record.pending.clear();
        if (record.busy && !record.terminal) void fail(record, error);
        else cleanupChild(record);
      });
      record.readyResolve = resolve;
      record.readyReject = reject;
      record.request('initialize', {
        clientInfo: { name: 'ai-control-center', title: 'AI Control Center', version: '0.1.0' },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      }).then(() => {
        record.notify('initialized', {});
        record.ready = true;
        resolve();
      }, reject);
    });
    return record.connecting;
  }

  const matchesCurrentTurn = (record, params) => {
    if (params.threadId !== record.threadId) return false;
    const eventTurnId = params.turnId ?? params.turn?.id;
    return !eventTurnId || (record.turnId && eventTurnId === record.turnId);
  };

  async function handleMessage(record, message) {
    if (message.id !== undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = record.pending.get(String(message.id));
      if (!pending) return;
      record.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex RPC request failed'));
      else pending.resolve(message.result);
      if (record.terminal && record.pending.size === 0) finishConnectionTurn(record);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      const params = message.params ?? {};
      if (!SERVER_REQUESTS.has(message.method)) {
        record.write({ id: message.id, error: { code: -32601, message: 'Unsupported app-server request' } });
        return;
      }
      const { kind, question, options: choices } = approvalQuestion(message.method, params);
      record.approvals.set(String(message.id), { id: message.id, method: message.method, params });
      record.onEvent({ type: 'approval', requestId: String(message.id), kind, question, options: choices, raw: { method: message.method, params: params.questions?.some((item) => item.isSecret === true) ? { isSecret: true } : params } });
      return;
    }
    const params = message.params ?? {};
    if(message.method==='thread/tokenUsage/updated' && matchesCurrentTurn(record,params)){const usage=params.tokenUsage?.last;if(usage)record.onEvent({type:'usage',usage:{inputTokens:Number(usage.inputTokens||0),outputTokens:Number(usage.outputTokens||0),totalTokens:Number(usage.totalTokens||0)}});return;}
    if (message.method === 'turn/started') {
      if (params.threadId === record.threadId) record.turnId = params.turn?.id;
      return;
    }
    if (message.method === 'item/agentMessage/delta' && matchesCurrentTurn(record, params)) {
      record.text += params.delta ?? '';
      if (params.delta) record.onEvent({ type: 'message', text: record.text });
      return;
    }
    if (message.method === 'item/completed' && matchesCurrentTurn(record, params)) {
      const item = params.item;
      if (item?.type === 'agentMessage' && !record.text) {
        const text = item.text ?? (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
        if (text) { record.text = text; record.onEvent({ type: 'message', text }); }
      }
      return;
    }
    const earlyTerminal = message.method === 'turn/completed' && !record.turnId && record.busy
      && params.threadId === record.threadId;
    if (message.method === 'turn/completed' && (matchesCurrentTurn(record, params) || earlyTerminal)
      && (!record.turnId || params.turn?.id === record.turnId)) {
      record.turnId = params.turn?.id ?? record.turnId;
      record.busy = false;
      record.terminal = true;
      const text = record.text || finalText(params.turn);
      if (params.turn.status === 'completed') record.onEvent({ type: 'completed', text });
      else if (!(record.cancelRequested && params.turn.status === 'interrupted')) record.onEvent({ type: 'failed', error: safeError(params.turn.error?.message ?? params.turn.status) });
      record.text = '';
      record.cancelRequested = false;
      finishConnectionTurn(record);
      return;
    }
  }

  async function fail(record, error) {
    if (record.failed) return;
    record.failed = true;
    record.busy = false;
    record.onEvent({ type: 'failed', error: safeError(error?.message ?? error) });
    cleanupChild(record);
  }

  function newRecord(task, onEvent) {
    const record = {
      task, child: null, pending: new Map(), approvals: new Map(), nextId: 1,
      ready: false, connecting: null, threadId: task.sessionId ?? null, turnId: null,
      text: '', busy: false, terminal: false, failed: false, cancelRequested: false,
      write(message) {
        if (!record.child || record.child.stdin.destroyed) throw new Error('Codex app-server stdin is closed');
        record.child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      notify(method, params) { record.write({ method, params }); },
      request(method, params) {
        const id = record.nextId++;
        const promise = new Promise((resolve, reject) => {
          const key = String(id);
          const timeout = setTimeout(() => {
            if (!record.pending.has(key)) return;
            record.pending.delete(key);
            if (record.terminal && record.pending.size === 0) finishConnectionTurn(record);
            reject(new Error(`Codex app-server request timed out: ${method}`));
          }, options.rpcTimeoutMs ?? 30000);
          record.pending.set(key, {
            resolve: (value) => { clearTimeout(timeout); resolve(value); },
            reject: (error) => { clearTimeout(timeout); reject(error); },
          });
        });
        try {
          record.write({ id, method, params });
        } catch (error) {
          // A synchronous pipe failure happens before the server can answer.
          // Remove the waiter immediately instead of retaining it until the
          // RPC timeout (and blocking terminal cleanup in the meantime).
          const pending = record.pending.get(String(id));
          record.pending.delete(String(id));
          pending?.reject(error);
          if (record.terminal && record.pending.size === 0) finishConnectionTurn(record);
        }
        return promise;
      },
    };
    active.set(task.id, record);
    record.onEvent = onEvent;
    return record;
  }

  function reuseReporter(task, onEvent) {
    const record = reporterIdle;
    if (!record) return null;
    const sameSession = task.role === 'reporter' && task.sessionId && task.sessionId === record.threadId;
    const healthy = record.ready && record.child && !record.child.killed && !record.child.stdin.destroyed && !record.failed && !record.busy && record.terminal;
    if (!sameSession || !healthy || record.task.cwd !== task.cwd) {
      cleanupChild(record);
      return null;
    }
    detachIdle(record);
    for (const [id, current] of active) if (current === record) active.delete(id);
    record.task = task;
    record.onEvent = onEvent;
    record.approvals.clear();
    record.text = '';
    record.turnId = null;
    record.busy = false;
    record.terminal = false;
    record.failed = false;
    record.cancelRequested = false;
    record.reusedIdle = true;
    active.set(task.id, record);
    return record;
  }

  return {
    async start(task, onEvent) {
      if (closed) throw new Error('Codex adapter is closed');
      if (!task?.id || !task?.cwd || !task?.prompt) throw new TypeError('Codex task requires id, cwd, and prompt');
      // The dedicated result narrator receives untrusted task output. Keep its
      // Codex turn read-only even when ordinary Codex workers can edit files.
      const taskSandboxMode = ['director', 'coordinator', 'reporter'].includes(task.role) ? 'read-only' : sandboxMode;
      const previous = active.get(task.id);
      if (previous?.child && !previous.child.killed) cleanupChild(previous);
      active.delete(task.id);
      const record = reuseReporter(task, onEvent) ?? newRecord(task, onEvent);
      try {
        await ensureConnection(record);
        if (task.sessionId && !record.reusedIdle) {
          await record.request('thread/resume', {
            threadId: task.sessionId,
            cwd: task.cwd,
            approvalPolicy: 'on-request',
            sandbox: taskSandboxMode,
          });
          record.threadId = task.sessionId;
        } else if (!task.sessionId) {
          const thread = await record.request('thread/start', {
            cwd: task.cwd,
            ...(task.model ? { model: task.model } : {}),
            approvalPolicy: 'on-request',
            sandbox: taskSandboxMode,
          });
          record.threadId = thread.thread.id;
        }
        record.reusedIdle = false;
        record.onEvent({ type: 'session', sessionId: record.threadId });
        record.busy = true;
        record.terminal = false;
        record.cancelRequested = false;
        const result = await record.request('turn/start', {
          threadId: record.threadId,
          cwd: task.cwd,
          input: [{ type: 'text', text: typeof task.userText==='string'?task.userText:task.prompt },...(typeof task.userText==='string'&&task.sessionContext?[{type:'text',text:'中枢上下文（独立于用户原话）：\n'+task.sessionContext}]:[])],
          ...(task.model ? { model: task.model } : {}),
          approvalPolicy: 'on-request',
          sandboxPolicy: sandboxPolicy(taskSandboxMode, task.cwd),
        });
        record.turnId = result.turn?.id ?? record.turnId;
        return { sessionId: record.threadId, turnId: record.turnId };
      } catch (error) {
        await fail(record, error);
        throw error;
      }
    },
    async respond(task, approval, answer) {
      const record = active.get(task.id);
      if (!record) throw new Error(`No live Codex session for task ${task.id}`);
      const pending = record.approvals.get(String(approval.requestId ?? approval.id));
      if (pending) {
        record.write({ id: pending.id, result: approvalResponse(pending.method, { ...approval, params: pending.params }, answer) });
        record.approvals.delete(String(approval.requestId ?? approval.id));
        return { sessionId: record.threadId };
      }
      if (!record.threadId) throw new Error('Codex session has not started');
      const shouldResume = !record.child || !record.ready || record.terminal;
      record.terminal = false;
      await ensureConnection(record);
      if (shouldResume) {
        await record.request('thread/resume', {
          threadId: record.threadId,
          cwd: task.cwd,
          approvalPolicy: 'on-request',
          sandbox: sandboxMode,
        });
      }
      record.busy = true;
      record.terminal = false;
      record.cancelRequested = false;
      const result = await record.request('turn/start', {
        threadId: record.threadId,
        cwd: task.cwd,
        input: [{ type: 'text', text: String(answer ?? '') }],
        approvalPolicy: 'on-request',
        sandboxPolicy: sandboxPolicy(sandboxMode, task.cwd),
      });
      record.turnId = result.turn?.id ?? record.turnId;
      record.text = '';
      return { sessionId: record.threadId, turnId: record.turnId };
    },
    async cancel(task) {
      const record = active.get(task.id);
      if (!record) return;
      for (const [id, approval] of record.approvals) {
        try { record.write({ id: approval.id, result: approvalResponse(approval.method, approval, 'deny') }); } catch { }
        record.approvals.delete(id);
      }
      if (record.threadId && record.turnId && record.busy) {
        record.cancelRequested = true;
        record.busy = false;
        await record.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...active.values()].map(async (record) => {
        cleanupChild(record);
      }));
      active.clear();
      reporterIdle = null;
    },
  };
}
