import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';

const finite = n => Number.isFinite(n) && n >= 0 ? n : null;
const cpuTotal = rows => rows.reduce((sum, c) => sum + Object.values(c.times).reduce((a, b) => a + b, 0), 0);
const cpuIdle = rows => rows.reduce((sum, c) => sum + c.times.idle, 0);

/** Lightweight local sampler. It does not start a timer; callers own its cadence. */
export class LocalHealthMonitor {
  constructor({ db, diskPath = process.cwd(), sample = null, gpu = null, taskStallSummary = null, notify = () => {}, now = Date.now, timeoutMs = 2000, sampleLimit = 1440, thresholds = {} } = {}) {
    if (!db) throw Error('LocalHealthMonitor requires a SQLite database');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) throw Error('timeoutMs must be an integer from 10 to 60000');
    if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 100000) throw Error('sampleLimit must be an integer from 1 to 100000');
    if (typeof now !== 'function') throw Error('now must be a function');
    Object.assign(this, { db, diskPath, injectedSample: sample, gpuProvider: gpu, taskStallSummary, notify, now, timeoutMs, sampleLimit });
    const defaults = { cpuPercent: 90, memoryPercent: 90, diskUsedPercent: 90, gpuPercent: 95, taskStallCount: 1, taskStallAgeMs: 300000, consecutiveSamples: 3, recoverySamples: 2, recoveryHysteresis: 5, cooldownMs: 3600000 };
    for (const [key, value] of Object.entries(thresholds)) if (!Object.hasOwn(defaults, key)) throw Error(`Unknown local health threshold: ${key}`);
    this.thresholds = { ...defaults, ...thresholds };
    for (const key of ['cpuPercent', 'memoryPercent', 'diskUsedPercent', 'gpuPercent']) if (!Number.isFinite(this.thresholds[key]) || this.thresholds[key] < 0 || this.thresholds[key] > 100) throw Error(`${key} must be from 0 to 100`);
    for (const key of ['taskStallCount', 'taskStallAgeMs', 'consecutiveSamples', 'recoverySamples', 'recoveryHysteresis', 'cooldownMs']) if (!Number.isSafeInteger(this.thresholds[key]) || this.thresholds[key] < 0 || this.thresholds[key] > 1000000000) throw Error(`${key} must be a bounded nonnegative integer`);
    if (this.thresholds.consecutiveSamples < 1 || this.thresholds.recoverySamples < 1) throw Error('consecutiveSamples and recoverySamples must be positive');
    this.busy = false; this.samplerBlocked = false; this.lastDurationMs = null; this.cpuPrevious = null;
    db.exec(`CREATE TABLE IF NOT EXISTS local_health_samples(id INTEGER PRIMARY KEY,checkedAt TEXT NOT NULL,snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_health_incidents(metric TEXT PRIMARY KEY,active INTEGER NOT NULL DEFAULT 0,bad INTEGER NOT NULL DEFAULT 0,good INTEGER NOT NULL DEFAULT 0,startedAt TEXT,incidentId TEXT,lastNoticeAt INTEGER,lastValue TEXT,updatedAt TEXT NOT NULL)`);
    if (!db.prepare('PRAGMA table_info(local_health_incidents)').all().some(x => x.name === 'incidentId')) db.exec('ALTER TABLE local_health_incidents ADD COLUMN incidentId TEXT');
  }
  async sampleOnce() {
    if (this.busy) return { scope: 'local-device', skipped: true, reason: 'sample-in-progress' };
    this.busy = true;
    let releaseBusy = true; const sampleStarted = this.now();
    try {
      const started = this.now(), work = this.collectAll(); let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('local health sample timed out'), { code: 'SAMPLE_TIMEOUT' })), this.timeoutMs); });
      let snapshot;
      try { snapshot = await Promise.race([work, timeout]); }
      catch (error) { if (error.code === 'SAMPLE_TIMEOUT') { releaseBusy = false; this.samplerBlocked = true; work.catch(() => {}).finally(() => { this.samplerBlocked = false; this.busy = false; }); } throw error; }
      finally { clearTimeout(timer); }
      this.lastDurationMs = Math.max(0, this.now() - started);
      snapshot.scope = 'local-device'; snapshot.checkedAt = new Date(this.now()).toISOString();
      snapshot.durationMs = this.lastDurationMs;
      snapshot.missing = ['cpuPercent', 'memoryPercent', 'disk', 'gpu'].filter(key => snapshot[key] == null || key === 'gpu' && snapshot.gpu?.usedBytes == null && snapshot.gpu?.totalBytes == null);
      this.db.prepare('INSERT INTO local_health_samples(checkedAt,snapshot) VALUES(?,?)').run(snapshot.checkedAt, JSON.stringify(snapshot));
      this.db.prepare('DELETE FROM local_health_samples WHERE id NOT IN (SELECT id FROM local_health_samples ORDER BY id DESC LIMIT ?)').run(this.sampleLimit);
      await this.updateIncidents(snapshot); return snapshot;
    } catch (error) {
      this.lastDurationMs = Math.max(0, this.now() - sampleStarted);
      const snapshot = { scope: 'local-device', checkedAt: new Date(this.now()).toISOString(), durationMs: this.lastDurationMs, missing: ['cpuPercent', 'memoryPercent', 'disk', 'gpu'], error: String(error?.code || error?.message || error).slice(0, 200), cpuPercent: null, memoryPercent: null, disk: null, gpu: { usedBytes: null, totalBytes: null, source: null } };
      this.db.prepare('INSERT INTO local_health_samples(checkedAt,snapshot) VALUES(?,?)').run(snapshot.checkedAt, JSON.stringify(snapshot));
      this.db.prepare('DELETE FROM local_health_samples WHERE id NOT IN (SELECT id FROM local_health_samples ORDER BY id DESC LIMIT ?)').run(this.sampleLimit); return snapshot;
    } finally { if (releaseBusy) this.busy = false; }
  }
  async collect() {
    if (this.injectedSample) return await this.injectedSample();
    const cpus = os.cpus(), memTotal = finite(os.totalmem()), memFree = finite(os.freemem());
    const previous = this.cpuPrevious; this.cpuPrevious = { total: cpuTotal(cpus), idle: cpuIdle(cpus) };
    const dt = previous ? this.cpuPrevious.total - previous.total : 0, di = previous ? this.cpuPrevious.idle - previous.idle : 0;
    let disk = null; try { const fs = await statfs(this.diskPath); const totalBytes = Number(fs.blocks) * Number(fs.bsize), freeBytes = Number(fs.bavail) * Number(fs.bsize); disk = { path: this.diskPath, totalBytes: finite(totalBytes), freeBytes: finite(freeBytes), usedPercent: totalBytes > 0 ? Math.round((totalBytes - freeBytes) / totalBytes * 1000) / 10 : null, source: 'node:fs.statfs' }; } catch (error) { disk = { path: this.diskPath, totalBytes: null, freeBytes: null, usedPercent: null, source: 'node:fs.statfs', error: String(error?.code || error?.message || error).slice(0, 100) }; }
    let gpu = { usedBytes: null, totalBytes: null, source: null };
    if (this.gpuProvider) { try { const value = await this.gpuProvider(); gpu = { usedBytes: finite(value?.usedBytes), totalBytes: finite(value?.totalBytes), source: value?.source || null }; } catch (error) { gpu.error = String(error?.message || error).slice(0, 100); } }
    return { cpuPercent: dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : null, memoryPercent: memTotal ? (memTotal - memFree) / memTotal * 100 : null, memoryBytes: { total: memTotal, free: memFree }, disk, gpu, processes: { pid: process.pid, rssBytes: finite(process.memoryUsage().rss), source: 'current-process-only' } };
  }
  async collectAll() {
    const snapshot = await this.collect();
    if (this.taskStallSummary) {
      const summary = await this.taskStallSummary();
      snapshot.taskStalls = summary?.source && Number.isSafeInteger(summary.stalledCount) && summary.stalledCount >= 0 && Number.isFinite(summary.oldestAgeMs) && summary.oldestAgeMs >= 0 ? summary : null;
    } else snapshot.taskStalls = null;
    return snapshot;
  }
  async updateIncidents(snapshot) {
    const t = this.thresholds, gpu = snapshot.gpu?.usedBytes != null && snapshot.gpu?.totalBytes > 0 ? snapshot.gpu.usedBytes / snapshot.gpu.totalBytes * 100 : null;
    const stalls = snapshot.taskStalls?.source && snapshot.taskStalls.stalledCount >= t.taskStallCount && snapshot.taskStalls.oldestAgeMs >= t.taskStallAgeMs ? snapshot.taskStalls.stalledCount : snapshot.taskStalls?.source ? 0 : null;
    const metrics = [['cpu', snapshot.cpuPercent, t.cpuPercent], ['memory', snapshot.memoryPercent, t.memoryPercent], ['disk', snapshot.disk?.usedPercent, t.diskUsedPercent], ['gpu', gpu, t.gpuPercent], ['task-stalls', stalls, 0]];
    for (const [key, value, limit] of metrics) {
      const row = this.db.prepare('SELECT * FROM local_health_incidents WHERE metric=?').get(key), bad = value !== null && value >= limit && (key !== 'task-stalls' || value > 0);
      if (!row) {
        const activate = bad && t.consecutiveSamples === 1, incidentId = activate ? randomUUID() : null, last = 0;
        this.db.prepare('INSERT INTO local_health_incidents(metric,active,bad,good,startedAt,incidentId,lastNoticeAt,lastValue,updatedAt) VALUES(?,?,?,0,?,?,?, ?,?)').run(key, activate ? 1 : 0, bad ? 1 : 0, activate ? snapshot.checkedAt : null, incidentId, activate && this.now() - last >= t.cooldownMs ? this.now() : null, value === null ? null : String(value), snapshot.checkedAt);
        if (activate && this.now() - last >= t.cooldownMs) { try { await this.notify({ scope: 'local-device', metric: key, state: 'alert', value, threshold: limit, incidentId, startedAt: snapshot.checkedAt, at: snapshot.checkedAt }); } catch {} }
      }
      else if (!row.active && bad) {
        const count = row.bad + 1, last = Number(row.lastNoticeAt) || 0, activate = count >= t.consecutiveSamples, incidentId = activate ? randomUUID() : null;
        this.db.prepare('UPDATE local_health_incidents SET bad=?,good=0,active=?,startedAt=CASE WHEN ? THEN ? ELSE startedAt END,incidentId=CASE WHEN ? THEN ? ELSE incidentId END,lastNoticeAt=CASE WHEN ? THEN ? ELSE lastNoticeAt END,lastValue=?,updatedAt=? WHERE metric=?').run(count, activate ? 1 : 0, activate ? 1 : 0, snapshot.checkedAt, activate ? 1 : 0, incidentId, activate && this.now() - last >= t.cooldownMs ? 1 : 0, this.now(), String(value), snapshot.checkedAt, key);
        if (activate && this.now() - last >= t.cooldownMs) { try { await this.notify({ scope: 'local-device', metric: key, state: 'alert', value, threshold: limit, incidentId, startedAt: snapshot.checkedAt, at: snapshot.checkedAt }); } catch {} }
      } else if (row.active && !bad && value !== null && (key === 'task-stalls' ? value === 0 : value <= Math.max(0, limit - t.recoveryHysteresis))) {
        const count = row.good + 1, recovered = count >= t.recoverySamples;
        this.db.prepare('UPDATE local_health_incidents SET active=?,bad=0,good=?,lastValue=?,updatedAt=? WHERE metric=?').run(recovered ? 0 : 1, count, String(value), snapshot.checkedAt, key);
        if (recovered) { try { await this.notify({ scope: 'local-device', metric: key, state: 'recovered', value, incidentId: row.incidentId, startedAt: row.startedAt, at: snapshot.checkedAt }); } catch {} this.db.prepare('UPDATE local_health_incidents SET startedAt=NULL WHERE metric=?').run(key); }
      } else if (row && !row.active) this.db.prepare('UPDATE local_health_incidents SET bad=?,good=0,lastValue=?,updatedAt=? WHERE metric=?').run(bad ? row.bad + 1 : 0, value === null ? null : String(value), snapshot.checkedAt, key);
      else if (row?.active && value === null) this.db.prepare('UPDATE local_health_incidents SET good=0,lastValue=NULL,updatedAt=? WHERE metric=?').run(snapshot.checkedAt, key);
      else if (row?.active && bad) this.db.prepare('UPDATE local_health_incidents SET good=0,lastValue=?,updatedAt=? WHERE metric=?').run(String(value), snapshot.checkedAt, key);
    }
  }
  state() { const latest = this.db.prepare('SELECT checkedAt,snapshot FROM local_health_samples ORDER BY id DESC LIMIT 1').get() || null; if (latest) { try { latest.snapshot = JSON.parse(latest.snapshot); } catch { latest.snapshot = null; } } return { scope: 'local-device', busy: this.busy, samplerBlocked: this.samplerBlocked, durationMs: this.lastDurationMs, latest, incidents: this.db.prepare('SELECT metric,active,incidentId,startedAt,lastNoticeAt,lastValue FROM local_health_incidents WHERE active=1').all() }; }
}
