import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';

const OPEN_SESSION_ANCHOR = 'const uiWorkspace = new UiWorkspaceService(ctx, ctx.remote.directoryPicker, workspaces, sessions, viewInstance.actions, notify);';
const MAX_PATCHABLE_SCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_QUEUED_WEBSOCKET_BYTES = 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function safeCloseFrame(code, reason) {
  const validCode = code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
  if (!validCode) return { code: 1011, reason: 'DSH upstream websocket closed unexpectedly' };
  let safeReason = String(reason || '');
  while (Buffer.byteLength(safeReason, 'utf8') > 123) safeReason = safeReason.slice(0, -1);
  return { code, reason: safeReason };
}

function loopbackBaseUrl(value, trustedHost) {
  const url = new URL(value);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname)||/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)
    || (!loopback && (!trustedHost || trustedHost!==url.hostname))
    || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')
    || url.search || url.hash) {
    throw new TypeError('DSH UI bridge only supports a plain loopback base URL');
  }
  url.pathname = '/';
  return url;
}

function workspaceScriptUrl(html, upstream) {
  const marker = 'globalThis["__DSH_BOOT__"]';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error('DSH UI bridge could not find the DSH boot manifest');
  const start = html.indexOf('=', markerIndex) + 1;
  const scriptEnd = html.indexOf('</script>', start);
  if (start < 1 || scriptEnd < 0) throw new Error('DSH UI bridge could not read the DSH boot manifest');
  let manifest;
  try { manifest = JSON.parse(html.slice(start, scriptEnd).trim().replace(/;\s*$/u, '')); }
  catch { throw new Error('DSH UI bridge could not parse the DSH boot manifest'); }
  const entry = manifest.entries?.find((candidate) => candidate.id === '@deepseek-ai/dsh-client-ui-workspace');
  if (!entry?.url) throw new Error('DSH UI bridge could not find the DSH workspace UI module');
  return new URL(entry.url, upstream);
}

export function injectDshOpenSession(source) {
  if (typeof source !== 'string') throw new TypeError('DSH workspace module must be text');
  const count = source.split(OPEN_SESSION_ANCHOR).length - 1;
  if (count !== 1) throw new Error(`DSH UI bridge injection anchor count was ${count}; expected exactly one`);
  const injected = `const hubSessionId = new URL(window.location.href).searchParams.get("hubSession");
if (hubSessionId) {
	const originalHubRestoreSelection = UiWorkspaceService.prototype.restoreSelection;
	const reportHubSessionError = () => {
		const banner = document.createElement("div");
		banner.setAttribute("role", "alert");
		banner.textContent = "无法打开指定的 DSH 会话：该会话不存在于此 DSH 实例，或已归档。";
		Object.assign(banner.style, { position: "fixed", zIndex: "2147483647", inset: "12px 12px auto", padding: "12px 16px", color: "#fff", background: "#a12222", borderRadius: "8px", font: "14px/1.4 sans-serif" });
		document.body.append(banner);
	};
	UiWorkspaceService.prototype.restoreSelection = async function(workspaceSnapshot, sessionSnapshot) {
		const summary = sessionSnapshot.byId[hubSessionId];
		if (!summary || workspaceSnapshot.archivedSessionIds.includes(hubSessionId)) {
			reportHubSessionError();
			return;
		}
		this.selection.set({ sessionId: hubSessionId });
		await originalHubRestoreSelection.call(this, workspaceSnapshot, sessionSnapshot);
		if (this.mainReference?.sessionId !== hubSessionId) this.openSession(hubSessionId);
	};
}
${OPEN_SESSION_ANCHOR}`;
  return source.replace(OPEN_SESSION_ANCHOR, injected);
}

function filteredResponseHeaders(headers, { patched = false } = {}) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (patched && ['content-length', 'content-encoding', 'etag', 'last-modified'].includes(name.toLowerCase())) continue;
    output[name] = value;
  }
  return output;
}

