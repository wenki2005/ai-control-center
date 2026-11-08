import { randomUUID } from 'node:crypto';
import { LocalResourceCoordinator } from './local-resource-coordinator.mjs';
import { LocalHealthMonitor } from './local-health-monitor.mjs';
import { redact } from './redact.mjs';
import {ResourceRecovery} from './lifecycle/resource-recovery.mjs';

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled']);

/** In-process composition only; callers own polling cadence and notification routing. */
export class LocalModelServices {
  constructor({ store, root, config = {}, gpuSampler = null, notify = () => {} } = {}) {
    if (!store?.db) throw Error('LocalModelServices requires store.db');
    Object.assign(this, { store, root, config, gpuSampler, notify });
    this.coordinator = new LocalResourceCoordinator({ limits: config.limits || {}, readResources: config.readResources });
    const monitorSettings = config.monitorSettings || {};
    this.monitor = new LocalHealthMonitor({ db: store.db, diskPath: root, gpu: gpuSampler, notify, timeoutMs: monitorSettings.timeoutMs, sampleLimit: monitorSettings.sampleLimit, thresholds: config.healthThresholds });
    this.leases = new Map(); this.restoring = true;this.recovery=new ResourceRecovery(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS local_model_claims(
      claimId TEXT PRIMARY KEY,jobId TEXT,claimKey TEXT NOT NULL UNIQUE,status TEXT NOT NULL,leaseToken TEXT,estimatedMemoryBytes INTEGER,estimatedGpuBytes INTEGER,
      createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,lastError TEXT,terminalStatus TEXT
    )`);
    if (!store.db.prepare('PRAGMA table_info(local_model_claims)').all().some(x => x.name === 'terminalStatus')) store.db.exec('ALTER TABLE local_model_claims ADD COLUMN terminalStatus TEXT');
    this.ready = this.restore();
  }
  get busy() { return this.leases.size > 0; }
  state() { const claims = this.store.db.prepare('SELECT claimId,jobId,status,terminalStatus,createdAt,updatedAt,lastError FROM local_model_claims ORDER BY createdAt DESC LIMIT 100').all().map(row => ({ ...row, lastError: row.lastError == null ? null : redact(String(row.lastError)).slice(0, 500) })); return { scope: 'local-device', coordinator: this.coordinator.state(), monitor: this.monitor.state(), claims, busy: this.busy, restoring: this.restoring,recovery:this.recovery.recent() }; }
  async poll() { await this.ready; await this.monitor.sampleOnce(); await this.reconcileClaims(); return this.state(); }
  async restore() {
    try {
      const rows = this.store.db.prepare("SELECT * FROM local_model_claims WHERE status NOT IN ('released') ORDER BY createdAt").all();
      for (const row of rows) {
        // A crash during submission has an unknown outcome. Keep the reservation and never replay it.
        if (row.status === 'submitting') this.store.db.prepare("UPDATE local_model_claims SET status='unknown',lastError=COALESCE(lastError,'center restarted during submission'),updatedAt=? WHERE claimId=?").run(this.store.now(), row.claimId);
        const lease = await this.coordinator.acquire({ owner: `singing:${row.claimId}`, kind: 'heavy', priority: 0, estimatedMemoryBytes: row.estimatedMemoryBytes, estimatedGpuBytes: row.estimatedGpuBytes, recovery: true });
        this.leases.set(row.claimId, lease);
        this.store.db.prepare('UPDATE local_model_claims SET leaseToken=?,updatedAt=? WHERE claimId=?').run(lease.token, this.store.now(), row.claimId);
      }
      await this.reconcileClaims();
    } finally { this.restoring = false; }
  }
  async submitSinging(startCallback, args = {}) {
    if (typeof startCallback !== 'function') throw Error('singing start callback required');
    await this.ready;
    const claimId = randomUUID(), claimKey = args.key || `resource-claim:${claimId}`, now = this.store.now();
    // Journal intent before calling the resident service: restart recovery must treat an interrupted send as uncertain.
    const estimate = this.config.singingEstimate || {};
    this.store.db.prepare("INSERT INTO local_model_claims(claimId,jobId,claimKey,status,leaseToken,estimatedMemoryBytes,estimatedGpuBytes,createdAt,updatedAt,lastError) VALUES(?,NULL,?,'submitting',NULL,?,?,?,?,NULL)").run(claimId, claimKey, estimate.estimatedMemoryBytes ?? estimate.memoryBytes ?? null, estimate.estimatedGpuBytes ?? estimate.gpuBytes ?? null, now, now);
    let lease, dispatchStarted = false;
    try {
      lease = await this.coordinator.acquire({ owner: `singing:${claimId}`, kind: 'heavy', priority: 0, ...this.config.singingEstimate });
      this.leases.set(claimId, lease);
      this.store.db.prepare('UPDATE local_model_claims SET leaseToken=?,updatedAt=? WHERE claimId=?').run(lease.token, this.store.now(), claimId);
      dispatchStarted = true;
      const result = await startCallback({ ...args, key: claimKey });
      const jobId = result?.id || result?.job?.id || result?.jobId || null;
      if (!jobId) {
        this.store.db.prepare("UPDATE local_model_claims SET status='unknown',lastError='resident service returned no job identity',updatedAt=? WHERE claimId=?").run(this.store.now(), claimId);
        return { claimId, status: 'unknown', result };
      }
      this.store.db.prepare("UPDATE local_model_claims SET status='accepted',jobId=?,updatedAt=? WHERE claimId=?").run(String(jobId), this.store.now(), claimId);
      await this.reconcileClaim(claimId);
      return { claimId, status: this.store.db.prepare('SELECT status FROM local_model_claims WHERE claimId=?').get(claimId).status, result };
    } catch (error) {
      if (!dispatchStarted || error?.preExecution === true) this.releaseClaim(claimId, 'released', error.message);
      else this.store.db.prepare("UPDATE local_model_claims SET status='unknown',lastError=?,updatedAt=? WHERE claimId=?").run(String(error?.message || error).slice(0, 500), this.store.now(), claimId);
      throw error;
    }
  }
  async reconcileClaims() {
    const rows = this.store.db.prepare("SELECT claimId FROM local_model_claims WHERE status IN ('accepted','running','queued')").all();
    for (const row of rows) await this.reconcileClaim(row.claimId);
  }
  async reconcileClaim(claimId) {
    const claim = this.store.db.prepare('SELECT * FROM local_model_claims WHERE claimId=?').get(claimId); if (!claim?.jobId) return claim?.status || null;
    const job = this.store.db.prepare('SELECT status FROM companion_singing_jobs WHERE id=?').get(claim.jobId);
    if (!job) { this.store.db.prepare("UPDATE local_model_claims SET status='unknown',lastError='accepted job not present in canonical singing table',updatedAt=? WHERE claimId=?").run(this.store.now(), claimId); return 'unknown'; }
    if (TERMINAL.has(job.status)) { this.releaseClaim(claimId, 'released', null, job.status); return job.status; }
    this.store.db.prepare('UPDATE local_model_claims SET status=?,updatedAt=? WHERE claimId=?').run(job.status === 'running' ? 'running' : 'queued', this.store.now(), claimId); return job.status;
  }
  releaseClaim(claimId, status = 'released', error = null, terminalStatus = null) {
    const lease = this.leases.get(claimId); if (lease) { this.leases.delete(claimId); this.coordinator.release(lease); }
    this.store.db.prepare('UPDATE local_model_claims SET status=?,lastError=?,terminalStatus=COALESCE(?,terminalStatus),leaseToken=NULL,updatedAt=? WHERE claimId=?').run(status === 'released' ? 'released' : 'released', error ? String(error).slice(0, 500) : null, terminalStatus, this.store.now(), claimId);
  }
}
