import { spawn as nodeSpawn } from 'node:child_process';
import { INTERACTIVE_COMPUTER_TOOLS, READ_ONLY_COMPUTER_TOOLS, validateComputerAction } from './action-contract.mjs';

const PIPE_PREFIX = '\\\\.\\pipe\\';

export class CuaDriverCallError extends Error {
  constructor(code, message, { uncertain = false } = {}) {
    super(message);
    this.name = 'CuaDriverCallError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

function validPipe(pipe) {
  if (typeof pipe !== 'string' || !pipe.startsWith(PIPE_PREFIX)) return false;
  const name = pipe.slice(PIPE_PREFIX.length);
  return /^[A-Za-z0-9_.-]{1,120}$/.test(name) && name.toLowerCase() !== 'cua-driver';
}

function encodeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('CUA tool arguments must be a JSON object');
  let encoded;
  try { encoded = JSON.stringify(args); } catch { throw new TypeError('CUA tool arguments must be JSON serializable'); }
  if (encoded === undefined) throw new TypeError('CUA tool arguments must be JSON serializable');
  return encoded;
}

/** Narrow client for the documented `cua-driver call` CLI. Does not launch/manage the daemon. */
export class CuaDriverClient {
  constructor({ socket, allowedTools, interactiveAllowed = false, executable = 'cua-driver', spawn = nodeSpawn, timeoutMs = 30_000 } = {}) {
    if (!validPipe(socket)) throw new TypeError('CUA socket must be a dedicated Windows named pipe');
    const permitted = interactiveAllowed ? [...READ_ONLY_COMPUTER_TOOLS, ...INTERACTIVE_COMPUTER_TOOLS] : READ_ONLY_COMPUTER_TOOLS;
    if (!Array.isArray(allowedTools) || allowedTools.length === 0 || allowedTools.some((t) => !permitted.includes(t))) {
      throw new TypeError('CUA allowedTools must be a subset of the explicitly enabled code-owned tool list');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) throw new RangeError('Invalid CUA timeout');
    this.socket = socket;
    this.allowedTools = new Set(allowedTools);
    this.executable = executable;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
  }

  call(tool, args = {}, { signal } = {}) {
    if (!this.allowedTools.has(tool)) return Promise.reject(new CuaDriverCallError('tool_not_allowed', 'CUA tool is not allowed'));
    let input;
    try {
      encodeArgs(args);
      validateComputerAction(tool, args);
      const driverArgs = tool === 'type_text'
        ? { pid: args.pid, element_token: args.element_token, text: args.text, delivery_mode: 'background' }
        : args;
      input = encodeArgs(driverArgs);
    } catch (error) {
      if (error instanceof TypeError && /JSON object/.test(error.message)) return Promise.reject(error);
      return Promise.reject(new CuaDriverCallError('invalid_arguments', 'CUA tool arguments are invalid'));
    }
    if (signal?.aborted) return Promise.reject(new CuaDriverCallError('aborted', 'CUA call was cancelled'));

    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let requestWritten = false;
      let stdout = '';
      let outBytes = 0;
      const finishError = (code, message, uncertain = requestWritten) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { child?.kill(); } catch {}
        reject(new CuaDriverCallError(code, message, { uncertain }));
      };
      const onAbort = () => finishError('aborted', 'CUA call was cancelled', requestWritten);
      const timer = setTimeout(() => finishError('timeout', 'CUA call timed out', requestWritten), this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        child = this.spawn(this.executable, ['call', '--socket', this.socket, tool], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        finishError('spawn_failed', 'Unable to start CUA Driver call', false);
        return;
      }
      child.stdout?.on('data', (chunk) => {
        outBytes += Buffer.byteLength(chunk);
        if (outBytes > 8 * 1024 * 1024) finishError('response_too_large', 'CUA response exceeded the size limit');
        else stdout += chunk.toString();
      });
      // Deliberately consume but never retain or expose stderr: it can contain desktop content.
      child.stderr?.on('data', () => {});
      child.on('error', () => finishError('process_error', 'CUA Driver call process failed'));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) return finishError('call_failed', 'CUA Driver call failed');
        try {
          const result = JSON.parse(stdout);
          settled = true;
          cleanup();
          resolve(result);
        } catch {
          finishError('invalid_response', 'CUA Driver returned an invalid response');
        }
      });
      child.stdin?.on('error', () => finishError('request_write_failed', 'Unable to send CUA request'));
      requestWritten = true;
      child.stdin?.end(input);
    });
  }
}