async function readWorkspaceModule(upstream, cookie) {
  const headers={ 'accept-encoding': 'identity', ...(cookie?{cookie}:{}) };
  const rootResponse = await fetch(upstream, { headers, signal: AbortSignal.timeout(15000) });
  if (!rootResponse.ok) throw new Error(`DSH UI bridge could not inspect upstream page (HTTP ${rootResponse.status})`);
  const html = await rootResponse.text();
  const moduleUrl = workspaceScriptUrl(html, upstream);
  const moduleResponse = await fetch(moduleUrl, { headers, signal: AbortSignal.timeout(15000) });
  if (!moduleResponse.ok) throw new Error(`DSH UI bridge could not inspect workspace UI module (HTTP ${moduleResponse.status})`);
  const source = await moduleResponse.text();
  injectDshOpenSession(source);
  return moduleUrl;
}

/**
 * Serve a loopback DSH frontend through a local reverse proxy and add a verified
 * browser-only hook that opens the requested session through DSH's own UI service.
 */
export async function createDshUiBridge({ baseUrl, trustedHost=null, launchToken=null, launchTokenProvider=null } = {}) {
  if (!baseUrl) throw new TypeError('DSH UI bridge requires a baseUrl');
  const upstream = loopbackBaseUrl(baseUrl,trustedHost);
  let upstreamCookie=null;
  let activeLaunchToken=launchToken;
  async function cookieFor(token) {
    if(!token)return null;
    const login=new URL('/',upstream);login.searchParams.set('token',token);
    const response=await fetch(login,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    const cookie=(response.headers.getSetCookie?.()||[response.headers.get('set-cookie')].filter(Boolean)).find(value=>value.includes('='))?.split(';',1)[0]||null;
    if(!cookie)throw new Error(`DSH UI bridge authentication failed (HTTP ${response.status})`);
    return cookie;
  }
  if(launchToken)upstreamCookie=await cookieFor(launchToken);
  async function refreshUpstreamCookie() {
    if(typeof launchTokenProvider!=='function')return;
    let latest;
    try { latest=await launchTokenProvider(); } catch { return; }
    if(!latest||latest===activeLaunchToken)return;
    upstreamCookie=await cookieFor(latest);
    activeLaunchToken=latest;
  }
  const moduleUrl = await readWorkspaceModule(upstream,upstreamCookie);
  const bridgeServer = createServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const upstreamSockets = new Set();
  let closed = false;
  let patchedModuleResponses = 0;
  let bridgeOrigin;
  let bridgeHost;

  function validInbound(req) {
    if (String(req.headers.host || '').toLowerCase() !== bridgeHost.toLowerCase()) return false;
    const origin = req.headers.origin;
    if (origin === undefined) return !req.headers.upgrade && ['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET');
    return origin === bridgeOrigin;
  }

  async function requestUpstream(req, res) {
    await refreshUpstreamCookie();
    let target;
    try { target = new URL(req.url || '/', upstream); }
    catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Invalid DSH UI proxy target');
      return;
    }
    if (target.origin !== upstream.origin || target.username || target.password) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('DSH UI bridge target is fixed');
      return;
    }
    const headers = { ...req.headers, host: upstream.host, 'accept-encoding': 'identity' };
    if(upstreamCookie)headers.cookie=upstreamCookie;
    if (req.headers.origin) headers.origin = upstream.origin;
    delete headers['sec-fetch-site'];
    delete headers.forwarded;
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-for'];
    const request = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: req.method,
      headers,
      timeout: 30000,
    }, (response) => {
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (!/(?:javascript|ecmascript)/u.test(contentType)) {
        res.writeHead(response.statusCode || 502, filteredResponseHeaders(response.headers));
        response.pipe(res);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_PATCHABLE_SCRIPT_BYTES) {
          response.destroy(new Error('DSH workspace UI module exceeds the bridge patch limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const source = Buffer.concat(chunks).toString('utf8');
          if (!source.includes(OPEN_SESSION_ANCHOR)) {
            res.writeHead(response.statusCode || 200, filteredResponseHeaders(response.headers));
            res.end(source);
            return;
          }
          const patched = injectDshOpenSession(source);
          patchedModuleResponses += 1;
          res.writeHead(response.statusCode || 200, {
            ...filteredResponseHeaders(response.headers, { patched: true }),
            'x-dsh-ui-bridge': 'workspace-open-session',
          });
          res.end(patched);
        } catch (error) {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end(`DSH UI bridge injection failed: ${error.message}`);
          } else res.destroy(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('DSH UI upstream request timed out')));
    request.on('error', (error) => {
      if (res.headersSent) res.destroy(error);
      else {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('DSH UI upstream is unavailable');
      }
    });
    req.pipe(request);
  }

  bridgeServer.on('request', (req, res) => {
    if (!validInbound(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('DSH UI bridge accepts same-origin loopback requests only');
      return;
    }
    void requestUpstream(req, res).catch(() => {
      if(!res.headersSent){res.writeHead(502,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end('DSH upstream authentication is unavailable');}
      else res.destroy();
    });
  });

  bridgeServer.on('upgrade', (req, socket, head) => {
    void (async()=>{
    await refreshUpstreamCookie();
    if (!validInbound(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let target;
    try { target = new URL(req.url || '/', upstream); }
    catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (target.origin !== upstream.origin || target.username || target.password) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(req, socket, head, (client) => {
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((item) => item.trim()).filter(Boolean);
      const headers = {};
      if (upstreamCookie) headers.cookie = upstreamCookie;
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      if (req.headers.origin) headers.origin = upstream.origin;
      const remote = new WebSocket(target, protocols, { headers, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
      upstreamSockets.add(remote);
      const queued = [];
      let queuedBytes = 0;
      client.on('message', (data, isBinary) => {
        if (remote.readyState === WebSocket.OPEN) {
          remote.send(data, { binary: isBinary });
          return;
        }
        if (remote.readyState !== WebSocket.CONNECTING) return;
        const size = data.byteLength ?? data.length ?? 0;
        if (queuedBytes + size > MAX_QUEUED_WEBSOCKET_BYTES) {
          client.close(1009, 'DSH bridge upstream is not ready');
          remote.terminate();
          return;
        }
        queued.push({ data, isBinary });
        queuedBytes += size;
      });
      remote.once('open', () => {
        if (client.readyState !== WebSocket.OPEN) {
          remote.terminate();
          return;
        }
        for (const item of queued) remote.send(item.data, { binary: item.isBinary });
        queued.length = 0;
        queuedBytes = 0;
      });
      remote.on('message', (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
      remote.on('ping', (data) => { if (client.readyState === WebSocket.OPEN) client.ping(data); });
      client.on('ping', (data) => { if (remote.readyState === WebSocket.OPEN) remote.ping(data); });
      remote.once('close', () => upstreamSockets.delete(remote));
      const closeBoth = (code, reason) => {
        const close = safeCloseFrame(code, reason);
        if (client.readyState === WebSocket.OPEN) client.close(close.code, close.reason);
        if (remote.readyState === WebSocket.OPEN) remote.close(close.code, close.reason);
      };
      remote.on('close', closeBoth);
      client.on('close', () => { closeBoth(); if (remote.readyState !== WebSocket.CLOSED) remote.terminate(); });
      remote.on('error', () => { if (client.readyState === WebSocket.OPEN) client.close(1011, 'DSH upstream websocket failed'); });
      client.on('error', () => { if (remote.readyState === WebSocket.OPEN) remote.close(1011, 'DSH bridge websocket failed'); });
    });
    })().catch(()=>{try{socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');}catch{}socket.destroy();});
  });

  await new Promise((resolve, reject) => {
    bridgeServer.once('error', reject);
    bridgeServer.listen(0, '127.0.0.1', () => {
      bridgeServer.off('error', reject);
      resolve();
    });
  });
  const address = bridgeServer.address();
  bridgeHost = `127.0.0.1:${address.port}`;
  bridgeOrigin = `http://${bridgeHost}`;
  const base = bridgeOrigin;

  return {
    baseUrl: base,
    get patchedModuleResponses() { return patchedModuleResponses; },
    sessionUrl(sessionId) {
      const value = String(sessionId ?? '');
      if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('A valid DSH session ID is required');
      const url = new URL('/', base);
      url.searchParams.set('hubSession', value);
      return url.toString();
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      for (const client of websocketServer.clients) client.terminate();
      for (const remote of upstreamSockets) remote.terminate();
      const websocketClose = new Promise((resolve) => websocketServer.close(() => resolve()));
      const httpClose = new Promise((resolve, reject) => {
        bridgeServer.close((error) => error ? reject(error) : resolve());
        bridgeServer.closeAllConnections();
      });
      return Promise.all([websocketClose, httpClose]).then(() => undefined);
    },
  };
}
