import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const normal = value => String(value || '').replace(/^session-/, '');
export function rememberInternalSession(store, engine, sessionId, role) {
  if (sessionId) store?.meta?.(`internal-session:${engine}:${normal(sessionId)}`, role);
}

// Keep ownership after rollover. Document keys are also durable historical
// ownership evidence, unlike the mutable current-session pointers.
export function isInternalSession(store, engine, sessionId) {
  const id = normal(sessionId);
  if (!id) return false;
  if (store.meta(`internal-session:${engine}:${id}`)) return true;
  const rows = store.db.prepare(`SELECT key,value FROM metadata WHERE
    key LIKE 'session-documents:%' OR (lower(key) LIKE '%session%' AND
    (lower(key) LIKE '%report%' OR lower(key) LIKE '%proactive%' OR
     lower(key) LIKE '%diary%' OR lower(key) LIKE '%outreach%' OR
     lower(key) LIKE '%cognition%' OR lower(key) LIKE '%news%' OR lower(key) LIKE '%screen%' OR key IN ('directorSessionId','coordinatorSessionId','directSessionId')))` ).all();
  for (const row of rows) {
    const document = row.key.match(/^session-documents:([^:]+):([^:]+):(.+)$/);
    if (document && document[1] === engine && !['worker','direct'].includes(document[2]) && normal(document[3]) === id) return true;
    if (!document && normal(row.value) === id) return true;
  }
  if (engine === 'dsh') {
    try {
      const legacy = JSON.parse(readFileSync(join(homedir(), '.dsh/super-injector/dsh-monitor-hub.state.json'), 'utf8'));
      if ([legacy.assistantId, legacy.reflectSessionId].some(value => value && normal(value) === id)) return true;
    } catch { /* The retired monitor is optional. */ }
  }
  return false;
}
