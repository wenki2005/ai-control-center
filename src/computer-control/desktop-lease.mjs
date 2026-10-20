import { randomUUID } from 'node:crypto';

/** Durable, process-wide exclusive lease for the interactive desktop. */
export class DesktopLease {
  constructor({ store, clock = () => Date.now(), defaultTtlMs = 30_000 } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('DesktopLease requires a Store');
    this.store = store;
    this.clock = clock;
    this.defaultTtlMs = defaultTtlMs;
    store.db.exec(`CREATE TABLE IF NOT EXISTS desktop_lease (
      slot TEXT PRIMARY KEY CHECK(slot='desktop'),
      taskId TEXT NOT NULL,
      token TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      updatedAt TEXT NOT NULL
    )`);
    const columns = new Set(store.db.prepare('PRAGMA table_info(desktop_lease)').all().map((row) => row.name));
    if (!columns.has('state')) store.db.exec("ALTER TABLE desktop_lease ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
  }

  acquire(taskId, { ttlMs = this.defaultTtlMs, token = randomUUID() } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId is required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 5 * 60_000) throw new RangeError('ttlMs must be between 1 second and 5 minutes');
    const now = this.clock();
    return this.store.transaction(() => {
      const current = this.store.db.prepare("SELECT * FROM desktop_lease WHERE slot='desktop'").get();
      if (current) {
        if (current.state === 'active' && current.expiresAt <= now) {
          this.store.db.prepare("UPDATE desktop_lease SET state='uncertain',updatedAt=? WHERE slot='desktop' AND state='active' AND expiresAt<=?")
            .run(this.store.now(), now);
        }
        // Expiry means the owner stopped renewing, not that the OS action
        // stopped. Only explicit, verified recovery may clear this row.
        return null;
      }
      this.store.db.prepare("INSERT INTO desktop_lease(slot,taskId,token,expiresAt,state,updatedAt) VALUES('desktop',?,?,?,'active',?)")
        .run(taskId, token, now + ttlMs, this.store.now());
      return { taskId, token, expiresAt: now + ttlMs };
    });
  }

  renew(taskId, token, { ttlMs = this.defaultTtlMs } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 5 * 60_000) throw new RangeError('ttlMs must be between 1 second and 5 minutes');
    const now = this.clock();
    return this.store.db.prepare("UPDATE desktop_lease SET expiresAt=?,updatedAt=? WHERE slot='desktop' AND state='active' AND taskId=? AND token=? AND expiresAt>? ")
      .run(now + ttlMs, this.store.now(), taskId, token, now).changes === 1;
  }

  markUncertain(taskId, token) {
    return this.store.db.prepare("UPDATE desktop_lease SET state='uncertain',updatedAt=? WHERE slot='desktop' AND taskId=? AND token=?")
      .run(this.store.now(), taskId, token).changes === 1;
  }

  release(taskId, token, { verifiedQuiescent = false } = {}) {
    if (verifiedQuiescent !== true) throw new Error('Desktop lease release requires verified quiescence');
    return this.store.db.prepare("DELETE FROM desktop_lease WHERE slot='desktop' AND taskId=? AND token=?")
      .run(taskId, token).changes === 1;
  }

  recoverExpired({ operatorConfirmedQuiescent = false } = {}) {
    if (operatorConfirmedQuiescent !== true) throw new Error('Expired desktop lease requires operator-confirmed quiescence');
    const now = this.clock();
    return this.store.db.prepare("DELETE FROM desktop_lease WHERE slot='desktop' AND expiresAt<=?").run(now).changes === 1;
  }

  recoverUncertain(taskId, token, { operatorConfirmedQuiescent = false } = {}) {
    if (operatorConfirmedQuiescent !== true) throw new Error('Uncertain desktop lease requires operator-confirmed quiescence');
    if (typeof taskId !== 'string' || typeof token !== 'string') throw new TypeError('Lease owner identity is required');
    return this.store.db.prepare("DELETE FROM desktop_lease WHERE slot='desktop' AND taskId=? AND token=? AND state='uncertain'")
      .run(taskId, token).changes === 1;
  }

  current() {
    const now = this.clock();
    const current = this.store.db.prepare("SELECT * FROM desktop_lease WHERE slot='desktop'").get();
    if (!current) return null;
    if (current.state === 'active' && current.expiresAt <= now) {
      this.store.db.prepare("UPDATE desktop_lease SET state='uncertain',updatedAt=? WHERE slot='desktop' AND state='active' AND expiresAt<=?")
        .run(this.store.now(), now);
      current.state = 'uncertain';
    }
    const { taskId, token, expiresAt, state, updatedAt } = current;
    return { taskId, token, expiresAt, state, updatedAt };
  }
}
