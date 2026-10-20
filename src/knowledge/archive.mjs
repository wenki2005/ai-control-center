import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { DOCUMENT_EXTENSIONS, extractDocumentText } from './document-reader.mjs';
import { readStableFile } from './read-stable-file.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_DEPTH = 20;
const MAX_ELAPSED_MS = 30_000;
const MAX_DIRECTORIES = 10_000;
const MAX_WARNINGS = 1000;
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'build', 'dist', 'out', 'coverage',
  '.cache', 'cache', '.next', '.nuxt', '.turbo', '.venv', 'venv', '__pycache__', '.pnpm-store',
  '.npm', '.yarn', '.gradle', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  '.ssh', '.aws', '.kube', '.docker',
  'runtime', 'tmp', 'temp',
]);
const SECRET_NAME = /(^|[._-])(\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|token|private[-_.]?key|id_rsa|id_ed25519)(?=$|[._-])/i;
const SECRET_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:_authToken|_password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|authorization)\s*[:=]\s*["']?[^\s"']+/i;
const SECRET_CONFIG_NAME = /(?:^|[._-])(?:config|settings|auth|credential|secret)(?:[._-].*)?\.(?:json|ya?ml|toml|ini|conf|config)$/i;

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function normalizePath(value) {
  return path.resolve(String(value));
}

function samePath(first, second) {
  return within(first, second) && within(second, first);
}

function safeExcerpt(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 320);
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

function sourceCategory(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (['.txt', '.log', '.csv', '.tsv'].includes(ext)) return 'text';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.html', '.css', '.json', '.yaml', '.yml', '.toml', '.xml', '.sql', '.sh', '.ps1'].includes(ext)) return 'source';
  return 'file';
}

function mimeType(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return ({'.md':'text/markdown','.markdown':'text/markdown','.txt':'text/plain','.json':'application/json','.csv':'text/csv','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.avif':'image/avif','.svg':'image/svg+xml','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})[ext] || 'application/octet-stream';
}

function markdownMedia(text) {
  const found=[];
  const source=String(text || '');
  const pattern=/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for(const match of source.matchAll(pattern)) {
    const src=match[2] || match[3];
    if(!src || /^data:/i.test(src))continue;
    found.push({alt:match[1] || '',src});
  }
  return found.slice(0,50);
}

export class Archive {
  constructor({ db, root, allowedRoots = [], limits = {}, pythonCommand } ) {
    if (!db?.exec || !db?.prepare) throw new TypeError('Archive requires a node:sqlite DatabaseSync instance');
    if (!root) throw new TypeError('Archive requires a storage root');
    this.db = db;
    this.root = normalizePath(root);
    this.realRoot = null;
    this.allowedRoots = allowedRoots.map(normalizePath);
    this.pythonCommand = pythonCommand;
    this.limits = {
      maxFiles: limits.maxFiles ?? MAX_FILES,
      maxDepth: limits.maxDepth ?? MAX_DEPTH,
      maxElapsedMs: limits.maxElapsedMs ?? MAX_ELAPSED_MS,
      maxDirectories: limits.maxDirectories ?? MAX_DIRECTORIES,
    };
    this._ready = this.#initialize();
  }

  async #initialize() {
    await this.#assertNoSymlinkComponents(this.root);
    await mkdir(this.root, { recursive: true });
    await this.#assertNoSymlinkComponents(this.root);
    this.realRoot = await realpath(this.root);
    if (!samePath(this.root, this.realRoot)) throw new Error('Archive root resolves through a symlink or junction');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL,
        excerpt TEXT NOT NULL DEFAULT '',
        text_content TEXT NOT NULL DEFAULT '',
        UNIQUE(task_id, source_path, hash)
      );
      CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts(task_id, created_at);
      CREATE INDEX IF NOT EXISTS artifacts_hash_idx ON artifacts(hash);
      CREATE INDEX IF NOT EXISTS artifacts_name_idx ON artifacts(name);
    `);
    this.#ensureStatements();
  }

  async #assertNoSymlinkComponents(target) {
    const absolute = normalizePath(target);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let item;
      try { item = await lstat(current); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (item.isSymbolicLink()) throw new Error(`Archive path contains a symlink or junction: ${current}`);
    }
  }

  async #assertArchiveRoot() {
    await this.#assertNoSymlinkComponents(this.root);
    const current = await realpath(this.root);
    if (!this.realRoot || !samePath(current, this.realRoot)) throw new Error('Archive root changed or resolves outside its initialized directory');
    return current;
  }

  #ensureStatements() {
    this.insertArtifact = this.db.prepare(`
      INSERT OR IGNORE INTO artifacts
        (id, task_id, name, path, source_path, hash, size, category, created_at, excerpt, text_content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectAll = this.db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC, id');
    this.selectTask = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC, name COLLATE NOCASE');
    this.selectId = this.db.prepare('SELECT * FROM artifacts WHERE id = ?');
    this.selectSource = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? AND source_path = ? AND hash = ?');
    this.selectSearch = this.db.prepare(`
      SELECT * FROM artifacts
      WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(excerpt), lower(?)) > 0 OR instr(lower(text_content), lower(?)) > 0
      ORDER BY created_at DESC, name COLLATE NOCASE
    `);
  }

  #record(row,{includeText=false,maxTextLength=12000}={}) {
    if (!row) return null;
    const record={
      id: row.id,
      taskId: row.task_id,
      name: row.name,
      path: row.path,
      sourcePath: row.source_path,
      hash: row.hash,
      size: Number(row.size),
      category: row.category,
      createdAt: row.created_at,
      excerpt: row.excerpt,
      mimeType: mimeType(row.name),
      isImage: /^image\//.test(mimeType(row.name)),
    };
    if(includeText){
      const limit = Math.max(0, Number(maxTextLength) || 0);
      record.text = String(row.text_content || '').slice(0, limit);
      record.media=markdownMedia(row.text_content || '');
    }
    return record;
  }

  async #allowedCwd(cwd) {
    const requested = normalizePath(cwd);
    const physical = await realpath(requested);
    if (!within(physical, requested) || !within(requested, physical)) throw new Error('Task working directory may not be a symlink or junction');
    const info = await stat(physical);
    if (!info.isDirectory()) throw new Error('Task working directory must be a directory');
    const roots = await Promise.all(this.allowedRoots.map(async (root) => {
      try { return await realpath(root); } catch { return root; }
    }));
    if (!roots.some((root) => within(root, physical) && root !== physical)) {
      throw new Error('Task working directory is outside the allowed workspace roots');
    }
    // Walk each component to reject junctions/symlinks, including a symlinked child inside a valid root.
    const matchingRoot = roots.find((root) => within(root, physical) && root !== physical);
    let current = matchingRoot;
    const rel = path.relative(matchingRoot, physical);
    for (const part of rel.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const item = await lstat(current);
      if (item.isSymbolicLink()) throw new Error('Task working directory path contains a symlink');
    }
    return physical;
  }

  #exclusionReason(relativePath, isDirectory) {
    const parts = relativePath.split(/[\\/]/);
    if (parts.some((part) => part.startsWith('.') && part !== '.well-known')) {
      if (parts.some((part) => SECRET_NAME.test(part))) return 'credential or secret path';
      if (parts.some((part) => ['.git', '.hg', '.svn'].includes(part.toLowerCase()))) return 'version-control metadata';
    }
    const base = path.basename(relativePath);
    if (SECRET_NAME.test(base)) return 'credential or secret filename';
    if (SECRET_CONFIG_NAME.test(base)) return 'secret configuration filename';
    if (isDirectory && SKIP_DIRS.has(base.toLowerCase())) return 'build, dependency, or cache directory';
    return null;
  }

  async #copyBlob(buffer, hash) {
    const root = await this.#assertArchiveRoot();
    const directory = path.join(this.root, 'files', hash.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await this.#assertArchiveRoot();
    if (!within(root, await realpath(directory))) throw new Error('Archive blob directory resolves outside the archive root');
    const destination = path.join(directory, hash);
    try {
      const current = await readFile(destination);
      if (createHash('sha256').update(current).digest('hex') === hash) return path.relative(this.root, destination);
      await this.#assertArchiveRoot();
      await rm(destination, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx');
      try { await handle.writeFile(buffer); await handle.sync(); }
      finally { await handle.close(); }
      await this.#assertArchiveRoot();
      if (!within(root, await realpath(directory))) throw new Error('Archive blob directory resolves outside the archive root');
      await rename(temp, destination);
    } finally {
      await rm(temp, { force: true });
    }
    const saved = await readFile(destination);
    if (createHash('sha256').update(saved).digest('hex') !== hash) throw new Error('Archived blob failed its SHA-256 integrity check after writing');
    return path.relative(this.root, destination);
  }

  async #addRecord({ taskId, name, sourcePath, buffer, text, category, createdAt }) {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const relativeArchivePath = await this.#copyBlob(buffer, hash);
    const existing = this.selectSource.get(String(taskId), sourcePath, hash);
    const id = existing?.id ?? randomUUID();
    this.insertArtifact.run(
      id, String(taskId), name, relativeArchivePath, sourcePath, hash, buffer.byteLength, category,
      createdAt, safeExcerpt(text ?? ''), text ?? '',
    );
    return this.#record(this.selectSource.get(String(taskId), sourcePath, hash),{includeText:true});
  }

  async collect({ taskId, cwd }) {
    await this._ready;
    if (taskId === undefined || taskId === null || String(taskId).trim() === '') throw new TypeError('taskId is required');
    const workspace = await this.#allowedCwd(cwd);
    const createdAt = new Date().toISOString();
    const found = [];
    const warnings = [];
    let omittedWarnings = 0;
    let total = 0;
    let fileCount = 0;
    let directoryCount = 0;
    let stopped = false;
    const startedAt = Date.now();
    const warn = (relativePath, reason) => {
      if (warnings.length < MAX_WARNINGS) warnings.push({ path: relativePath || '.', reason });
      else omittedWarnings++;
    };

    const visit = async (directory, relativeDirectory = '', depth = 0) => {
      const dir = await opendir(directory);
      const entries = [];
      for await (const entry of dir) entries.push(entry);
      // A task-wide time budget must not let a large scratch subtree consume
      // the window before deliverables beside it are even inspected. Process
      // regular files in this directory first, then descend into subfolders.
      // Array#sort is stable, so the original order is preserved within each
      // group.
      entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()));
      for (const entry of entries) {
        const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
        if (Date.now() - startedAt >= this.limits.maxElapsedMs) {
          warn(relative, `collection time limit reached (${this.limits.maxElapsedMs} ms)`);
          stopped = true;
          break;
        }
        if (entry.isFile() || entry.isSymbolicLink()) {
          fileCount++;
          if (fileCount > this.limits.maxFiles) {
            warn(relative, `file count limit reached (${this.limits.maxFiles})`);
            stopped = true;
            break;
          }
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          warn(relative, 'symbolic link or junction');
          continue;
        }
        const exclusionReason = this.#exclusionReason(relative, entry.isDirectory());
        if (exclusionReason) {
          warn(relative, exclusionReason);
          continue;
        }
        if (entry.isDirectory()) {
          directoryCount++;
          if (directoryCount > this.limits.maxDirectories) {
            warn(relative, `directory count limit reached (${this.limits.maxDirectories})`);
            stopped = true;
            break;
          }
          if (depth + 1 > this.limits.maxDepth) {
            warn(relative, `maximum directory depth exceeded (${this.limits.maxDepth})`);
            continue;
          }
          await visit(absolute, relative, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          warn(relative, 'not a regular file');
          continue;
        }
        let buffer;
        try { buffer = await readStableFile(absolute,workspace); }
        catch { warn(relative, 'file changed or could not be read safely'); continue; }
        if (buffer.byteLength > MAX_FILE_BYTES) {
          warn(relative, `file exceeds per-file limit (${MAX_FILE_BYTES} bytes)`);
          continue;
        }
        if (total + buffer.byteLength > MAX_TOTAL_BYTES) {
          warn(relative, `task byte limit reached (${MAX_TOTAL_BYTES} bytes)`);
          continue;
        }
        if (Date.now() - startedAt >= this.limits.maxElapsedMs) {
          warn(relative, `collection time limit reached (${this.limits.maxElapsedMs} ms)`);
          stopped = true;
          break;
        }
        let text = '';
        const extension = path.extname(relative).toLowerCase();
        try {
          if (DOCUMENT_EXTENSIONS.has(extension)) {
            await this.#assertArchiveRoot();
            const extractionRoot=await mkdtemp(path.join(this.root,'.extract-'));
            try {
              const snapshot=path.join(extractionRoot,'document'+extension);
              await writeFile(snapshot,buffer,{flag:'wx'});
              text=await extractDocumentText(snapshot,{pythonCommand:this.pythonCommand});
            } finally { await rm(extractionRoot,{recursive:true,force:true}); }
          }
          else if (!buffer.includes(0)) text = decoder.decode(buffer);
        } catch (error) {
          warn(relative, `document text extraction failed (${String(error?.message || 'unknown error').slice(0, 180)})`);
        }
        if (SECRET_CONTENT.test(text)) {
          warn(relative, 'credential-like content');
          continue;
        }
        total += buffer.byteLength;
        const record = await this.#addRecord({
          taskId, name: path.basename(relative), sourcePath: absolute, buffer,
          text, category: sourceCategory(relative), createdAt,
        });
        if (record) found.push(record);
      }
    };

    await visit(workspace);
    // Empty runs are normal for conversational or verification tasks. Do not
    // manufacture a zero-file summary artifact: it creates archive chatter and
    // can be mistaken for new material by the automatic librarian.
    if (found.length === 0) {
      Object.defineProperty(found, 'warnings', { value: warnings, enumerable: false });
      if (omittedWarnings) Object.defineProperty(found, 'omittedWarnings', { value: omittedWarnings, enumerable: false });
      return found;
    }
    const summary = this.#summary(String(taskId), found, createdAt, warnings, omittedWarnings);
    const summaryBytes = Buffer.from(summary, 'utf8');
    const summaryRecord = await this.#addRecord({
      taskId, name: `task-${String(taskId)}.md`,
      sourcePath: `generated://task/${encodeURIComponent(String(taskId))}/summary.md`,
      buffer: summaryBytes, text: summary, category: 'report', createdAt,
    });
    if (summaryRecord) found.push(summaryRecord);
    Object.defineProperty(found, 'warnings', { value: warnings, enumerable: false });
    if (omittedWarnings) Object.defineProperty(found, 'omittedWarnings', { value: omittedWarnings, enumerable: false });
    return found;
  }

  #summary(taskId, records, createdAt, warnings = [], omittedWarnings = 0) {
    const lines = [
      `# Task ${taskId} archive summary`, '',
      `Collected: ${createdAt}`, '',
      `Archived files: ${records.length}`, '',
      '| File | Category | Size | SHA-256 | Source |',
      '| --- | --- | ---: | --- | --- |',
    ];
    for (const row of records) {
      lines.push(`| ${markdownCell(row.name)} | ${markdownCell(row.category)} | ${row.size} | ${row.hash} | ${markdownCell(row.sourcePath)} |`);
    }
    if (warnings.length || omittedWarnings) {
      lines.push('', '## Skipped files and limits', '');
      for (const warning of warnings) lines.push(`- ${markdownCell(warning.path)} — ${markdownCell(warning.reason)}`);
      if (omittedWarnings) lines.push(`- ${omittedWarnings} additional warnings omitted`);
    }
    lines.push('');
    return lines.join('\n');
  }

  async search(query) {
    await this._ready;
    const term = String(query ?? '').trim();
    if (!term) return [];
    return this.selectSearch.all(term, term, term).map((row) => this.#record(row));
  }

  async list({ taskId, includeText = false, maxTextLength = 12000 } = {}) {
    await this._ready;
    const rows = taskId === undefined || taskId === null
      ? this.selectAll.all()
      : this.selectTask.all(String(taskId));
    return rows.map((row) => this.#record(row,{includeText,maxTextLength}));
  }

  async get(id) {
    await this._ready;
    return this.#record(this.selectId.get(String(id)),{includeText:true});
  }

  async resolveFile(id) {
    const root = await this.#assertArchiveRoot();
    const record = await this.get(id);
    if (!record) return null;
    const candidate = path.resolve(this.root, record.path);
    if (!within(root, candidate)) throw new Error('Archived file path is outside the archive root');
    const actual = await realpath(candidate);
    await this.#assertArchiveRoot();
    if (!within(root, actual)) throw new Error('Archived file resolves outside the archive root');
    const info = await stat(actual);
    if (!info.isFile()) throw new Error('Archived artifact is not a regular file');
    const hash = createHash('sha256').update(await readFile(actual)).digest('hex');
    if (hash !== record.hash) throw new Error('Archived artifact failed its SHA-256 integrity check');
    return actual;
  }
}
