const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name);
}

function columns(db, table) {
  if (!hasTable(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

/** Read-only aggregate runtime evidence. Task cohorts use createdAt >= since and <= asOf.
 * Queue = first started-created, execution = updated-latest-started for completed tasks. Native-adopted
 * tasks are excluded from those durations because their task.started event is emitted when result-following
 * begins, after native execution. Their separate duration starts at task.native-linked. Percentiles use
 * nearest-rank (ceil(p*n)); denominators are returned.
 */
export class RuntimeMetrics {
  constructor({ db, now = Date.now } = {}) {
    if (!db?.prepare) throw new TypeError('RuntimeMetrics requires a SQLite database');
    this.db = db;
    this.now = now;
  }

  snapshot({ windowMs = 86400000 } = {}) {
    const duration = Math.max(0, Math.min(Number(windowMs) || 0, MAX_WINDOW_MS));
    const asOfMs = Number(this.now());
    const asOf = new Date(asOfMs).toISOString();
    const since = new Date(asOfMs - duration).toISOString();
    const taskCols = columns(this.db, 'tasks');
    const eventCols = columns(this.db, 'events');
    const taskCountsAvailable=['createdAt','status'].every(name=>taskCols.has(name));
    const durationsAvailable=['id','role','prompt','createdAt','updatedAt','status'].every(name=>taskCols.has(name)) && ['taskId','type','createdAt'].every(name=>eventCols.has(name));
    const eventTypeSignalsAvailable=['type','createdAt'].every(name=>eventCols.has(name));
    const modelRetrySignalsAvailable=['type','data','createdAt'].every(name=>eventCols.has(name));
    const nativeAdoptedAvailable=['taskId','type','createdAt'].every(name=>eventCols.has(name));
    const actorExpr = taskCols.has('role')
      ? (taskCols.has('prompt') ? "CASE WHEN role='director' AND instr(prompt,'[内部工作回报]')=1 THEN 'internal-report' WHEN role='director' THEN 'director-session' WHEN role IN ('worker','librarian','maintenance') THEN role WHEN role='direct' THEN 'direct' ELSE 'other' END" : "CASE WHEN role='director' THEN 'unknown' WHEN role IN ('worker','librarian','maintenance') THEN role WHEN role='direct' THEN 'direct' ELSE 'other' END")
      : "'unknown'";
    const tasks = taskCountsAvailable
      ? this.db.prepare(`SELECT ${actorExpr} AS actorGroup, ${taskCols.has('role') ? 'role' : "'unknown' AS role"}, ${taskCols.has('engine') ? 'engine' : "'unknown' AS engine"}, status, COUNT(*) AS count FROM tasks WHERE createdAt>=? AND createdAt<=? GROUP BY actorGroup,role,engine,status`).all(since, asOf).map(r => ({ actorGroup: r.actorGroup, role: r.role, engine: r.engine, status: r.status, count: r.count })) : [];
    let queue = [], execution = [];
    const actorStats = new Map();
    for (const row of tasks) {
      let stat = actorStats.get(row.actorGroup);
      if (!stat) { stat = { tasks: 0, terminal: 0, completed: 0, failed: 0, queue: [], execution: [] }; actorStats.set(row.actorGroup, stat); }
      stat.tasks += row.count;
      if (row.status === 'completed' || row.status === 'failed') { stat.terminal += row.count; if (row.status === 'completed') stat.completed += row.count; else stat.failed += row.count; }
    }
    let durationSampleLimit = 10000, durationTruncated = false;
    if (durationsAvailable) {
      const rows = this.db.prepare(`WITH cohort AS (SELECT id,createdAt,updatedAt,status,${actorExpr} AS actorGroup FROM tasks WHERE createdAt>=? AND createdAt<=? ORDER BY createdAt,id LIMIT 10001), starts AS (SELECT e.taskId,MIN(CASE WHEN e.type='task.started' THEN e.createdAt END) AS firstStartedAt,MAX(CASE WHEN e.type='task.started' THEN e.createdAt END) AS latestStartedAt,MIN(CASE WHEN e.type='task.native-linked' THEN e.createdAt END) AS nativeLinkedAt FROM events e JOIN cohort c ON c.id=e.taskId WHERE e.type IN ('task.started','task.native-linked') AND e.createdAt<=? GROUP BY e.taskId) SELECT c.actorGroup,c.createdAt,c.updatedAt,c.status,s.firstStartedAt,s.latestStartedAt,s.nativeLinkedAt FROM cohort c LEFT JOIN starts s ON s.taskId=c.id ORDER BY c.createdAt,c.id`).all(since, asOf, asOf);
      durationTruncated = rows.length > durationSampleLimit;
      rows.length = Math.min(rows.length, durationSampleLimit);
      for (const r of rows) {
        let stat = actorStats.get(r.actorGroup);
        if (!stat) { stat = { tasks: 0, terminal: 0, completed: 0, failed: 0, queue: [], execution: [] }; actorStats.set(r.actorGroup, stat); }
        if (!r.firstStartedAt || !r.latestStartedAt || r.nativeLinkedAt) continue;
        const q = Date.parse(r.firstStartedAt) - Date.parse(r.createdAt);
        if (Number.isFinite(q) && q >= 0) { stat.queue.push(q); if (r.actorGroup === 'director-session') queue.push(q); }
        if (r.status === 'completed') {
          const e = Date.parse(r.updatedAt) - Date.parse(r.latestStartedAt);
          if (Number.isFinite(e) && e >= 0) { stat.execution.push(e); if (r.actorGroup === 'director-session') execution.push(e); }
        }
      }
    }
    const actorMetrics = [...actorStats].map(([actorGroup, s]) => ({
      actorGroup, tasks: s.tasks, terminalDenominator: s.terminal,
      completed: s.completed, failed: s.failed,
      completionRate: s.terminal ? s.completed / s.terminal : null,
      failureRate: s.terminal ? s.failed / s.terminal : null,
      queueMs: { available: durationsAvailable, denominator: s.queue.length, p50: percentile(s.queue, .5), p95: percentile(s.queue, .95), startEvent: 'first task.started' },
      executionMs: { available: durationsAvailable, denominator: s.execution.length, p50: percentile(s.execution, .5), p95: percentile(s.execution, .95), terminalStatuses: ['completed'], startEvent: 'latest task.started' },
    }));
    const nativeAdopted = { available: nativeAdoptedAvailable, count: null,
      terminalLatencyMs: { available: nativeAdoptedAvailable, denominator: 0, p50: null, p95: null,
        startEvent: 'task.native-linked', terminalEventTypes: ['completed','failed','task.cancelled'], sampleLimit: 10000, truncated: false } };
    if (nativeAdoptedAvailable) {
      nativeAdopted.count = this.db.prepare("SELECT COUNT(DISTINCT taskId) AS n FROM events WHERE type='task.native-linked' AND createdAt>=? AND createdAt<=?").get(since, asOf).n;
      const rows = this.db.prepare(`WITH native AS (SELECT taskId,MIN(createdAt) AS linkedAt FROM events WHERE type='task.native-linked' AND createdAt>=? AND createdAt<=? GROUP BY taskId ORDER BY linkedAt,taskId LIMIT 10001), terminal AS (SELECT n.taskId,n.linkedAt,MIN(e.createdAt) AS terminalAt FROM native n JOIN events e ON e.taskId=n.taskId AND e.type IN ('completed','failed','task.cancelled') AND e.createdAt>=n.linkedAt AND e.createdAt<=? GROUP BY n.taskId,n.linkedAt) SELECT linkedAt,terminalAt FROM terminal ORDER BY linkedAt,taskId`).all(since, asOf, asOf);
      const truncated = nativeAdopted.count > 10000;
      rows.length = Math.min(rows.length, 10000);
      const latency = rows.map(r => Date.parse(r.terminalAt) - Date.parse(r.linkedAt)).filter(n => Number.isFinite(n) && n >= 0);
      Object.assign(nativeAdopted.terminalLatencyMs, { denominator: latency.length, p50: percentile(latency, .5), p95: percentile(latency, .95), truncated });
    }
    const eventCounts = { warnings: 0, timeouts: 0, retries: 0, recoverySignals: 0 };
    if (eventTypeSignalsAvailable) {
      const rows = this.db.prepare('SELECT type,COUNT(*) AS n FROM events WHERE createdAt>=? AND createdAt<=? GROUP BY type LIMIT 500').all(since, asOf);
      for (const { type, n } of rows) {
        const t = String(type).toLowerCase();
        if (t.includes('warning') || t.includes('wait-notified')) eventCounts.warnings += n;
        if (t.includes('timeout')) eventCounts.timeouts += n;
        if (t.includes('retry')) eventCounts.retries += n;
        if ((t.includes('recover') || t.includes('recovery')) && !t.includes('recovery-pending')) eventCounts.recoverySignals += n;
      }
    }
    if (modelRetrySignalsAvailable) {
      // Aggregate in SQLite: a late retry or a long partial answer must not
      // disappear behind a sampling/payload limit. Only candidate JSON is
      // parsed; no event body is returned through this read model.
      const modelRetries=this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='message' AND createdAt>=? AND createdAt<=? AND CASE WHEN instr(data,'model-retry')>0 AND json_valid(data) THEN json_extract(data,'$.progress.kind') END='model-retry'").get(since,asOf);
      eventCounts.retries+=modelRetries.n;
    }
    const outbox = (table, statusCol='status') => {
      if (!columns(this.db, table).has(statusCol)) return { available:false,total:null,byStatus:[] };
      const rows = this.db.prepare(`SELECT ${statusCol} AS status,COUNT(*) AS count FROM ${table} GROUP BY ${statusCol} LIMIT 100`).all();
      return { available:true,total: rows.reduce((sum, r) => sum + r.count, 0), byStatus: rows.map(r => ({ status: r.status, count: r.count })) };
    };
    return {
      window: { since, asOf, windowMs: duration, boundary: 'createdAt >= since and createdAt <= asOf' },
      tasks,
      actorMetricsAvailable: taskCountsAvailable,
      actorMetrics,
      nativeAdopted,
      taskCountsAvailable,
      directorDurationsMs: {
        available:durationsAvailable,
        cohort: 'director main-session tasks (prompt does not start with [内部工作回报]) created in window; durations excluded when prompt or required schema is unavailable',
        queue: { denominator: queue.length, p50: percentile(queue, .5), p95: percentile(queue, .95), startEvent: 'first task.started' },
        execution: { denominator: execution.length, p50: percentile(execution, .5), p95: percentile(execution, .95), terminalStatuses: ['completed'], startEvent: 'latest task.started' },
        sampleLimit: durationSampleLimit,
        truncated: durationTruncated,
      },
      events: { ...eventCounts,eventTypeSignalsAvailable,modelRetrySignalsAvailable,
        scope:'all system events in the time window, including internal reports; unavailable components must not be interpreted as zero incidents',
        recoveryMetadata: 'recoverySignals counts matching event-name signals only; it is not a successful recovery count or success rate' },
      queues: { returnReports: outbox('return_reports'), qqOutbox: outbox('outbox'), attachmentOutbox: outbox('attachment_outbox') },
    };
  }
}
