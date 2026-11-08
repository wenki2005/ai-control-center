import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';

const DEFAULT_CLI = 'C:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy';
const ALLOWED_TOOLS = 'Read,Write,Edit,Glob,Grep';
const DISALLOWED_TOOLS = [
  'Agent', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Skill', 'AskUserQuestion',
  'ToolSearch', 'DeferExecuteTool', 'SendMessage', 'TeamCreate', 'TeamDelete', 'ImageGen',
  'VideoGen', 'WeChatReply', 'WeComReply', 'ListMcpResources', 'ReadMcpResource',
  'MessageColleague', 'SpeakInChannel',
].join(',');
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
const MAX_LINE_LENGTH = 2 * 1024 * 1024;
const MAX_STDERR_LENGTH = 12_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function safeText(value, limit = 4000) {
  return String(value ?? 'Unknown WorkBuddy CLI error')
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|(?:authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)[=: ]+\S+)/gi, '[redacted]')
    .replace(/([?&](?:token|access_token|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, limit);
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('');
}

function isPermissionDenied(result) {
  return Array.isArray(result?.permission_denials) && result.permission_denials.length > 0;
}

export function createWorkBuddyAdapter(options = {}) {
  const executable = options.command ?? process.execPath;
  const argsPrefix = options.argsPrefix ?? [options.cliPath ?? options.binaryPath ?? DEFAULT_CLI];
  const spawn = options.spawnImpl ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const active = new Map();
  let closed = false;

  function fail(record, message) {
    if (record.terminal || record.cancelRequested || closed) return;
    record.terminal = true;
    clearTimeout(record.timeout);
    record.onEvent({ type: 'failed', error: safeText(message) });
  }

  function setSession(record, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (record.sessionId && record.sessionId !== sessionId) {
      fail(record, 'WorkBuddy CLI returned a different session ID while resuming; refusing to switch sessions');
      return;
    }
    record.sessionId ??= sessionId;
    if (!record.sessionEmitted) {
      record.sessionEmitted = true;
      record.onEvent({ type: 'session', sessionId: record.sessionId });
    }
  }

  function finishResult(record, event) {
    if (record.terminal) return;
    const eventSession = event.session_id ?? event.sessionId;
    if (eventSession) setSession(record, eventSession);
    if (record.terminal) return;
    if (isPermissionDenied(event)) {
      fail(record, 'WorkBuddy denied one or more requested tools under its headless permission policy');
      return;
    }
    if (event.is_error === true || event.subtype !== 'success') {
      const detail = typeof event.error === 'string' ? event.error
        : event.error?.message ?? event.result ?? event.subtype ?? 'unsuccessful terminal result';
      fail(record, detail);
      return;
    }
    record.terminal = true;
    clearTimeout(record.timeout);
    const text = typeof event.result === 'string' && event.result
      ? event.result
      : record.lastMessage;
    record.onEvent({ type: 'completed', text: safeText(text, 50_000) });
  }

  function handleLine(record, line) {
    if (!line.trim() || record.terminal) return;
    if (line.length > MAX_LINE_LENGTH) {
      fail(record, `WorkBuddy CLI emitted a JSONL event larger than ${MAX_LINE_LENGTH} characters`);
      return;
    }
    let event;
    try { event = JSON.parse(line); }
    catch { return; }
    if (!event || typeof event !== 'object') return;
    const eventSession = event.session_id ?? event.sessionId;
    if (eventSession) setSession(record, eventSession);
    if (record.terminal) return;
    if (event.type === 'assistant') {
      const text = textFromMessage(event.message);
      if (text) {
        record.lastMessage = text;
        record.onEvent({ type: 'message', text: safeText(text, 50_000) });
      }
      return;
    }
    if (event.type === 'result') finishResult(record, event);
  }

  function argsFor(task, sessionId) {
    return [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--tools', ALLOWED_TOOLS,
      '--allowedTools', ALLOWED_TOOLS,
      '--disallowedTools', DISALLOWED_TOOLS,
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
      '--permission-mode', 'acceptEdits',
      ...(task.model ? ['--model', String(task.model)] : []),
      ...(sessionId ? ['--resume', sessionId] : []),
    ];
  }

  function launch(task, onEvent) {
    if (closed) throw new Error('WorkBuddy adapter is closed');
    if (!task?.id || !task?.cwd || !task?.prompt) throw new TypeError('WorkBuddy task requires id, cwd, and prompt');
    const previous = active.get(task.id);
    if (previous?.child && !previous.child.killed) {
      previous.cancelRequested = true;
      clearTimeout(previous.timeout);
      previous.child.kill();
      previous.lines?.close();
    }
    const sessionId = task.sessionId ?? previous?.sessionId ?? null;
    const record = {
      task, sessionId, sessionEmitted: false, child: null, lines: null,
      onEvent, lastMessage: '', stderr: '', terminal: false,
      cancelRequested: false, exited: false, exitCode: null, exitSignal: null, timeout: null,
    };
    active.set(task.id, record);
    if (sessionId) setSession(record, sessionId);

    let child;
    try {
      child = spawn(executable, [...argsPrefix, ...argsFor(task, sessionId)], {
        cwd: task.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...((options.env||task.workbuddyConfigDir)?{env:{...process.env,...options.env,...(task.workbuddyConfigDir?{CODEBUDDY_CONFIG_DIR:task.workbuddyConfigDir}:{})}}:{}),
      });
    } catch (error) {
      active.delete(task.id);
      throw new Error(safeText(error?.message ?? error));
    }
    record.child = child;
    record.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    record.lines.on('line', (line) => handleLine(record, line));
    child.stderr.on('data', (chunk) => {
      if (record.stderr.length >= MAX_STDERR_LENGTH) return;
      record.stderr += safeText(chunk.toString(), MAX_STDERR_LENGTH - record.stderr.length);
    });
    child.stdin?.on('error', (error) => {
      if (record.cancelRequested || record.terminal || closed) return;
      fail(record, `Unable to send the prompt to WorkBuddy CLI: ${safeText(error?.message ?? error)}`);
      if (!child.killed) child.kill();
    });
    child.once('error', (error) => {
      const message = safeText(error?.message ?? error);
      fail(record, `Unable to start WorkBuddy CLI: ${message}`);
    });
    child.once('exit', (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.exitSignal = signal;
    });
    child.once('close', (code, signal) => {
      record.exited = true;
      record.exitCode = code ?? record.exitCode;
      record.exitSignal = signal ?? record.exitSignal;
      record.lines?.close();
      if (record.cancelRequested || closed || record.terminal) return;
      if (record.exitCode !== 0) {
        const detail = record.stderr.trim();
        fail(record, `WorkBuddy CLI exited (${record.exitSignal ?? record.exitCode ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
      } else {
        fail(record, 'WorkBuddy CLI exited successfully without a terminal result event');
      }
    });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      record.timeout = setTimeout(() => {
        fail(record, `WorkBuddy CLI timed out after ${timeoutMs} ms`);
        if (!child.killed && !record.exited) child.kill();
      }, timeoutMs);
      record.timeout.unref?.();
    }
    try {
      if (!child.stdin || child.stdin.destroyed) throw new Error('WorkBuddy CLI stdin is unavailable');
      child.stdin.end(String(task.prompt));
    } catch (error) {
      record.cancelRequested = true;
      clearTimeout(record.timeout);
      child.kill();
      throw new Error(safeText(error?.message ?? error));
    }
    return { record, result: { sessionId: record.sessionId } };
  }

  return {
    async start(task, onEvent) {
      const { result } = launch(task, onEvent);
      return result;
    },
    async respond(task, approval, answer) {
      if (approval?.requestId || approval?.id) {
        throw new Error('WorkBuddy headless CLI does not expose a native approval response channel');
      }
      const record = active.get(task?.id);
      const sessionId = task?.sessionId ?? record?.sessionId;
      if (!sessionId) throw new Error(`No WorkBuddy session is available for task ${task?.id ?? '(unknown)'}`);
      return this.start({ ...task, prompt: String(answer ?? ''), sessionId }, record?.onEvent ?? (() => {}));
    },
    async cancel(task) {
      const record = active.get(task?.id);
      if (!record || record.exited || !record.child || record.child.killed) return;
      record.cancelRequested = true;
      clearTimeout(record.timeout);
      record.child.kill();
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const record of active.values()) {
        record.cancelRequested = true;
        clearTimeout(record.timeout);
        record.lines?.close();
        if (record.child && !record.exited && !record.child.killed) record.child.kill();
      }
      active.clear();
    },
  };
}
