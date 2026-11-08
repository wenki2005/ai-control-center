import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const LAUNCH_LINE = /dsh web:\s*(https?:\/\/[^\s]+)/i;

// Only enable submission retries for the installed controller whose request
// identity is checked against both queued messages and persisted user events.
// Unknown/new implementations fail closed until their contract is reviewed.
export function localDshPromptDedup({controllerPath=(process.env.DSH_CONTROLLER_PATH || ''),readFile=readFileSync}={}) {
  try {
    const source=String(readFile(controllerPath,'utf8'));
    return /hasPromptRequest\(agent,\s*request\.requestId\)/u.test(source)
      && /source\.rpcId\s*===\s*requestId/u.test(source)
      && /agent\.inbox\.nextTurn\.some\(matches\)/u.test(source)
      && /agent\.session\.snapshotEvents\(\)/u.test(source);
  }catch{return false;}
}

/**
 * Find the authenticated local DSH URL announced by its own startup log.
 * The launch token stays in process memory and is never returned to callers
 * that build UI/API state.
 */
export function discoverLocalDsh({ logPath = (process.env.DSH_LOG_PATH || ''), addresses = localAddresses(), readFile = readFileSync } = {}) {
  let contents;
  try { contents = readFile(logPath, 'utf8'); }
  catch { return null; }

  const known = new Set(addresses);
  const lines = String(contents).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = LAUNCH_LINE.exec(lines[index]);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      const token = url.searchParams.get('token');
      if (url.protocol !== 'http:' || url.port !== '3080' || !url.hostname || !token || url.username || url.password) continue;
      if (!known.has(url.hostname)) continue;
      return { baseUrl: `${url.origin}`, host: url.hostname, launchToken: token };
    } catch { /* Ignore malformed log entries. */ }
  }
  return null;
}

/**
 * A local DSH build can announce a LAN URL even when its web server is bound
 * only to loopback. Prefer the loopback endpoint only after it responds; keep
 * the discovered launch token in memory and retain the announced URL when the
 * loopback listener is unavailable.
 */
export async function preferReachableLoopback(discovered, {
  fetchImpl = fetch,
  url = 'http://127.0.0.1:3080/',
  timeoutMs = 1500,
} = {}) {
  if (!discovered) return null;
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 500) {
      const endpoint = new URL(url);
      return { ...discovered, baseUrl: endpoint.origin, host: endpoint.hostname };
    }
  } catch { /* Keep the announced local endpoint when loopback is not ready. */ }
  return discovered;
}

function localAddresses() {
  return Object.values(networkInterfaces()).flat().filter(Boolean).map(entry => entry.address);
}
