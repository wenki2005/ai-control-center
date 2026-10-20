import { containsCredential, redact } from '../redact.mjs';

export const READ_ONLY_COMPUTER_TOOLS = Object.freeze(['list_apps', 'list_windows', 'get_window_state']);
export const INTERACTIVE_COMPUTER_TOOLS = Object.freeze(['type_text']);

const SCHEMAS = Object.freeze({
  list_apps: Object.freeze([]),
  list_windows: Object.freeze(['on_screen_only']),
  get_window_state: Object.freeze(['pid', 'window_id']),
});

/** Validate the exact first-stage CUA request and return its user-visible purpose. */
export function validateReadOnlyComputerAction(tool, args) {
  const fields = SCHEMAS[tool];
  if (!fields) throw new Error('Only read-only computer inspection tools are enabled');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('CUA tool arguments must be an object');
  if (Object.keys(args).some((key) => !fields.includes(key))) throw new TypeError('Unsupported computer tool argument');
  if (tool === 'list_windows' && args.on_screen_only !== undefined && args.on_screen_only !== true) throw new TypeError('list_windows may only include on-screen windows');
  if (tool === 'get_window_state') {
    if (!Number.isSafeInteger(args.pid) || args.pid < 1 || args.pid > 0xffffffff) throw new TypeError('get_window_state requires a valid pid');
    if (!Number.isSafeInteger(args.window_id) || args.window_id < 1) throw new TypeError('get_window_state requires a valid window_id');
    return `读取窗口 PID ${args.pid}、窗口 ID ${args.window_id} 的状态和截图`;
  }
  return tool === 'list_apps' ? '列出应用信息' : '枚举当前可见窗口';
}

/** First interactive pilot: plain text into an exact Notepad accessibility element. */
export function validateComputerAction(tool, args) {
  if (READ_ONLY_COMPUTER_TOOLS.includes(tool)) return validateReadOnlyComputerAction(tool, args);
  if (tool !== 'type_text') throw new Error('Only approved read-only actions and the bounded Notepad text pilot are supported');
  const fields = ['pid', 'window_id', 'element_token', 'text'];
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('CUA tool arguments must be an object');
  if (Object.keys(args).some(key => !fields.includes(key))) throw new TypeError('Unsupported computer tool argument');
  if (!Number.isSafeInteger(args.pid) || args.pid < 1 || args.pid > 0xffffffff) throw new TypeError('type_text requires a valid target pid');
  if (!Number.isSafeInteger(args.window_id) || args.window_id < 1) throw new TypeError('type_text requires a valid target window_id');
  if (typeof args.element_token !== 'string' || !/^s[0-9a-f]{8}:[0-9]+$/i.test(args.element_token)) throw new TypeError('type_text requires an exact element_token from a fresh window snapshot');
  if (typeof args.text !== 'string' || args.text.length < 1 || args.text.length > 160 || /[\u0000-\u001f\u007f]/.test(args.text)) throw new TypeError('type_text accepts 1–160 printable characters with no control characters');
  if (containsCredential(args.text) || redact(args.text) !== args.text || /(?:password|passwd|api[_-]?key|access[_-]?token|secret|bearer)\s*[:=]/i.test(args.text)) throw new TypeError('Credential-like text cannot be sent to the desktop');
  const preview = args.text.replace(/\s+/g, ' ').trim().slice(0, 72);
  return `在指定 Notepad 窗口输入：“${preview}${args.text.length > 72 ? '…' : ''}”`;
}
