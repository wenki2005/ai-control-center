import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import WebSocket from 'ws';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sessionDisplayName } from '../session-label.mjs';

const STREAM_PATH = '/api/remote.mux';
const RECONNECT_DELAYS_MS = Object.freeze([250, 750, 1500, 3000]);
// The installed DSH profile has previously blocked its event loop for about
// 63 seconds during a synchronous session-health scan. Allow that known pause
// to finish; connection-refused errors still fail immediately.
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_EVENT_STREAM_TIMEOUT_MS = 75_000;

function safeMessage(error) {
  return String(error?.message ?? error ?? 'Unknown DSH error')
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|token[=: ]+\S+)/gi, '[redacted]')
    .slice(0, 4000);
}

function turnFailureMessage(reason) {
  const error=reason?.error;
  const kind=typeof reason?.kind==='string' ? reason.kind.slice(0,40) : '';
  const name=typeof error?.name==='string' ? error.name.replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80) : '';
  const code=typeof error?.code==='string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : '';
  const details=[kind&&`kind=${kind}`,name&&`name=${name}`,code&&`code=${code}`].filter(Boolean);
  const message=safeMessage(error?.message ?? reason?.kind ?? 'DSH turn failed');
  return details.length ? `${details.join(', ')}: ${message}` : message;
}

