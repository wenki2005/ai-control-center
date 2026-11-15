const key = 'companion:outreach-model-backoff';
const minute = 60_000;

function state(store) {
  try { return JSON.parse(store.meta(key) || 'null'); }
  catch { return null; }
}

export function outreachModelRetryAt(store, now) {
  const retryAt = state(store)?.retryAt;
  return Number.isFinite(retryAt) && retryAt > now ? retryAt : null;
}

export function recordOutreachModelFailure(store, error, now) {
  if (!/timed?\s*out|timeout|等待超时|connection error|fetch failed|ECONNRESET|code=TRANSPORT/iu.test(String(error?.message || error))) return null;
  const previous = state(store);
  const failures = previous?.failedAt > now - 8 * 60 * minute && Number.isInteger(previous.failures)
    ? Math.min(3, previous.failures + 1)
    : 1;
  const retryAt = now + 30 * minute * 2 ** (failures - 1);
  store.meta(key, JSON.stringify({ failedAt: now, retryAt, failures }));
  return retryAt;
}

export function clearOutreachModelBackoff(store) {
  if (store.meta(key)) store.meta(key, '');
}
