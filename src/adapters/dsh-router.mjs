import { createDshAdapter } from './dsh.mjs';

function loopbackUrl(value, fallback, trustedHost) {
  const url = new URL(value || fallback);
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'http:' || (!isLoopback && (!trustedHost || url.hostname !== trustedHost))) {
    throw new TypeError('DSH router only supports loopback hosts');
  }
  return url.toString().replace(/\/$/, '');
}

// Only transport failures before a request can have created/used a session
// may choose another DSH instance. Provider/model errors and missing-session
// responses are deliberately not treated as connection failures.
function isConnectionFailure(error) {
  const message = String(error?.message ?? error ?? '');
  if (/session\s*(?:not found|does not exist|unknown)|unknown session|会话不存在/i.test(message)) return false;
  return /(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|WebSocket.*(?:closed|error)|connection (?:error|refused|reset|closed|timed out)|fetch failed|socket hang up)/i.test(message);
}

/**
 * User workers use the historical QQ/Mornye DSH at 3080. The restricted
 * director may use a separate isolated DSH profile so its tool allowlist and
 * plugin bundle cannot leak into worker or legacy sessions. Optional worker
 * failover is safe only before DSH confirms any output, tool, or approval
 * activity; director sessions never fail over across profiles.
 */
export function createDshRouterAdapter({
  primaryUrl = 'http://127.0.0.1:3080',
  fallbackUrl = 'http://127.0.0.1:3180',
  directorUrl = null,
  primaryOptions = {},
  fallbackOptions = {},
  directorOptions = {},
  directorToPrimary = false,
  trustedPrimaryHost = null,
  adapterFactory = createDshAdapter,
} = {}) {
  const primaryBaseUrl = loopbackUrl(primaryUrl, 'http://127.0.0.1:3080', trustedPrimaryHost);
  const fallbackBaseUrl = fallbackUrl ? loopbackUrl(fallbackUrl, 'http://127.0.0.1:3180') : null;
  const directorBaseUrl = !directorToPrimary && directorUrl ? loopbackUrl(directorUrl, 'http://127.0.0.1:3180') : null;
  if(directorBaseUrl && directorBaseUrl===primaryBaseUrl)throw new TypeError('DSH director must use a profile isolated from the historical primary DSH');
  const primary = adapterFactory({ ...primaryOptions, ...(trustedPrimaryHost ? { trustedHost: trustedPrimaryHost } : {}), baseUrl: primaryBaseUrl });
  const fallback = fallbackBaseUrl ? adapterFactory({ ...fallbackOptions, baseUrl: fallbackBaseUrl }) : null;
  const director = directorBaseUrl ? adapterFactory({ ...directorOptions, baseUrl: directorBaseUrl }) : null;
  const routes = new Map();

  function preferred(task) {
    if (task?.dshEndpoint === primaryBaseUrl) return primary;
    if (director && task?.role === 'director' && task?.dshEndpoint === directorBaseUrl) return director;
    if (fallback && task?.dshEndpoint === fallbackBaseUrl) return fallback;
    if (director && task?.role === 'director') return director;
    if (directorToPrimary && task?.role === 'director') return primary;
    return primary;
  }

  async function start(task, onEvent) {
    const known = routes.get(task.id);
    if (known) return known.start(task, onEvent);

    const explicitlyPinned = Boolean(task.dshEndpoint);
    const first = preferred(task);
    // Persist the chosen endpoint on the task object before adapter startup.
    // The hub records this route with the session event and future recovery
    // then cannot silently adopt the same session on another DSH instance.
    task.dshEndpoint ??= first === primary ? primaryBaseUrl : first === director ? directorBaseUrl : fallbackBaseUrl;
    const second = first === primary ? fallback : null;
    let sessionSeen = false;
    let firstStarted = false;
    let safeFailureBeforeStart = false;
    let failoverPromise = null;
    const mayFailOver = Boolean(second) && first === primary && !explicitlyPinned;
    const startFallback = () => {
      if (failoverPromise || !mayFailOver) return failoverPromise;
      routes.set(task.id, second);
      task.dshEndpoint = fallbackBaseUrl;
      const fallbackTask = { ...task, dshEndpoint: fallbackBaseUrl, sessionId: undefined };
      failoverPromise = Promise.resolve().then(() => second.start(fallbackTask, onEvent)).then((result) => {
        routes.set(task.id, second);
        return result;
      }).catch((error) => {
        onEvent({ type: 'failed', error: String(error?.message ?? error ?? 'DSH fallback failed').slice(0, 4000) });
      });
      return failoverPromise;
    };
    const observe = (event) => {
      if (event?.type === 'session') sessionSeen = true;
      if (event?.type === 'failed' && event.retrySafe === true && mayFailOver && isConnectionFailure(event.error)) {
        if (firstStarted) void startFallback();
        else safeFailureBeforeStart = true;
        return;
      }
      onEvent(event);
    };
    try {
      const result = await first.start(task, observe);
      firstStarted = true;
      // A safe failure may arrive just before start() settles. In that case
      // observe() has already selected the fallback; do not overwrite that
      // route with the now-finished primary start call.
      if (!failoverPromise) routes.set(task.id, first);
      if (safeFailureBeforeStart) void startFallback();
      return result;
    } catch (error) {
      // Once session/create has emitted a native session id, the request may
      // already have side effects. Only a terminal DSH error marked retrySafe
      // can cross instances after that point.
      firstStarted = true;
      if (sessionSeen) {
        if (!safeFailureBeforeStart || !mayFailOver) throw error;
        void startFallback();
        return { sessionId: task.sessionId };
      }
      if (task.sessionId || !isConnectionFailure(error)) throw error;
      if (!second || !mayFailOver) throw error;
      task.dshEndpoint = fallbackBaseUrl;
      const result = await second.start({ ...task, dshEndpoint: fallbackBaseUrl, sessionId: undefined }, onEvent);
      routes.set(task.id, second);
      return result;
    }
  }

  function routeFor(task) {
    return routes.get(task.id) ?? preferred(task);
  }

  return {
    start,
    async respond(task, approval, answer) {
      return routeFor(task).respond(task, approval, answer);
    },
    async cancel(task) {
      return routeFor(task).cancel(task);
    },
    async reconcile(task) {
      return routeFor(task).reconcile?.(task) ?? false;
    },
    async close() {
      await Promise.allSettled([primary.close(), ...(fallback ? [fallback.close()] : []), ...(director && director !== fallback && director !== primary ? [director.close()] : [])]);
      routes.clear();
    },
    // Read-only diagnostics for the server/UI and maintenance scripts.
    endpointFor(task) {
      const route=routeFor(task);
      return route===primary?primaryBaseUrl:route===director?directorBaseUrl:fallbackBaseUrl;
    },
    endpoints: { primary: primaryBaseUrl, fallback: fallbackBaseUrl, director: directorBaseUrl },
    directorEndpoint: directorBaseUrl || (directorToPrimary ? primaryBaseUrl : null),
    directorRoutePriority: directorToPrimary ? 'qq-simulation-primary-3080' : 'isolated-director-3180',
    directorPreset: directorToPrimary ? (primaryOptions.directorPreset || 'mornye-director') : (directorOptions.directorPreset || 'mornye-director'),
  };
}
