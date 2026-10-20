// Hard ceiling for every CUA client in this application. Deployment callers
// may narrow this set, but cannot opt into the wider driver's browser, script,
// clipboard, process, download, session, or persistent-configuration tools.
export const SAFE_COMPUTER_TOOLS = Object.freeze([
  'list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'get_desktop_state',
  'click', 'type_text', 'press_key', 'scroll'
]);

export function isSafeComputerTool(name) {
  return typeof name === 'string' && SAFE_COMPUTER_TOOLS.includes(name);
}
