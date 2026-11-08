import { containsCredential, redact } from '../redact.mjs';
import { validateConditions } from './computer-postconditions.mjs';

export const READ_ONLY_COMPUTER_TOOLS = Object.freeze(['list_apps', 'list_windows', 'get_window_state']);
export const INTERACTIVE_COMPUTER_TOOLS = Object.freeze(['click', 'type_text', 'press_key', 'scroll']);

const ELEMENT_TOKEN = /^s[0-9a-f]{8}:[0-9]+$/i;

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

/** Validate a bounded interactive action against an exact window and fresh UIA element token. */
export function validateComputerAction(tool, args) {
  if (READ_ONLY_COMPUTER_TOOLS.includes(tool)) return validateReadOnlyComputerAction(tool, args);
  if (!INTERACTIVE_COMPUTER_TOOLS.includes(tool)) throw new Error('Computer action is not enabled');
  const fieldsByTool = {
    click: ['pid', 'window_id', 'element_token', 'button', 'count'],
    type_text: ['pid', 'window_id', 'element_token', 'text'],
    press_key: ['pid', 'window_id', 'element_token', 'key'],
    scroll: ['pid', 'window_id', 'element_token', 'direction', 'amount', 'by'],
  };
  const fields = fieldsByTool[tool];
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('CUA tool arguments must be an object');
  if (Object.keys(args).some(key => !fields.includes(key))) throw new TypeError('Unsupported computer tool argument');
  if (!Number.isSafeInteger(args.pid) || args.pid < 1 || args.pid > 0xffffffff) throw new TypeError(`${tool} requires a valid target pid`);
  if (!Number.isSafeInteger(args.window_id) || args.window_id < 1) throw new TypeError(`${tool} requires a valid target window_id`);
  if (typeof args.element_token !== 'string' || !ELEMENT_TOKEN.test(args.element_token)) throw new TypeError(`${tool} requires an exact element_token from a fresh window snapshot`);
  if (tool === 'type_text') {
    if (typeof args.text !== 'string' || args.text.length < 1 || args.text.length > 160 || /[\u0000-\u001f\u007f]/.test(args.text)) throw new TypeError('type_text accepts 1–160 printable characters with no control characters');
    if (containsCredential(args.text) || redact(args.text) !== args.text || /(?:password|passwd|api[_-]?key|access[_-]?token|secret|bearer)\s*[:=]/i.test(args.text)) throw new TypeError('Credential-like text cannot be sent to the desktop');
    const preview = args.text.replace(/\s+/g, ' ').trim().slice(0, 72);
    return `在指定窗口控件输入：“${preview}${args.text.length > 72 ? '…' : ''}”`;
  }
  if (tool === 'click') {
    if (args.button !== undefined && !['left', 'right', 'middle'].includes(args.button)) throw new TypeError('click button is invalid');
    if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > 3)) throw new TypeError('click count must be 1–3');
    return `点击指定窗口控件（${args.button || 'left'}）`;
  }
  if (tool === 'press_key') {
    if (typeof args.key !== 'string' || !/^(?:ENTER|TAB|ESC|BACKSPACE|DELETE|HOME|END|PAGEUP|PAGEDOWN|UP|DOWN|LEFT|RIGHT|CTRL\+[A-Z]|ALT\+[A-Z]|SHIFT\+[A-Z]|CTRL\+ALT\+[A-Z])$/.test(args.key)) throw new TypeError('press_key key is not in the safe key set');
    return `在指定窗口控件按键 ${args.key}`;
  }
  if (!['up', 'down', 'left', 'right'].includes(args.direction)) throw new TypeError('scroll direction is invalid');
  if (args.amount !== undefined && (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > 10)) throw new TypeError('scroll amount must be 1–10');
  if (args.by !== undefined && !['line', 'page'].includes(args.by)) throw new TypeError('scroll by must be line or page');
  return `滚动指定窗口 ${args.direction} ${args.amount || 3} ${args.by || 'line'}`;
}

export function validateComputerConditions(precondition, postcondition, fileValidator) {
  validateConditions(precondition, postcondition, fileValidator);
  return true;
}
