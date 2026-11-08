import { readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.opus']);
const SKIP_NAMES = new Set(['node_modules', '.git', 'models', 'model', 'checkpoints', 'checkpoint', 'cache', 'caches']);

function normalized(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, '');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class SingingLibrary {
  constructor({ roots, maxFiles = 2000, maxDepth = 5 } = {}) {
    this.roots = Array.isArray(roots) ? roots.map(root => path.resolve(root)) : [];
    this.maxFiles = Math.max(0, Math.floor(maxFiles));
    this.maxDepth = Math.max(0, Math.floor(maxDepth));
    this._indexPromise = null;
  }

  async _index() {
    if (!this._indexPromise) this._indexPromise = this._scan().catch(error => { this._indexPromise = null; throw error; });
    return this._indexPromise;
  }

  async _scan() {
    const found = [];
    const roots = [];
    for (const root of this.roots) {
      try { roots.push({ input: root, real: await realpath(root) }); } catch { /* unavailable root */ }
    }
    const visit = async (root, dir, depth) => {
      if (depth > this.maxDepth || found.length >= this.maxFiles) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const entry of entries) {
        if (found.length >= this.maxFiles) break;
        if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name.toLocaleLowerCase())) continue;
        const candidate = path.join(dir, entry.name);
        let info;
        try { info = await lstat(candidate); } catch { continue; }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (depth < this.maxDepth) await visit(root, candidate, depth + 1);
          continue;
        }
        if (!info.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const verified = await realpath(candidate);
          if (!isInside(root.real, verified)) continue;
          found.push({ path: verified, title: path.basename(candidate, path.extname(candidate)), size: info.size });
        } catch { /* file disappeared or could not be resolved */ }
      }
    };
    for (const root of roots) {
      await visit(root, root.real, 0);
      if (found.length >= this.maxFiles) break;
    }
    return found;
  }

  async list() {
    return (await this._index()).map(({ path: file, title }) => ({ path: file, title }));
  }

  async find(query = '') {
    const files = await this._index();
    const needle = normalized(query);
    const candidates = needle ? files.filter(file => normalized(file.title).includes(needle)) : files;
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
    const { path: file, title } = candidates[0];
    return { path: file, title };
  }
}