function responseText(record) {
  const message = record?.data?.message;
  if (typeof message?.text === 'string') return message.text;
  return (message?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

function userMessageText(record) {
  const data = record?.event?.data;
  const content = data?.content ?? data?.message?.content ?? data?.message?.text ?? data?.text;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

function matchesPrompt(record,item) {
  if(record.followRequestId)return item?.event?.data?.source?.rpcId===record.followRequestId;
  return !!record.followPromptMarker&&userMessageText(item).includes(record.followPromptMarker);
}

function awaitsPrompt(record) { return !!(record.followRequestId||record.followPromptMarker); }

function visibleSessionTitle(task) {
  return task?.displayTitle ? String(task.displayTitle).slice(0,120) : sessionDisplayName(task);
}

function imageMediaType(bytes) {
  if(bytes.length>=8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff)return 'image/jpeg';
  if(bytes.length>=12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  if(bytes.length>=6 && /^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return 'image/gif';
  return null;
}

export async function imagePromptBlocks(paths, imageRoots) {
  if(!Array.isArray(paths) || !paths.length)return [];
  if(paths.length>4)throw new Error('一条消息最多向视觉会话传 4 张图片');
  const roots=(Array.isArray(imageRoots)?imageRoots:[imageRoots]).filter(value=>typeof value==='string'&&value);
  if(!roots.length)throw new Error('DSH 视觉附件目录未配置，未发送图片路径或内容');
  const allowedRoots=await Promise.all(roots.map(value=>realpath(value))),blocks=[];let total=0;
  for(const candidate of paths) {
    if(typeof candidate!=='string' || !isAbsolute(candidate))throw new Error('视觉附件路径无效');
    const file=await realpath(candidate),allowed=allowedRoots.some(root=>{const rel=relative(root,file);return !!rel&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);});
    if(!allowed)throw new Error('视觉附件不在允许的 QQ 收件或个人文件库目录内');
    const info=await stat(file);
    if(!info.isFile() || info.size>8*1024*1024)throw new Error('视觉附件不是普通图片或超过 8 MB');
    total+=info.size;if(total>16*1024*1024)throw new Error('本条消息图片总量超过 16 MB');
    const bytes=await readFile(file),mediaType=imageMediaType(bytes);
    if(!mediaType)throw new Error('视觉附件不是受支持的 PNG、JPEG、WebP 或 GIF 图片');
    blocks.push({type:'image',mediaType,data:bytes.toString('base64')});
  }
  return blocks;
}

export function createDshAdapter(options = {}) {
  const baseUrl = new URL(options.baseUrl ?? 'http://127.0.0.1:3180');
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname) || /^127(?:\.\d{1,3}){3}$/.test(baseUrl.hostname);
  if (baseUrl.protocol !== 'http:' || (!isLoopback && (!options.trustedHost || baseUrl.hostname !== options.trustedHost))) {
    throw new TypeError('DSH adapter only supports a loopback host');
  }
  let cookie = options.cookie;
  const active = new Map();
  const cancelledTasks = new Set();
  const pendingQuestions = new Map();
  let socket;
  let closed = false;
  let socketReady;
  let heartbeat;
  const reconnecting = new Set();
  const workspaces = new Map();
  const sessionTitles = new Map();
  const sessionModels = new Map();
  // A DSH session's project directory is immutable. Cache only sessions this
  // adapter created or whose directory it verified through session/list. This
  // avoids rescanning a large DSH session catalog on every turn of a persistent
  // director/reporter conversation, while a cold session still gets validated.
  const sessionCwds = new Map();
  const defaultLaunchTokenFile = options.baseUrl === undefined || baseUrl.port === '3180'
    ? new URL('../../runtime/dsh-home/.launch-token', import.meta.url)
    : null;

  async function ensureCookie({ refresh = false } = {}) {
    if (refresh) cookie = undefined;
    if (cookie) return cookie;
    let launchToken;
    if (typeof options.launchTokenProvider === 'function') {
      try { launchToken = await options.launchTokenProvider(); }
      catch { /* fall through to the configured token source */ }
    }
    launchToken ||= options.launchToken;
    const launchTokenFile = options.launchTokenFile ?? defaultLaunchTokenFile;
    if (!launchToken && launchTokenFile) {
      try { launchToken = (await readFile(launchTokenFile, 'utf8')).trim(); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    if (!launchToken) return undefined;
    const url = new URL('/', baseUrl);
    url.searchParams.set('token', launchToken);
    const response = await (options.fetch ?? fetch)(url, { redirect: 'manual', signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) });
    const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
    const sessionCookie = cookies.find((value) => value.includes('=') && !/^expires=/i.test(value));
    if (sessionCookie) {
      cookie = sessionCookie.split(';', 1)[0];
      return cookie;
    }
    // The DSH web server authorizes loopback requests directly. In that case
    // GET / serves the index without issuing the browser-only signed cookie.
    if (response.ok) return undefined;
    throw new Error(`DSH launch-token exchange failed with HTTP ${response.status}`);
  }

  function requestHeaders() {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (options.headers) Object.assign(headers, options.headers);
    return headers;
  }

  async function call(endpoint, namedArgs, signal, timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) {
    const startedAt = Date.now();
    try {
    await ensureCookie();
    const rpcId = randomUUID();
    const url = new URL(`/api/${endpoint}`, baseUrl);
    const body = JSON.stringify({
      type: 'client-request', rpcId, method: endpoint,
      payload: { args: namedArgs },
    });
    let response;
    let authAttempt = 0, transportAttempt = 0;
    for (;;) {
      if (authAttempt) await ensureCookie({ refresh: true });
      else await ensureCookie();
      try {
        response = await (options.fetch ?? fetch)(url, {
          method: 'POST', headers: requestHeaders(), body,
          signal: signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // The installed DSH controller deduplicates prompts by requestId from
        // both its pending queues and persisted user/message history. Reuse
        // the exact same RPC body/id for one bounded transport retry only when
        // the caller explicitly verified that server capability.
        const transient = /fetch failed|timeout|aborted|ECONNRESET|ECONNREFUSED|UND_ERR_SOCKET|EPIPE/i.test(`${error?.message ?? ''} ${error?.code ?? ''}`);
        if (endpoint === 'session/prompt' && options.promptRequestDedup === true && transportAttempt < 1 && transient) {
          transportAttempt++;
          continue;
        }
        throw error;
      }
      if (![401, 403].includes(response.status) || authAttempt || typeof options.launchTokenProvider !== 'function') break;
      authAttempt++;
    }
    if (!response.ok) throw new Error(`DSH RPC ${endpoint} failed with HTTP ${response.status}`);
    const envelope = await response.json();
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || !envelope.result) {
      throw new Error(`DSH RPC ${endpoint} returned an invalid response`);
    }
    if (!envelope.result.ok) throw new Error(envelope.result.error?.message ?? `DSH RPC ${endpoint} failed`);
    return envelope.result.value;
    } catch (error) {
      const wrapped = new Error(`DSH RPC ${endpoint} (${Date.now()-startedAt}ms): ${safeMessage(error)}`, { cause: error });
      wrapped.endpoint = endpoint;
      throw wrapped;
    }
  }

  async function retryPreflight(operation) {
    for(let attempt=0; ; attempt++) {
      try{return await operation();}catch(error){
        if(attempt>=1 || !/timeout|aborted|fetch failed|ECONNRESET|ECONNREFUSED|HTTP 50[234]/i.test(String(error.message)))throw error;
      }
    }
  }

  async function workspaceFor(path) {
    const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (!workspaces.has(key)) {
      const pending = (async () => {
        // Resolving the same project is idempotent. DSH serializes this RPC
        // with workspace mutations, so do not repeat it for every chat turn.
        // Retry only this pre-prompt lookup; never replay session/prompt.
        const result=await retryPreflight(()=>call('workspace/create',{request:{path}}));
        return result?.workspace ?? result;
      })();
      workspaces.set(key,pending);
      pending.catch(()=>{if(workspaces.get(key)===pending)workspaces.delete(key);});
    }
    return workspaces.get(key);
  }

  function listedSessionCwd(value, sessionId) {
    const rows = Array.isArray(value?.items) ? value.items : [];
    const row = rows.find((item) => item?.sessionId === sessionId);
    const cwd = row?.cwd ?? row?.projections?.values?.cwd;
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
  }

  function sameDirectory(left, right) {
    try {
      const a=resolve(left),b=resolve(right);
      return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    } catch { return false; }
  }

  function assertTaskNotCancelled(taskId) {
    if (!cancelledTasks.has(taskId)) return;
    cancelledTasks.delete(taskId);
    const record = active.get(taskId);
    if (record) {
      for (const streamId of record.streamIds) {
        try { send({ type: 'cancel', streamId }); } catch { }
      }
      active.delete(taskId);
    }
    const error = new Error('DSH task was cancelled before its prompt was sent');
    error.name = 'AbortError';
    throw error;
  }

  function openSocket() {
    if (socketReady) return socketReady;
    const attempt = (async () => {
      await ensureCookie();
      return new Promise((resolve, reject) => {
      const url = new URL(STREAM_PATH, baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : {}, ...(options.websocketOptions ?? {}) });
      socket = ws;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Timed out connecting to the DSH event stream'));
        ws.terminate();
      }, options.connectTimeoutMs ?? DEFAULT_EVENT_STREAM_TIMEOUT_MS);
      ws.once('open', () => {
        settled = true;
        clearTimeout(timeout);
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 25000);
        heartbeat.unref?.();
        resolve();
      });
      ws.once('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      ws.on('message', (data) => handleSocketMessage(data));
      ws.on('close', () => {
        if (heartbeat) clearInterval(heartbeat);
        if (socket === ws) {
          socket = undefined;
          socketReady = undefined;
          adapter.eventStream = null;
          adapter.eventClientId = null;
        }
        for (const record of active.values()) {
          record.streamIds.clear();
          record.followStream = null;
          // A transport close is not a DSH turn failure.  The native session
          // remains the source of truth, so reattach the follow stream and let
          // DSH replay the missed events before declaring the task failed.
          if (record.busy && !record.terminal) void reconnectRecord(record);
        }
      });
      });
    })();
    socketReady = attempt.catch((error) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) socketReady = undefined;
      throw error;
    });
    return socketReady;
  }

  function isRetryableSocketConnectError(error) {
    const code = error?.code ?? error?.cause?.code;
    return /Timed out connecting to the DSH event stream/i.test(String(error?.message ?? error))
      || /socket hang up|WebSocket.*(?:closed|error)/i.test(String(error?.message ?? error))
      || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
  }

  async function openSocketBeforeTask() {
    try {
      await openSocket();
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? error?.cause?.statusCode);
      const authRejected = [401, 403].includes(statusCode)
        || /unexpected server response:\s*(?:401|403)/i.test(String(error?.message ?? error));
      if (authRejected && typeof options.launchTokenProvider === 'function') {
        await ensureCookie({ refresh: true });
        await openSocket();
        return;
      }
      // This happens before workspace/session creation and before session/prompt,
      // so retrying the event-stream handshake cannot duplicate user work.
      if (closed || !isRetryableSocketConnectError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (closed) throw error;
      await openSocket();
    }
  }

  function send(frame) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('DSH event stream is not connected');
    socket.send(JSON.stringify(frame));
  }

  function openStream(endpoint, payload) {
    const streamId = randomUUID();
    send({ type: 'open', streamId, endpoint, payload });
    return streamId;
  }

  async function handleSocketMessage(data) {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (frame.type === 'error') {
      const record = [...active.values()].find((item) => item.streamIds.has(frame.streamId));
      if (record) await fail(record, new Error(frame.error?.message ?? 'DSH stream failed'));
      return;
    }
    if (frame.type === 'end') {
      const record = [...active.values()].find((item) => item.streamIds.has(frame.streamId));
      if (record?.busy && !record.terminal) await fail(record, new Error('DSH session stream ended before turn completion'));
      return;
    }
    if (frame.type !== 'item') return;
    const value = frame.value;
    const record = [...active.values()].find((item) => item.streamIds.has(frame.streamId));
    if (record && frame.streamId === record.followStream) {
      await handleFollow(record, value);
      return;
    }
    if (frame.streamId === adapter.eventStream) {
      if (value?.type === 'ready') adapter.eventClientId = value.clientId;
      else handleQuestionEvent(value);
    }
  }

  function followRecordSeq(item) {
    return item?.event?.seq ?? item?.seq;
  }

  function emitToolProgress(record) {
    const now = Date.now();
    if (now - (record.lastToolProgressAt ?? 0) < 2000) return;
    record.lastToolProgressAt = now;
    record.onEvent({ type: 'progress', kind: 'tool-activity' });
  }

  function handleFollowItem(record, value) {
    if (value?.type === 'assistant-stream') {
      if (awaitsPrompt(record) && !record.followPromptMatched) return;
      record.progressed = true;
      const chunk = value.frame?.chunk;
      const text = typeof chunk === 'string'
        ? chunk
        : chunk?.type === 'text-delta'
          ? chunk.text
          : chunk?.type === 'block-end' && chunk.block?.type === 'text'
            ? chunk.block.text
            : '';
      if (text) {
        // DSH transports may emit either true text deltas or cumulative
        // snapshots on assistant-stream. Treat a snapshot as replacement;
        // blindly appending it duplicates the entire reply on every update
        // and can make a live turn look stuck or corrupt its final result.
        record.text = text === record.text || text.startsWith(record.text)
          ? text
          : record.text + text;
        record.onEvent({ type: 'message', text: record.text });
      }
      return;
    }
    if (value?.type !== 'event') return;
    const event = value.event;
    if (!event || event.seq <= record.lastSeq) return;
    record.lastSeq = event.seq;
    if (awaitsPrompt(record) && !record.followPromptMatched) {
      if (event.type !== 'user/message' || !matchesPrompt(record,{event})) return;
      record.followPromptMatched = true;
      record.resolvePromptAccepted?.();
    }
    if (typeof event.type === 'string' && /tool|approval|question/i.test(event.type)) record.progressed = true;
    // Tool lifecycle events often contain arguments, results, or file contents.
    // Expose only a coarse heartbeat, and cap it so noisy tools cannot flood Hub.
    if (typeof event.type === 'string' && /tool/i.test(event.type)) {
      emitToolProgress(record);
    }
    if(event.type==='llm/retry') {
      record.onEvent({type:'message',text:record.text,progress:{kind:'model-retry',attempt:event.data?.retry,maxRetries:event.data?.maxRetries,code:event.data?.failure?.code || 'UNKNOWN'}});
    }
    if (event.type === 'assistant/message') {
      record.progressed = true;
      const text = responseText(event);
      if (text || event.data?.usage) {
        if (text && (text !== record.text || event.data?.usage)) record.onEvent({ type: 'message', text: text || record.text, ...(event.data?.usage ? { usage: event.data.usage } : {}) });
        else if (event.data?.usage) record.onEvent({ type: 'message', text: record.text, usage: event.data.usage });
        if (text) record.text = text;
      }
    } else if (event.type === 'turn/end') {
      record.busy = false;
      record.terminal = true;
      const reason = event.data?.reason;
      if (reason?.kind === 'completed') record.onEvent({ type: 'completed', text: record.text });
      else if (!(record.cancelRequested && ['aborted', 'interrupted'].includes(reason?.kind))) record.onEvent({
        type: 'failed', error: turnFailureMessage(reason),
        ...(reason?.kind === 'error' && !record.progressed ? { retrySafe: true } : {}),
      });
      if (record.followStream) {
        try { send({ type: 'cancel', streamId: record.followStream }); } catch { }
        record.streamIds.delete(record.followStream);
        record.followStream = null;
      }
      record.text = '';
    }
  }

  async function replaySnapshot(record, value, previousSeq) {
    let records = Array.isArray(value.records) ? value.records : [];
    const cursor = value.cursor ?? -1;
    if ((record.resumeFollow || awaitsPrompt(record)) && previousSeq < 0) {
      if (awaitsPrompt(record)) {
        let markerIndex = records.findLastIndex((item) => item.event?.type === 'user/message'
          && matchesPrompt(record,item));
        let hasMore = value.hasMore === true;
        let beforeSeq = followRecordSeq(records[0]);
        const address = { kind: 'session', sessionId: record.sessionId };
        try {
          if (record.resumeFollow && markerIndex < 0 && hasMore && Number.isFinite(beforeSeq)) record.paging = true;
          while (record.paging && markerIndex < 0 && hasMore && Number.isFinite(beforeSeq)) {
            const page = await call('session/page', { request: { address, throughSeq: cursor, beforeSeq, maxMessages: 200 } });
            const pageRecords = Array.isArray(page?.records) ? page.records : [];
            const firstPageSeq = followRecordSeq(pageRecords[0]);
            if (!pageRecords.length || !Number.isFinite(firstPageSeq) || firstPageSeq >= beforeSeq) {
              hasMore = false;
              break;
            }
            const seenSeq = new Set(records.map(followRecordSeq).filter(Number.isFinite));
            records = [...pageRecords.filter((item) => !seenSeq.has(followRecordSeq(item))), ...records];
            beforeSeq = firstPageSeq;
            markerIndex = records.findLastIndex((item) => item.event?.type === 'user/message'
              && matchesPrompt(record,item));
            hasMore = page.hasMore === true;
          }
        } catch (error) {
          record.paging = false;
          record.liveBuffer = [];
          await fail(record, error);
          return;
        }
        record.paging = false;
        record.followPromptMatched = markerIndex >= 0;
        if (record.followPromptMatched) record.resolvePromptAccepted?.();
        records = markerIndex >= 0 ? records.slice(markerIndex) : [];
      } else {
        // A process restart has no in-memory cursor. Only replay the latest
        // user turn, otherwise an older turn/end could settle the current work.
        const latestUser = records.findLastIndex(item => item.event?.type === 'user/message');
        if (latestUser >= 0) records = records.slice(latestUser);
      }
    }
    if (record.resumeFollow || previousSeq >= 0 || (awaitsPrompt(record) && record.followPromptMatched)) {
      for (const item of records) {
        if (record.terminal || record.failed) break;
        handleFollowItem(record, item);
      }
    }
    record.resumeFollow = false;
    record.lastSeq = Math.max(record.lastSeq, cursor);
    const buffered = record.liveBuffer ?? [];
    record.liveBuffer = [];
    for (const item of buffered) {
      if (record.terminal || record.failed) break;
      if (item?.type === 'snapshot') await replaySnapshot(record, item, record.lastSeq);
      else handleFollowItem(record, item);
    }
  }

  async function handleFollow(record, value) {
    if (value?.type === 'snapshot') {
      if (record.paging) {
        record.liveBuffer.push(value);
        return;
      }
      const previousSeq = record.lastSeq;
      await replaySnapshot(record, value, previousSeq);
      return;
    }
    if (record.paging) {
      record.liveBuffer.push(value);
      return;
    }
    handleFollowItem(record, value);
  }

  function handleQuestionEvent(value) {
    if (!value || value.type === 'ready' || value.type === 'cancel' || value.type === 'emit') return;
    const eventName = value.event;
    if (typeof eventName === 'string' && /tool/i.test(eventName)) {
      const matching = [...active.values()].filter((item) => item.busy);
      const record = active.get(String(value.agentId)) ?? matching.find((item) => item.sessionId === value.agentId) ?? (matching.length === 1 ? matching[0] : undefined);
      if (record) { record.progressed = true; emitToolProgress(record); }
    }
    if (eventName !== 'user-questions/request' && eventName !== 'approval/request') return;
    const matching = [...active.values()].filter((item) => item.busy);
    const record = active.get(String(value.agentId)) ?? matching.find((item) => item.sessionId === value.agentId) ?? (matching.length === 1 ? matching[0] : undefined);
    if (!record) return;
    record.progressed = true;
    const eventId = value.eventId;
    const clientId = value.clientId ?? adapter.eventClientId;
    if (!eventId || !clientId) return;
    const requestId = `${clientId}:${eventId}`;
    pendingQuestions.set(requestId, { record, clientId, eventId, eventName, request: value.request ?? value.args ?? {} });
    if (eventName === 'user-questions/request') {
      const questions = value.request?.questions ?? value.args?.questions ?? [];
      const isSecret = questions.some((item) => item.isSecret === true);
      const multi = questions.length > 1;
      record.onEvent({
        type: 'approval', requestId, kind: 'question',
        question: isSecret
          ? 'The engine is requesting a sensitive answer. Enter it only if you intend to share it with DSH.'
          : questions.map((item) => `${multi ? `[${item.id}] ` : ''}${item.question}${item.detail ? `\n${item.detail}` : ''}`).join('\n\n') + (multi ? '\n\nReply with a JSON object keyed by question ID.' : ''),
        options: isSecret || multi ? [] : questions.flatMap((item) => item.options ?? []).map((item) => item.label),
        raw: { eventName, isSecret, questions: isSecret ? questions.map(({ id, isSecret: secret }) => ({ id, isSecret: secret })) : questions },
      });
    } else {
      const req = value.request ?? value.args ?? {};
      record.onEvent({
        type: 'approval', requestId, kind: 'tool',
        question: [req.toolName, req.displayReason?.en ?? req.reason].filter(Boolean).join(': ') || 'DSH requests permission to continue.',
        options: ['approve once', 'deny'], raw: { eventName, request: req },
      });
    }
  }

  async function answerQuestion(requestId, answer) {
    const pending = pendingQuestions.get(requestId);
    if (!pending) return false;
    let outcome;
    if (pending.eventName === 'user-questions/request') {
      const questions = pending.request.questions ?? [];
      let values = answer;
      if (questions.length > 1 && typeof values === 'string') {
        try { values = JSON.parse(values); } catch { throw new Error('Multiple DSH questions require a JSON object keyed by question ID'); }
      }
      if (questions.length > 1 && (!values || typeof values !== 'object' || Array.isArray(values))) {
        throw new Error('Multiple DSH questions require a JSON object keyed by question ID');
      }
      const answers = questions.map((question) => {
        if (questions.length > 1 && !Object.hasOwn(values, question.id)) throw new Error(`Missing answer for DSH question ${question.id}`);
        const selected = typeof values === 'object' && values !== null ? values[question.id] : values;
        const label = String(selected ?? '');
        return { id: question.id, selected: question.options?.some((option) => option.label === label) ? [label] : [], ...(label && !question.options?.some((option) => option.label === label) ? { custom: label } : {}) };
      });
      outcome = { kind: 'result', value: { answers } };
    } else {
      outcome = { kind: 'result', value: /^(approve|accept|allow|yes|y|同意|允许|批准|通过|是)$/i.test(String(answer)) ? 'allowed-once' : 'rejected' };
    }
    await call('$events/result', { clientId: pending.clientId, eventId: pending.eventId, outcome });
    pendingQuestions.delete(requestId);
    return true;
  }

  async function fail(record, error) {
    if (record.failed) return;
    reconnecting.delete(record);
    record.failed = true;
    record.busy = false;
    record.onEvent({ type: 'failed', error: safeMessage(error) });
    if (record.followStream) {
      try { send({ type: 'cancel', streamId: record.followStream }); } catch { }
      record.streamIds.delete(record.followStream);
      record.followStream = null;
    }
  }

  async function reconnectRecord(record) {
    if (closed || record.terminal || record.failed || !record.busy || reconnecting.has(record)) return;
    reconnecting.add(record);
    let lastError = new Error('DSH event stream closed');
    try {
      for (const delay of RECONNECT_DELAYS_MS) {
        if (closed || record.terminal || record.failed || !record.busy) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          await ensureRecordStreams(record);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      if (!record.terminal && !record.failed && record.busy) await fail(record, new Error(`DSH event stream reconnect failed: ${safeMessage(lastError)}`));
    } finally {
      reconnecting.delete(record);
    }
  }

  async function ensureRecordStreams(record) {
    await openSocket();
    if (!adapter.eventStream) adapter.eventStream = openStream('$events', { args: {} });
    record.streamIds.add(adapter.eventStream);
    if (!record.followStream) {
      record.followStream = openStream('session/follow', {
        args: { request: { address: { kind: 'session', sessionId: record.sessionId }, assistantStream: true } },
      });
      record.streamIds.add(record.followStream);
    }
  }

  async function waitForPromptAcceptance(record, timeoutMs = options.promptAcceptanceTimeoutMs ?? 3000) {
    if (record.followPromptMatched) return true;
    let timer;
    const accepted = new Promise(resolve => { record.resolvePromptAccepted = () => resolve(true); });
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try { return (await Promise.race([accepted, expired])) || record.followPromptMatched; }
    finally { clearTimeout(timer); record.resolvePromptAccepted = null; }
  }

  const adapter = {
    eventStream: null,
    async reconcile(task) {
      const record=active.get(task?.id);
      if(!record || record.terminal || record.failed || !record.busy)return false;
      if(record.followStream) {
        try { send({type:'cancel',streamId:record.followStream}); } catch { }
        record.streamIds.delete(record.followStream);
        record.followStream=null;
      }
      // Reopen only the event subscription. Never submit the user's prompt a
      // second time: it may already have caused an external side effect.
      record.resumeFollow=true;
      record.lastSeq=-1;
      await ensureRecordStreams(record);
      return true;
    },
    async start(task, onEvent) {
      if (closed) throw new Error('DSH adapter is closed');
      if (!task?.id || !task?.cwd || !task?.prompt) throw new TypeError('DSH task requires id, cwd, and prompt');
      const imageBlocks=await imagePromptBlocks(task.reconnectOnly?[]:task.imagePaths,options.imageRoots ?? options.imageRoot);
      if(typeof task.onImagesLoaded==='function')await task.onImagesLoaded();
      cancelledTasks.delete(task.id);
      try { await openSocketBeforeTask(); }
      catch(error) {
        // The handshake completes before workspace/session creation or prompt
        // submission, so the Hub can safely make one bounded retry for a
        // director without duplicating a native session turn.
        if(!closed && !cancelledTasks.has(task.id) && isRetryableSocketConnectError(error))error.retryPreflightSafe=true;
        throw error;
      }
      assertTaskNotCancelled(task.id);
      if (!adapter.eventStream) adapter.eventStream = openStream('$events', { args: {} });
      const previous = active.get(task.id);
      if (previous?.followStream) {
        try { send({ type: 'cancel', streamId: previous.followStream }); } catch { }
      }
      const agentPreset = task.agentPreset ?? (['director', 'coordinator', 'reporter'].includes(task.role)
        ? (options.directorPreset ?? 'mornye-director')
        : (options.workerPreset ?? 'standard'));
      let created,fallbackFromSessionId=null;
      if (task.sessionId && !task.reconnectOnly) {
        let listedCwd=sessionCwds.get(task.sessionId) || null;
        if(!listedCwd) {
          const listing=await call('session/list',{_request:{}});
          listedCwd=listedSessionCwd(listing,task.sessionId);
          if(listedCwd)sessionCwds.set(task.sessionId,listedCwd);
        }
        // API-created director sessions run in the configured director project
        // (for example D:\\qq助手), while `task.cwd` is only the Hub's runtime
        // workspace. Validate a continuation against the directory used to
        // create that native session, or valid director sessions look foreign.
        const expectedSessionCwd=task.projectPath || task.cwd;
        if(!listedCwd || !sameDirectory(listedCwd,expectedSessionCwd)) {
          if((task.role==='worker' && task.allowMissingSessionFallback===true)
            || (task.role==='director' && !!listedCwd)) {
            fallbackFromSessionId=task.sessionId;
            task.sessionId=null;
            const context=task.continuationContext || {};
            const background=task.role==='director'?[]:[
              '续接背景：原 DSH 会话当前不可用或项目绑定不匹配，已在目标项目新建会话。',
              context.prompt?`上次任务目标：${String(context.prompt).slice(0,500)}`:'',
              context.result?`上次已有结果：${String(context.result).slice(0,900)}`:'',
              '以本轮要求为准；不要假设原会话仍在执行。',
            ].filter(Boolean).join('\n');
            if(background)task.prompt=`${background}\n\n${task.prompt}`;
          } else if(!listedCwd) {
            throw new Error('DSH 找不到指定的原会话或无法核实其项目目录；为避免错连，没有改用其他会话。');
          } else {
            throw new Error('DSH 指定会话的项目目录与任务不一致；为避免在错误项目中续接，任务已停止。');
          }
        }
      }
      if (task.sessionId) {
        created = { sessionId: task.sessionId };
      } else {
        const workspace = await workspaceFor(task.projectPath ?? task.cwd);
        assertTaskNotCancelled(task.id);
        if (['maintenance', 'librarian'].includes(task.role) && !workspace?.workspaceId) {
          throw new Error('DSH did not return a workspace ID for the specialist project');
        }
        const request = workspace?.workspaceId
          ? { workspaceId: workspace.workspaceId, agentPreset }
          : { cwd: task.cwd, agentPreset };
        created=await call('session/create',{request});
        if(fallbackFromSessionId&&typeof task.sessionBootstrap==='function') {
          if(typeof task.userText==='string')task.sessionContext=`${await task.sessionBootstrap()}\n\n${task.sessionContext||''}`;
          else task.prompt=`${await task.sessionBootstrap()}\n\n${task.prompt}`;
        }
      }
      assertTaskNotCancelled(task.id);
      const record = {
        task, onEvent, sessionId: created.sessionId, streamIds: new Set(), followStream: null,
        lastSeq: -1, text: '', busy: !!task.reconnectOnly, resumeFollow: !!task.reconnectOnly, terminal: false, failed: false, cancelRequested: false, progressed: false,
        followRequestId:task.reconnectOnly ? task.followRequestId || null : typeof task.userText==='string'?randomUUID():null,
        followPromptMarker: task.reconnectOnly
          ? (typeof task.followPromptMarker === 'string' && task.followPromptMarker ? task.followPromptMarker : null)
          : typeof task.userText==='string'?null:task.sessionId ? `[HUB-TASK ${String(task.id).replace(/[^\w-]/g,'').slice(0,80)}]` : null,
        followPromptMatched: false, paging: false, liveBuffer: [],
      };
      if(!task.reconnectOnly)sessionCwds.set(record.sessionId,task.projectPath ?? task.cwd);
      active.set(task.id, record);
      await ensureRecordStreams(record);
      assertTaskNotCancelled(task.id);
      onEvent({ type: 'session', sessionId: record.sessionId,...(record.followRequestId?{requestId:record.followRequestId}:{}),...(fallbackFromSessionId?{replacedMissingSession:true,previousSessionId:fallbackFromSessionId}:{}) });
      if (task.reconnectOnly) return { sessionId: record.sessionId };
      // API-created DSH sessions otherwise inherit a generic system-prompt title.
      // Give them a stable, human-readable title so the same task is visible in
      // DSH's own session list while retaining the native session ID. A shared
      // director session keeps its first label; changing it for every chat
      // message adds a serial RPC without improving session routing.
      const title = visibleSessionTitle(task);
      if (!task.sessionId && !sessionTitles.has(record.sessionId)) {
        try {
          await call('session/rename', { request: { sessionId: record.sessionId, title } }, undefined, 2500);
        } catch {
          // Older DSH builds may not expose session/rename; task execution remains
          // fully functional and the hub still retains the session ID.
        }
        sessionTitles.set(record.sessionId, title);
      }
      const selection=task.model
        ? {provider:task.provider ?? options.provider ?? 'deepseek-official',model:task.model}
        : ['director','coordinator','reporter'].includes(task.role) ? options.supervisorSelection : null;
      if(selection?.provider&&selection?.model) {
        const key=JSON.stringify(selection);
        if(sessionModels.get(record.sessionId)!==key) {
          await call('session/selectModel',{request:{sessionId:record.sessionId,provider:selection.provider,model:selection.model}});
          sessionModels.set(record.sessionId,key);
        }
      }
      record.busy = true;
      record.terminal = false;
      record.cancelRequested = false;
      try {
        const promptText=typeof task.userText==='string'?task.userText:record.followPromptMarker?`${record.followPromptMarker}\n${task.prompt}`:task.prompt;
        await call('session/prompt', { request: {
          requestId: record.followRequestId||randomUUID(), sessionId: record.sessionId, mode: 'queue', content: [{ type: 'text', text: promptText },...(typeof task.userText==='string'&&task.sessionContext?[{type:'text',text:'中枢上下文（独立于用户原话）：\n'+task.sessionContext}]:[]),...imageBlocks],
        } });
      } catch (error) {
        // The prompt RPC can lose its HTTP response after DSH has accepted the
        // user message. Reconcile only from the existing read-only follow
        // stream's task marker. Never replay the prompt on this ambiguous path.
        if (await waitForPromptAcceptance(record)) return { sessionId: record.sessionId };
        record.busy = false;
        throw error;
      }
      return { sessionId: record.sessionId };
    },
    async respond(task, approval, answer) {
      const record = active.get(task.id);
      if (!record) throw new Error(`No live DSH session for task ${task.id}`);
      if (await answerQuestion(String(approval.requestId ?? approval.id), answer)) return { sessionId: record.sessionId };
      await ensureRecordStreams(record);
      record.busy = true;
      record.terminal = false;
      record.failed = false;
      record.cancelRequested = false;
      record.text = '';
      record.followRequestId=typeof record.task.userText==='string'?randomUUID():null;
      record.followPromptMarker=record.followRequestId?null:`[HUB-TASK ${String(task.id).replace(/[^\w-]/g,'').slice(0,72)}-answer-${randomUUID().slice(0,8)}]`;
      record.followPromptMatched=false;
      let result;
      try {
        const answerText=record.followRequestId?String(answer??''):`${record.followPromptMarker}\n${String(answer ?? '')}`;
        result = await call('session/prompt', { request: {
          requestId: record.followRequestId||randomUUID(), sessionId: record.sessionId, mode: 'queue', content: [{ type: 'text', text: answerText }],
        } });
      } catch (error) {
        if (await waitForPromptAcceptance(record)) return { sessionId: record.sessionId };
        record.busy = false;
        throw error;
      }
      return { sessionId: record.sessionId, ...result };
    },
    async cancel(task) {
      cancelledTasks.add(task.id);
      const record = active.get(task.id);
      if (!record) return;
      record.cancelRequested = true;
      record.busy = false;
      await call('session/cancel', { request: { sessionId: record.sessionId } });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (socket?.readyState === WebSocket.OPEN) {
        for (const record of active.values()) {
          for (const streamId of record.streamIds) send({ type: 'cancel', streamId });
        }
        if (adapter.eventStream) send({ type: 'cancel', streamId: adapter.eventStream });
        socket.close(1000, 'adapter closed');
      } else if (socket) socket.terminate();
      if (heartbeat) clearInterval(heartbeat);
      pendingQuestions.clear();
      active.clear();
      cancelledTasks.clear();
      workspaces.clear();
      sessionTitles.clear();
      sessionModels.clear();
    },
  };
  return adapter;
}
