import { randomUUID } from 'node:crypto';

/** Durable, process-wide exclusive lease for the interactive desktop. */
export class DesktopLease {
  constructor({ store, clock = () => Date.now(), defaultTtlMs = 30_000, activitySampler } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('DesktopLease requires a Store');
    this.store = store;
    this.clock = clock;
    this.defaultTtlMs = defaultTtlMs;
    this.activitySampler = typeof activitySampler === 'function' ? activitySampler : null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS desktop_lease (
      slot TEXT PRIMARY KEY,
      deviceId TEXT NOT NULL DEFAULT 'desktop',
      taskId TEXT NOT NULL,
      token TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      updatedAt TEXT NOT NULL
    )`);
    const columns = new Set(store.db.prepare('PRAGMA table_info(desktop_lease)').all().map((row) => row.name));
    if (!columns.has('state')) store.db.exec("ALTER TABLE desktop_lease ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
    if (!columns.has('deviceId')) store.db.exec("ALTER TABLE desktop_lease ADD COLUMN deviceId TEXT NOT NULL DEFAULT 'desktop'");
    store.db.exec(`CREATE TABLE IF NOT EXISTS desktop_user_control (
      deviceId TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL
    )`);
    const tableSql = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='desktop_lease'").get()?.sql || '';
    if (/CHECK\s*\(\s*slot\s*=\s*'desktop'\s*\)/i.test(tableSql)) store.transaction(() => {
      store.db.exec(`ALTER TABLE desktop_lease RENAME TO desktop_lease_legacy;
        CREATE TABLE desktop_lease(slot TEXT PRIMARY KEY,deviceId TEXT NOT NULL DEFAULT 'desktop',taskId TEXT NOT NULL,token TEXT NOT NULL,expiresAt INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'active',updatedAt TEXT NOT NULL);
        INSERT INTO desktop_lease(slot,deviceId,taskId,token,expiresAt,state,updatedAt) SELECT 'desktop','desktop',taskId,token,expiresAt,state,updatedAt FROM desktop_lease_legacy;
        DROP TABLE desktop_lease_legacy;`);
    });
  }

  #slot(deviceId = 'desktop') {
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/.test(deviceId)) throw new TypeError('Invalid desktop deviceId');
    return deviceId === 'desktop' ? 'desktop' : `desktop:${deviceId}`;
  }

  acquire(taskId, { ttlMs = this.defaultTtlMs, token = randomUUID(), deviceId = 'desktop' } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId is required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 5 * 60_000) throw new RangeError('ttlMs must be between 1 second and 5 minutes');
    const now = this.clock();
    const slot = this.#slot(deviceId);
    return this.store.transaction(() => {
      if (this.store.db.prepare('SELECT paused FROM desktop_user_control WHERE deviceId=?').get(deviceId)?.paused === 1) return null;
      const current = this.store.db.prepare('SELECT * FROM desktop_lease WHERE slot=?').get(slot);
      if (current) {
        if (current.state === 'active' && current.expiresAt <= now) {
          this.store.db.prepare("UPDATE desktop_lease SET state='uncertain',updatedAt=? WHERE slot=? AND state='active' AND expiresAt<=?")
            .run(this.store.now(), slot, now);
        }
        // Expiry means the owner stopped renewing, not that the OS action
        // stopped. Only explicit, verified recovery may clear this row.
        return null;
      }
      this.store.db.prepare("INSERT INTO desktop_lease(slot,deviceId,taskId,token,expiresAt,state,updatedAt) VALUES(?,?,?,?,?,'active',?)")
        .run(slot, deviceId, taskId, token, now + ttlMs, this.store.now());
      return { taskId, token, ...(deviceId==='desktop'?{}:{deviceId}), expiresAt: now + ttlMs };
    });
  }

  renew(taskId, token, { ttlMs = this.defaultTtlMs, deviceId = 'desktop' } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 5 * 60_000) throw new RangeError('ttlMs must be between 1 second and 5 minutes');
    const now = this.clock();
    return this.store.db.prepare("UPDATE desktop_lease SET expiresAt=?,updatedAt=? WHERE slot=? AND state='active' AND taskId=? AND token=? AND expiresAt>? ")
      .run(now + ttlMs, this.store.now(), this.#slot(deviceId), taskId, token, now).changes === 1;
  }

  markUncertain(taskId, token, { deviceId = 'desktop' } = {}) {
    return this.store.db.prepare("UPDATE desktop_lease SET state='uncertain',updatedAt=? WHERE slot=? AND taskId=? AND token=?")
      .run(this.store.now(), this.#slot(deviceId), taskId, token).changes === 1;
  }

  yieldToUser(taskId, token, { deviceId = 'desktop' } = {}) {
    return this.store.db.prepare("UPDATE desktop_lease SET state='yielded',updatedAt=? WHERE slot=? AND taskId=? AND token=? AND state='active'")
      .run(this.store.now(), this.#slot(deviceId), taskId, token).changes === 1;
  }

  pauseForUser(deviceId = 'desktop') {
    const slot = this.#slot(deviceId);
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO desktop_user_control(deviceId,paused,updatedAt) VALUES(?,1,?)
        ON CONFLICT(deviceId) DO UPDATE SET paused=1,updatedAt=excluded.updatedAt`).run(deviceId, this.store.now());
      this.store.db.prepare("UPDATE desktop_lease SET state='yielded',updatedAt=? WHERE slot=? AND state='active'")
        .run(this.store.now(), slot);
      return this.current(deviceId);
    });
  }

  resumeUserControl(deviceId = 'desktop', { operatorConfirmedQuiescent = false, userContinues = false } = {}) {
    if (operatorConfirmedQuiescent !== true || userContinues !== true) throw new Error('Resume requires confirmed desktop quiescence and explicit user continuation');
    return this.store.db.prepare('UPDATE desktop_user_control SET paused=0,updatedAt=? WHERE deviceId=? AND paused=1')
      .run(this.store.now(), deviceId).changes === 1;
  }

  resume(taskId, token, { deviceId = 'desktop', operatorConfirmedQuiescent = false, userContinues = false } = {}) {
    if (operatorConfirmedQuiescent !== true || userContinues !== true) throw new Error('Resume requires confirmed desktop quiescence and explicit user continuation');
    return this.store.db.prepare("UPDATE desktop_lease SET state='active',expiresAt=?,updatedAt=? WHERE slot=? AND taskId=? AND token=? AND state IN ('yielded','uncertain')")
      .run(this.clock() + this.defaultTtlMs, this.store.now(), this.#slot(deviceId), taskId, token).changes === 1;
  }

  async sampleUserActivity(deviceId = 'desktop') {
    if (!this.activitySampler) return { status: 'unknown', timestamp: null };
    try { const timestamp = await this.activitySampler(deviceId); return Number.isFinite(timestamp) ? { status: 'timestamp', timestamp } : { status: 'unknown', timestamp: null }; }
    catch { return { status: 'unknown', timestamp: null }; }
  }

  release(taskId, token, { verifiedQuiescent = false, deviceId = 'desktop' } = {}) {
    if (verifiedQuiescent !== true) throw new Error('Desktop lease release requires verified quiescence');
    return this.store.db.prepare('DELETE FROM desktop_lease WHERE slot=? AND taskId=? AND token=?')
      .run(this.#slot(deviceId), taskId, token).changes === 1;
  }

  recoverExpired({ operatorConfirmedQuiescent = false, deviceId = 'desktop' } = {}) {
    if (operatorConfirmedQuiescent !== true) throw new Error('Expired desktop lease requires operator-confirmed quiescence');
    const now = this.clock();
    return this.store.db.prepare('DELETE FROM desktop_lease WHERE slot=? AND expiresAt<=?').run(this.#slot(deviceId), now).changes === 1;
  }

  recoverUncertain(taskId, token, { operatorConfirmedQuiescent = false, deviceId = 'desktop' } = {}) {
    if (operatorConfirmedQuiescent !== true) throw new Error('Uncertain desktop lease requires operator-confirmed quiescence');
    if (typeof taskId !== 'string' || typeof token !== 'string') throw new TypeError('Lease owner identity is required');
    return this.store.db.prepare("DELETE FROM desktop_lease WHERE slot=? AND taskId=? AND token=? AND state='uncertain'")
      .run(this.#slot(deviceId), taskId, token).changes === 1;
  }

  current(deviceId = 'desktop') {
    const now = this.clock();
    const slot = this.#slot(deviceId);
    const current = this.store.db.prepare('SELECT * FROM desktop_lease WHERE slot=?').get(slot);
    if (!current) return null;
    if (current.state === 'active' && current.expiresAt <= now) {
      this.store.db.prepare("UPDATE desktop_lease SET state='uncertain',updatedAt=? WHERE slot=? AND state='active' AND expiresAt<=?")
        .run(this.store.now(), slot, now);
      current.state = 'uncertain';
    }
    const { taskId, token, expiresAt, state, updatedAt, deviceId: currentDevice } = current;
    return { taskId, token, deviceId: currentDevice, expiresAt, state, updatedAt };
  }
}
