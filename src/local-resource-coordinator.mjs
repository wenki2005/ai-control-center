/** In-process, non-preemptive coordination for local compute work. */
export class LocalResourceCoordinator {
  constructor({ readResources = async () => ({ cpuPercent: null, memoryBytes: null, gpuBytes: null }), limits = {}, now = Date.now, onChange = () => {}, maxBypass = 8, fairnessWaitMs = 30000, maxQueued = 128 } = {}) {
    if (typeof readResources !== 'function' || typeof now !== 'function') throw Error('resource reader and clock must be functions');
    if (!Number.isSafeInteger(maxBypass) || maxBypass < 1 || maxBypass > 1000) throw Error('maxBypass must be an integer from 1 to 1000');
    if (!Number.isSafeInteger(fairnessWaitMs) || fairnessWaitMs < 1 || fairnessWaitMs > 3600000) throw Error('fairnessWaitMs must be an integer from 1 to 3600000');
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 4096) throw Error('maxQueued must be an integer from 1 to 4096');
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !['memoryBytes', 'gpuBytes'].includes(key))) throw Error('resource limits may only define memoryBytes and gpuBytes');
    for (const key of ['memoryBytes', 'gpuBytes']) if (limits[key] != null && (!Number.isSafeInteger(limits[key]) || limits[key] < 1)) throw Error(`${key} limit must be a positive safe integer`);
    Object.assign(this, { readResources, limits, now, onChange, maxBypass, fairnessWaitMs, maxQueued });
    this.leases = new Map(); this.queue = []; this.sequence = 0; this.tokenSequence = 0; this.generation = 0; this.releases = new Map();
  }
  async snapshot() {
    try { const value = await this.readResources(); return { scope: 'local-device', cpuPercent: finite(value?.cpuPercent), memoryBytes: finite(value?.memoryBytes), gpuBytes: finite(value?.gpuBytes), observedAt: new Date(this.now()).toISOString() }; }
    catch (error) { return { scope: 'local-device', cpuPercent: null, memoryBytes: null, gpuBytes: null, observedAt: new Date(this.now()).toISOString(), error: String(error?.message || error).slice(0, 300) }; }
  }
  acquire({ owner, kind = 'light', priority = 0, timeoutMs = 0, estimatedMemoryBytes: memoryEstimate, memoryBytes, estimatedGpuBytes: gpuEstimate, gpuBytes, recovery = false } = {}) {
    if (!owner || typeof owner !== 'string') return Promise.reject(Error('resource lease owner required'));
    if (!['light', 'heavy'].includes(kind)) return Promise.reject(Error('resource lease kind must be light or heavy'));
    if (!Number.isFinite(priority)) return Promise.reject(Error('resource priority must be finite'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3600000) return Promise.reject(Error('resource timeoutMs must be from 0 to 3600000'));
    const estimatedMemoryBytes = reservation(memoryEstimate ?? memoryBytes, 'memory');
    const estimatedGpuBytes = reservation(gpuEstimate ?? gpuBytes, 'GPU');
    for (const [key, estimate] of recovery ? [] : [['memoryBytes', estimatedMemoryBytes], ['gpuBytes', estimatedGpuBytes]]) {
      if (this.limits[key] != null && estimate == null) return Promise.reject(Object.assign(Error(`${key} reservation estimate required`), { code: 'RESOURCE_ESTIMATE_REQUIRED' }));
      if (this.limits[key] != null && estimate > this.limits[key]) return Promise.reject(Object.assign(Error(`${key} reservation exceeds configured limit`), { code: 'RESOURCE_OVER_BUDGET' }));
    }
    const item = { owner, kind, estimatedMemoryBytes, estimatedGpuBytes, recovery, priority, sequence: this.sequence++, enqueuedAt: this.now(), bypasses: 0, resolve: null, reject: null, timer: null, canceled: false };
    const promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
    if (timeoutMs > 0) item.timer = setTimeout(() => { item.canceled = true; item.reject(Object.assign(Error('resource lease timed out'), { code: 'RESOURCE_TIMEOUT' })); this.drain(); }, timeoutMs);
    this.drain();
    if (this.queue.length >= this.maxQueued) { clearTimeout(item.timer); item.canceled = true; item.reject(Object.assign(Error('resource lease queue is full'), { code: 'RESOURCE_QUEUE_FULL' })); return promise; }
    this.queue.push(item); this.onChange(this.state()); this.drain(); return promise;
  }
  async run(request, work) { const lease = await this.acquire(request); try { return await work(lease); } finally { this.release(lease); } }
  release(lease) {
    const token = typeof lease === 'string' ? lease : lease?.token; if (!token || !this.leases.has(token)) return false;
    this.leases.delete(token); this.generation++; this.onChange(this.state()); this.drain(); return true;
  }
  state() { return { scope: 'local-device', limits: this.limits, reserved: this.reserved(), active: [...this.leases.values()].map(({ token, owner, kind, recovery, acquiredAt, estimatedMemoryBytes, estimatedGpuBytes }) => ({ token, owner, kind, recovery, acquiredAt, estimatedMemoryBytes, estimatedGpuBytes })), queued: this.queue.filter(x => !x.canceled).length, generation: this.generation }; }
  reserved() { const sum = key => { const values = [...this.leases.values()].map(x => x[key]); return values.some(x => x == null) ? null : values.reduce((a, b) => a + b, 0); }; return { memoryBytes: sum('estimatedMemoryBytes'), gpuBytes: sum('estimatedGpuBytes') }; }
  registerIdleRelease(id, { provenOwned = false, canRelease, release } = {}) {
    if (!id || typeof canRelease !== 'function' || typeof release !== 'function') throw Error('release registration requires id, canRelease and release callbacks');
    this.releases.set(id, { provenOwned: !!provenOwned, canRelease, release }); return () => this.releases.delete(id);
  }
  async idleSweep() {
    const generation = this.generation, results = [];
    if (this.leases.size) return { released: [], skipped: 'active-leases' };
    for (const [id, item] of this.releases) {
      if (!item.provenOwned || this.leases.size || generation !== this.generation) break;
      let safe = false; try { safe = await item.canRelease(); } catch {}
      if (!safe || this.leases.size || generation !== this.generation) continue;
      // Recheck generation after asynchronous safety check; callbacks own their service-specific queue validation.
      const guard = () => this.leases.size === 0 && generation === this.generation;
      try { if (guard()) { await item.release({ generation, isCurrent: guard }); results.push(id); } } catch (error) { results.push({ id, error: String(error?.message || error).slice(0, 200) }); }
    }
    return { released: results };
  }
  drain() {
    this.queue = this.queue.filter(x => !x.canceled).sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    let heavyActive = [...this.leases.values()].some(x => x.kind === 'heavy');
    for (let i = 0; i < this.queue.length;) {
      const item = this.queue[i];
      if (item.kind === 'heavy' && heavyActive && !item.recovery || !this.fits(item)) { i++; continue; }
      if (item.kind === 'light' && this.heavyBarrier()) { i++; continue; }
      if (item.kind === 'light') for (const heavy of this.queue) if (heavy.kind === 'heavy' && heavy.sequence < item.sequence) heavy.bypasses++;
      this.queue.splice(i, 1); clearTimeout(item.timer);
      const lease = { token: `local-resource-${++this.tokenSequence}`, owner: item.owner, kind: item.kind, recovery: item.recovery, estimatedMemoryBytes: item.estimatedMemoryBytes, estimatedGpuBytes: item.estimatedGpuBytes, acquiredAt: new Date(this.now()).toISOString() };
      this.leases.set(lease.token, lease); this.generation++; if (item.kind === 'heavy') heavyActive = true; item.resolve(lease);
    }
    this.onChange(this.state());
  }
  heavyBarrier() { return this.queue.some(x => x.kind === 'heavy' && (x.bypasses >= this.maxBypass || this.now() - x.enqueuedAt >= this.fairnessWaitMs)); }
  fits(item) {
    if (item.recovery) return true;
    for (const [limitKey, estimateKey] of [['memoryBytes', 'estimatedMemoryBytes'], ['gpuBytes', 'estimatedGpuBytes']]) {
      const limit = this.limits[limitKey]; if (limit == null) continue;
      if (item[estimateKey] == null) return false;
      let total = item[estimateKey]; for (const active of this.leases.values()) { if (active[estimateKey] == null) return false; total += active[estimateKey]; }
      if (total > limit) return false;
    }
    return true;
  }
}
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const reservation = (value, label) => value == null ? null : Number.isSafeInteger(value) && value >= 0 ? value : (() => { throw Error(`${label} reservation must be a nonnegative safe integer`); })();
