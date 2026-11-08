import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const digest = async file => {
  const handle = await open(file, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest('hex');
  } finally { await handle.close(); }
};
const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 240 && name !== '.' && name !== '..' && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && !/[. ]$/.test(name);
const within = (base, target) => { const rel = path.relative(base, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
const stamp = () => new Date().toISOString();
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase('en-US') : path.resolve(value);
const SECURITY = Object.freeze({ mutationScope: 'existing-files-and-directories-within-explicit-root', symlinks: 'rejected', destinationOverwrite: false, crossVolume: 'unsupported', atomicPathGuard: false, limitation: 'Node path-based filesystem calls cannot pin directory handles; root, parent identities and file paths are rechecked, but hostile concurrent replacement between check and mutation remains a platform race.' });

/** Scoped, journaled file moves and renames. It never overwrites a destination. */
export class FileOperations {
  constructor({ db, allowedRoots, protectedRoots, clock = Date.now, linkFile = link } = {}) {
    if (!db?.exec || !db?.prepare) throw new TypeError('FileOperations requires a node:sqlite DatabaseSync');
    if (!Array.isArray(allowedRoots) || !allowedRoots.length) throw new TypeError('FileOperations requires explicitly configured allowedRoots');
    if (!Array.isArray(protectedRoots) || !protectedRoots.length) throw new TypeError('FileOperations requires protected archive/system roots');
    this.db = db; this.allowedRoots = allowedRoots.map(x => path.resolve(x)); this.protectedRoots = protectedRoots.map(x => path.resolve(x)); this.clock = clock;
    db.exec(`CREATE TABLE IF NOT EXISTS file_operation_plans (
      id TEXT PRIMARY KEY, root TEXT NOT NULL, rootDev TEXT, rootIno TEXT, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS file_operation_items (
      planId TEXT NOT NULL, item INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL,
      hash TEXT NOT NULL, size INTEGER NOT NULL, mtimeMs REAL NOT NULL,
      sourceParentDev TEXT,sourceParentIno TEXT,destinationParentDev TEXT,destinationParentIno TEXT,
      status TEXT NOT NULL, error TEXT,
      PRIMARY KEY(planId,item), FOREIGN KEY(planId) REFERENCES file_operation_plans(id)
    );`);
    const columns = new Set(db.prepare('PRAGMA table_info(file_operation_plans)').all().map(row => row.name));
    if (!columns.has('rootDev')) db.exec('ALTER TABLE file_operation_plans ADD COLUMN rootDev TEXT');
    if (!columns.has('rootIno')) db.exec('ALTER TABLE file_operation_plans ADD COLUMN rootIno TEXT');
    const itemColumns = new Set(db.prepare('PRAGMA table_info(file_operation_items)').all().map(row => row.name));
    for (const name of ['sourceParentDev','sourceParentIno','destinationParentDev','destinationParentIno']) if (!itemColumns.has(name)) db.exec(`ALTER TABLE file_operation_items ADD COLUMN ${name} TEXT`);
    this.linkFile = linkFile;
  }

  async #root(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('An explicit absolute operation root is required');
    const requested = path.resolve(input), root = await realpath(input), info = await stat(root);
    if (root !== requested) throw new Error('Operation root must be a real directory path, not a symbolic-link alias');
    if (!info.isDirectory() || !this.allowedRoots.some(x => within(x, root))) throw new Error('Operation root is outside configured allowed roots');
    for (const protectedRoot of this.protectedRoots) {
      let resolved; try { resolved = await realpath(protectedRoot); } catch { resolved = path.resolve(protectedRoot); }
      if (within(resolved, root) || within(root, resolved)) throw new Error('Operation root overlaps a protected archive or system area');
    }
    return root;
  }

  async #verifyRoot(root, expected = null) {
    const actual = await realpath(root), info = await stat(actual);
    if (actual !== root || !info.isDirectory()) throw new Error('Operation root identity changed');
    if (expected && (String(info.dev) !== String(expected.rootDev) || String(info.ino) !== String(expected.rootIno))) throw new Error('Operation root identity changed since preview');
    return { dev: String(info.dev), ino: String(info.ino) };
  }

  async #file(root, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error('File paths must be relative to the explicit operation root');
    const parts = relativePath.split(/[\\/]/);
    if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Traversal and empty path segments are not allowed');
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in file operations');
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Parent path is not a directory');
      if (i === parts.length - 1 && !info.isFile()) throw new Error('Operation target must be a regular file');
    }
    const actual = await realpath(cursor);
    if (!within(root, actual)) throw new Error('Resolved file escapes the operation root');
    const info = await stat(actual), parent = await this.#parent(root, relativePath);
    return { absolute: actual, hash: await digest(actual), size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, parentDev: parent.dev, parentIno: parent.ino };
  }

  async #parent(root, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error('File paths must be relative to the explicit operation root');
    const parts = relativePath.split(/[\\/]/);
    if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Traversal and empty path segments are not allowed');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Parent path must be an existing non-symlink directory');
      const actual = await realpath(cursor);
      if (!within(root, actual)) throw new Error('Resolved parent directory escapes operation root');
    }
    const actual = await realpath(cursor), info = await stat(actual);
    if (!within(root, actual) || !info.isDirectory()) throw new Error('Resolved parent directory escapes operation root');
    return { absolute: actual, dev: String(info.dev), ino: String(info.ino) };
  }

  async #destination(root, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error('Destination must be relative to the explicit operation root');
    const parts = relativePath.split(/[\\/]/);
    if (parts.some(p => !p || p === '.' || p === '..') || !safeName(parts.at(-1))) throw new Error('Destination must be a safe relative file path');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      let info; try { info = await lstat(parent); } catch (error) { if (error.code === 'ENOENT') throw new Error('Destination parent directory must already exist'); throw error; }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Destination parent must be an existing non-symlink directory');
      const actual = await realpath(parent);
      if (!within(root, actual)) throw new Error('Resolved destination parent escapes operation root');
    }
    const destination = path.join(parent, parts.at(-1));
    if (!within(root, destination)) throw new Error('Destination escapes operation root');
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink()) throw new Error('Destination cannot be a symbolic link');
      const actual = await realpath(destination);
      if (!within(root, actual)) throw new Error('Resolved destination escapes operation root');
      const parentIdentity = await this.#parent(root, relativePath);
      return { absolute: actual, exists: true, parentDev: parentIdentity.dev, parentIno: parentIdentity.ino };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parentIdentity = await this.#parent(root, relativePath);
      return { absolute: destination, exists: false, parentDev: parentIdentity.dev, parentIno: parentIdentity.ino };
    }
  }

  async #assertParent(root, relativePath, expected) {
    const parent = await this.#parent(root, relativePath);
    if (expected && (parent.dev !== String(expected.dev) || parent.ino !== String(expected.ino))) throw new Error(`Parent directory identity changed: ${path.dirname(relativePath) || '.'}`);
    return parent;
  }

  #assertPlannedParents(item, source, target) {
    if (source.parentDev !== item.sourceParentDev || source.parentIno !== item.sourceParentIno || target.parentDev !== item.destinationParentDev || target.parentIno !== item.destinationParentIno) {
      this.#save(item.planId, 'needs-reconciliation', item.item, 'A source or destination parent changed since preview');
      throw new Error('Parent directory identity changed since preview');
    }
  }

  async #unlinkVerified(root, file, expected) {
    const latest = await this.#file(root, path.relative(root, file.absolute));
    if (latest.dev !== expected.dev || latest.ino !== expected.ino || latest.hash !== expected.hash || latest.size !== expected.size) throw new Error('File identity changed; refusing to unlink');
    await this.#assertParent(root, path.relative(root, latest.absolute), expected.parent);
    await unlink(latest.absolute);
  }

  /** operations: {type:'rename',from,to} | {type:'move',from,to}; dedupe requests report candidates only. */
  async preview({ root: requestedRoot, operations = [], dedupe = false } = {}) {
    const root = await this.#root(requestedRoot);
    if (!Array.isArray(operations) || operations.length > 500) throw new Error('At most 500 file operations may be previewed');
    const items = [], seen = new Map();
    if (dedupe) {
      const candidates = [];
      for (const entry of operations) { const file = await this.#file(root, entry.from); const prior = seen.get(file.hash); if (prior) candidates.push({ hash: file.hash, kept: prior, duplicate: entry.from }); else seen.set(file.hash, entry.from); }
      return { id: null, root, status: 'report-only', duplicateCandidates: candidates, items: [] };
    }
    const sources = new Map(), destinations = new Map(), candidates = [];
    for (const [index, op] of operations.entries()) {
      if (!op || !['rename', 'move'].includes(op.type) || typeof op.from !== 'string' || typeof op.to !== 'string') throw new Error('Each operation must specify rename or move with relative from/to paths');
      const source = await this.#file(root, op.from);
      const target = await this.#destination(root, op.to), destination = target.absolute;
      if (!within(root, destination) || path.resolve(source.absolute) === destination) throw new Error('Destination must be a different path inside operation root');
      if (target.exists) throw new Error(`Destination already exists: ${op.to}`);
      const sourceKey = pathKey(path.join(root, op.from)), destinationKey = pathKey(destination);
      if (sources.has(sourceKey)) throw new Error(`Duplicate source path: ${op.from}`);
      if (destinations.has(destinationKey)) throw new Error(`Duplicate destination path: ${op.to}`);
      sources.set(sourceKey, op.from); destinations.set(destinationKey, op.to);
      candidates.push({ item: index, kind: op.type, source: op.from, destination: op.to, sourceKey, destinationKey, hash: source.hash, size: source.size, mtimeMs: source.mtimeMs, sourceParentDev: source.parentDev, sourceParentIno: source.parentIno, destinationParentDev: target.parentDev, destinationParentIno: target.parentIno, status: 'planned' });
    }
    for (const item of candidates) if (sources.has(item.destinationKey)) throw new Error(`Operation paths overlap; transient targets are unsupported: ${item.destination}`);
    items.push(...candidates.map(({ sourceKey, destinationKey, ...item }) => item));
    const rootIdentity = await this.#verifyRoot(root);
    const id = randomUUID(), now = stamp();
    this.db.prepare('INSERT INTO file_operation_plans(id,root,rootDev,rootIno,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run(id, root, rootIdentity.dev, rootIdentity.ino, 'previewed', now, now);
    const insert = this.db.prepare('INSERT INTO file_operation_items(planId,item,kind,source,destination,hash,size,mtimeMs,sourceParentDev,sourceParentIno,destinationParentDev,destinationParentIno,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const item of items) insert.run(id, item.item, item.kind, item.source, item.destination, item.hash, item.size, item.mtimeMs, item.sourceParentDev, item.sourceParentIno, item.destinationParentDev, item.destinationParentIno, item.status);
    return { id, root, status: 'previewed', items };
  }

  #plan(id) { const plan = this.db.prepare('SELECT * FROM file_operation_plans WHERE id=?').get(String(id)); if (!plan) throw new Error('Unknown file operation plan'); return plan; }
  #items(id) { return this.db.prepare('SELECT * FROM file_operation_items WHERE planId=? ORDER BY item').all(String(id)); }
  #save(planId, status, item, error = null) { const now = stamp(); if (item !== undefined) this.db.prepare('UPDATE file_operation_items SET status=?,error=? WHERE planId=? AND item=?').run(status, error, planId, item); this.db.prepare('UPDATE file_operation_plans SET status=?,updatedAt=? WHERE id=?').run(status, now, planId); }

  status(id) { const plan = this.#plan(id); return { id: plan.id, root: plan.root, status: plan.status, createdAt: plan.createdAt, updatedAt: plan.updatedAt, security: SECURITY, items: this.#items(id) }; }

  cancel(id) {
    const plan = this.#plan(id);
    if (plan.status === 'cancelled') return this.status(id);
    const result = this.db.prepare(`UPDATE file_operation_plans SET status='cancelled',updatedAt=?
      WHERE id=? AND status='previewed'
      AND NOT EXISTS (SELECT 1 FROM file_operation_items WHERE planId=? AND status<>'planned')`).run(stamp(), id, id);
    if (result.changes === 1) return this.status(id);
    throw new Error('Only an unexecuted preview can be cancelled; reconcile or finish the plan first');
  }

  async commit(id) {
    const plan = this.#plan(id), root = await this.#root(plan.root);
    await this.#verifyRoot(root, plan);
    if (plan.status === 'committed') return this.status(id);
    if (plan.status === 'cancelled') throw new Error('Plan is cancelled');
    const claimed = this.db.prepare("UPDATE file_operation_plans SET status='committing',updatedAt=? WHERE id=? AND status='previewed'").run(stamp(), id).changes;
    if (claimed !== 1) throw new Error('Plan is already running or requires reconciliation');
    for (const item of this.#items(id)) {
      if (item.status === 'moved') continue;
      if (item.status !== 'planned') throw new Error(`Plan item ${item.item} needs reconciliation before commit`);
      const source = await this.#file(root, item.source);
      if (source.hash !== item.hash || source.size !== item.size || source.mtimeMs !== item.mtimeMs) { this.#save(id, 'needs-reconciliation', item.item, 'Source changed since preview'); throw new Error(`Source changed since preview: ${item.source}`); }
      const target = await this.#destination(root, item.destination), destination = target.absolute;
      if (target.exists) { this.#save(id, 'needs-reconciliation', item.item, 'Destination appeared after preview'); throw new Error(`Destination already exists: ${item.destination}`); }
      this.#assertPlannedParents(item, source, target);
      this.#save(id, 'committing', item.item);
      try {
        await this.#verifyRoot(root, plan);
        await this.#assertParent(root, item.source, { dev: item.sourceParentDev, ino: item.sourceParentIno });
        await this.#assertParent(root, item.destination, { dev: item.destinationParentDev, ino: item.destinationParentIno });
        const currentTarget = await this.#destination(root, item.destination);
        if (currentTarget.exists) throw new Error(`Destination already exists: ${item.destination}`);
        const current = await this.#file(root, item.source);
        if (current.hash !== item.hash || current.size !== item.size || current.mtimeMs !== item.mtimeMs || current.dev !== source.dev || current.ino !== source.ino || current.parentDev !== item.sourceParentDev || current.parentIno !== item.sourceParentIno) throw new Error(`Source changed before move: ${item.source}`);
        await this.linkFile(current.absolute, destination);
        const linked = await this.#file(root, item.destination), beforeUnlink = await this.#file(root, item.source);
        if (linked.hash !== item.hash || beforeUnlink.hash !== item.hash || linked.dev !== beforeUnlink.dev || linked.ino !== beforeUnlink.ino || linked.parentDev !== item.destinationParentDev || linked.parentIno !== item.destinationParentIno || beforeUnlink.parentDev !== item.sourceParentDev || beforeUnlink.parentIno !== item.sourceParentIno) throw new Error('File or parent identity changed during move; source retained for reconciliation');
        await this.#unlinkVerified(root, beforeUnlink, { dev: linked.dev, ino: linked.ino, hash: item.hash, size: item.size, parent: { dev: item.sourceParentDev, ino: item.sourceParentIno } }); this.#save(id, 'committing', item.item, null);
      }
      catch (error) { this.#save(id, 'needs-reconciliation', item.item, error.code === 'EXDEV' ? 'Cross-volume move is not supported in this version' : error.message); throw error; }
      const result = await this.#file(root, item.destination);
      if (result.hash !== item.hash) { this.#save(id, 'needs-reconciliation', item.item, 'Destination hash differs after rename'); throw new Error('Destination hash differs after rename'); }
      this.#save(id, 'moved', item.item);
    }
    this.#save(id, 'committed'); return { id, status: 'committed', items: this.#items(id) };
  }

  async reconcile(id) {
    const plan = this.#plan(id), root = await this.#root(plan.root);
    await this.#verifyRoot(root, plan);
    for (const item of this.#items(id)) {
      if (!['planned', 'committing', 'undoing', 'needs-reconciliation'].includes(item.status)) continue;
      let source = null, destination = null;
      const sourceTarget = await this.#destination(root, item.source), destinationTarget = await this.#destination(root, item.destination);
      if (sourceTarget.parentDev !== item.sourceParentDev || sourceTarget.parentIno !== item.sourceParentIno || destinationTarget.parentDev !== item.destinationParentDev || destinationTarget.parentIno !== item.destinationParentIno) throw new Error('Parent directory identity changed; both paths require manual inspection');
      try { source = await this.#file(root, item.source); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { destination = await this.#file(root, item.destination); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (item.status === 'undoing' && source?.hash === item.hash && destination?.hash === item.hash && source.size === destination.size) {
        const currentSource = await this.#file(root, item.source), currentDestination = await this.#file(root, item.destination);
        if (currentSource.dev !== currentDestination.dev || currentSource.ino !== currentDestination.ino) throw new Error('Interrupted undo paths are not the same file');
        await this.#unlinkVerified(root, currentDestination, { dev: currentSource.dev, ino: currentSource.ino, hash: item.hash, size: item.size, parent: { dev: item.destinationParentDev, ino: item.destinationParentIno } }); this.#save(id, 'planned', item.item, null);
      }
      else if (item.status !== 'undoing' && source?.hash === item.hash && destination?.hash === item.hash && source.size === destination.size) {
        // A crash may occur after the no-overwrite hard link but before unlinking
        // the source. Remove only the exact verified duplicate created by this plan.
        const currentSource = await this.#file(root, item.source), currentDestination = await this.#file(root, item.destination);
        if (currentSource.dev !== currentDestination.dev || currentSource.ino !== currentDestination.ino) throw new Error('Interrupted move paths are not the same file');
        await this.#unlinkVerified(root, currentSource, { dev: currentDestination.dev, ino: currentDestination.ino, hash: item.hash, size: item.size, parent: { dev: item.sourceParentDev, ino: item.sourceParentIno } }); this.#save(id, 'moved', item.item, null);
      }
      else if (source?.hash === item.hash && !destination) this.#save(id, 'planned', item.item, null);
      else if (!source && destination?.hash === item.hash) this.#save(id, 'moved', item.item, null);
      else { this.#save(id, 'needs-reconciliation', item.item, 'Current source/destination state does not match the recorded operation'); }
    }
    const statuses = this.#items(id).map(x => x.status), status = statuses.every(x => x === 'moved') ? 'committed' : statuses.includes('needs-reconciliation') ? 'needs-reconciliation' : 'previewed';
    this.#save(id, status); return { id, status, items: this.#items(id) };
  }

  async undo(id) {
    const plan = this.#plan(id), root = await this.#root(plan.root), items = this.#items(id).reverse();
    await this.#verifyRoot(root, plan);
    if (plan.status === 'undone') return this.status(id);
    const claimed = this.db.prepare("UPDATE file_operation_plans SET status='undoing',updatedAt=? WHERE id=? AND status='committed'").run(stamp(), id).changes;
    if (claimed !== 1) throw new Error('Plan is already running or requires reconciliation');
    for (const item of items) {
      if (item.status === 'planned') continue;
      if (item.status !== 'moved') throw new Error(`Plan item ${item.item} must be reconciled before undo`);
      const moved = await this.#file(root, item.destination);
      if (moved.hash !== item.hash || moved.size !== item.size) throw new Error(`Moved file changed since operation; refusing to overwrite: ${item.destination}`);
      if (moved.parentDev !== item.destinationParentDev || moved.parentIno !== item.destinationParentIno) throw new Error('Destination parent identity changed; undo requires reconciliation');
      const sourceTarget = await this.#destination(root, item.source), sourcePath = sourceTarget.absolute;
      if (sourceTarget.exists) throw new Error(`Original path now exists; refusing to overwrite: ${item.source}`);
      if (sourceTarget.parentDev !== item.sourceParentDev || sourceTarget.parentIno !== item.sourceParentIno) throw new Error('Source parent identity changed; undo requires reconciliation');
      this.#save(id, 'undoing', item.item);
      try {
        await this.#verifyRoot(root, plan);
        await this.#assertParent(root, item.source, { dev: item.sourceParentDev, ino: item.sourceParentIno });
        await this.#assertParent(root, item.destination, { dev: item.destinationParentDev, ino: item.destinationParentIno });
        const sourceNow = await this.#destination(root, item.source); if (sourceNow.exists) throw new Error('Original path appeared before undo');
        const currentMoved = await this.#file(root, item.destination);
        if (currentMoved.hash !== item.hash || currentMoved.size !== item.size || currentMoved.dev !== moved.dev || currentMoved.ino !== moved.ino) throw new Error('Moved file changed before undo');
        await this.linkFile(currentMoved.absolute, sourcePath);
        const restored = await this.#file(root, item.source), beforeUnlink = await this.#file(root, item.destination);
        if (restored.hash !== item.hash || beforeUnlink.hash !== item.hash || restored.dev !== beforeUnlink.dev || restored.ino !== beforeUnlink.ino || restored.parentDev !== item.sourceParentDev || restored.parentIno !== item.sourceParentIno || beforeUnlink.parentDev !== item.destinationParentDev || beforeUnlink.parentIno !== item.destinationParentIno) throw new Error('File or parent identity changed during undo; both paths retained for reconciliation');
        await this.#unlinkVerified(root, beforeUnlink, { dev: restored.dev, ino: restored.ino, hash: item.hash, size: item.size, parent: { dev: item.destinationParentDev, ino: item.destinationParentIno } });
      } catch (error) { this.#save(id, 'needs-reconciliation', item.item, error.code === 'EXDEV' ? 'Cross-volume undo is not supported in this version' : error.message); throw error; }
      this.#save(id, 'planned', item.item, null);
    }
    this.#save(id, 'undone'); return { id, status: 'undone', items: this.#items(id) };
  }
}
