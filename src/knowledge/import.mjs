import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISUAL_IMAGE_EXTENSIONS } from './document-reader.mjs';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_DEPTH = 8;
const MAX_ELAPSED_MS = 30_000;
const MAX_WARNINGS = 1000;
const MAX_DIRECTORIES = 2000;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'cache', '.cache', 'build', 'dist', 'out', 'coverage', 'venv', '.venv', '__pycache__']);
const ALLOWED = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.docx', '.pdf', '.xlsx', '.pptx', '.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const SECRET_NAME = /(^|[._-])(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|config|settings|auth|credential|credentials|secret|secrets|token|private[-_.]?key|id_rsa|id_ed25519)(?=$|[._-])/i;
const SECRET_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:_authToken|_password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|authorization)\s*[:=]\s*["']?[^\s"']+/i;
const EXTRACTOR = fileURLToPath(new URL('./extract.py', import.meta.url));

const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const same = (a, b) => within(a, b) && within(b, a);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export class LibraryImport {
  constructor({ store, archive, workspaceRoot, extractor, pythonCommand } = {}) {
    const db = store?.db ?? store;
    if (!db?.exec || !db?.prepare) throw new TypeError('LibraryImport requires a node:sqlite DatabaseSync instance or Store as store');
    if (!archive?.collect) throw new TypeError('LibraryImport requires an Archive instance');
    if (!workspaceRoot) throw new TypeError('LibraryImport requires workspaceRoot');
    this.store = db;
    this.archive = archive;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.extractor = extractor;
    this.pythonCommand = pythonCommand ?? 'python';
    this.store.exec(`
      CREATE TABLE IF NOT EXISTS library_imports (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_directory TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed','partial','failed')),
        file_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_sources (
        artifact_id TEXT NOT NULL, source_directory TEXT NOT NULL, original_path TEXT NOT NULL,
        relative_path TEXT NOT NULL, import_id TEXT NOT NULL, hash TEXT NOT NULL,
        extraction_status TEXT NOT NULL DEFAULT 'indexed', extraction_error TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY(artifact_id, original_path, hash)
      );
      CREATE INDEX IF NOT EXISTS library_sources_origin_idx ON library_sources(original_path, hash);
      CREATE INDEX IF NOT EXISTS library_sources_import_idx ON library_sources(import_id);
    `);
    this.findSource = this.store.prepare('SELECT artifact_id, hash FROM library_sources WHERE original_path = ? AND hash = ? ORDER BY created_at DESC LIMIT 1');
    this.findArtifact = this.store.prepare('SELECT id, task_id AS taskId, name, path, source_path AS sourcePath, hash, size, category, created_at AS createdAt, excerpt FROM artifacts WHERE id = ?');
    const importColumns = new Set(this.store.prepare('PRAGMA table_info(library_imports)').all().map((column) => column.name));
    if (!importColumns.has('warnings_json')) this.store.exec("ALTER TABLE library_imports ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]'");
    this.insertImport = this.store.prepare('INSERT INTO library_imports (id, task_id, source_directory, status, file_count, warning_count, warnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const columns = new Set(this.store.prepare('PRAGMA table_info(library_sources)').all().map((column) => column.name));
    if (!columns.has('extraction_status')) this.store.exec("ALTER TABLE library_sources ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'indexed'");
    if (!columns.has('extraction_error')) this.store.exec('ALTER TABLE library_sources ADD COLUMN extraction_error TEXT');
    this.insertSource = this.store.prepare('INSERT OR IGNORE INTO library_sources (artifact_id, source_directory, original_path, relative_path, import_id, hash, extraction_status, extraction_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.updateArtifactText = this.store.prepare('UPDATE artifacts SET text_content = ?, excerpt = ? WHERE id = ?');
  }

  async #rejectLinks(absolute) {
    const root = path.parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let info;
      try { info = await lstat(current); } catch (e) { if (e.code === 'ENOENT') throw new Error('Import directory does not exist'); throw e; }
      if (info.isSymbolicLink()) throw new Error('Import directory path contains a symlink or junction');
    }
  }

  async #validateDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('directory must be an absolute path');
    const requested = path.resolve(directory);
    const parsed = path.parse(requested);
    if (same(requested, parsed.root)) throw new Error('Drive roots cannot be imported');
    await this.#rejectLinks(requested);
    const physical = await realpath(requested);
    if (!same(requested, physical)) throw new Error('Import directory resolves through a symlink or junction');
    const st = await lstat(physical);
    if (!st.isDirectory()) throw new Error('Import source must be a directory');
    const home = path.resolve(os.homedir());
    if (same(physical, home)) throw new Error('The user home root cannot be imported');
    const parts = physical.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
    if (parts.some((p) => ['appdata', '.codex', '.codebuddy', '.workbuddy', '.ssh', '.aws', '.kube', '.docker', 'program files', 'program files (x86)', 'windows'].includes(p))) {
      throw new Error('Windows, application data, credential, and assistant directories cannot be imported');
    }
    if (/^[a-z]:$/i.test(parts[0] ?? '') && parts.length < 2) throw new Error('Drive roots cannot be imported');
    const normalized = physical.replaceAll('\\', '/').toLowerCase();
    if (/(^|\/)runtime(\/|$)/i.test(normalized)) throw new Error('Project runtime directories cannot be imported');
    return physical;
  }

  async #readStable(file, root) {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('not a regular file');
    const realBefore = await realpath(file);
    if (!within(root, realBefore) || !same(file, realBefore)) throw new Error('file path changed or escaped source directory');
    if (before.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
    const buffer = await readFile(file);
    const after = await lstat(file);
    const realAfter = await realpath(file);
    if (!within(root, realAfter) || !same(file, realAfter) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || buffer.byteLength !== after.size) {
      throw new Error('file changed while being read');
    }
    return buffer;
  }

  async #extract(file, ext) {
    if (this.extractor) return await this.extractor({ file, ext });
    if (!['.docx', '.xlsx', '.pptx', '.pdf', '.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'].includes(ext)) return null;
    let command = this.pythonCommand;
    try { await access(command, constants.X_OK); } catch { command = 'python'; }
    return new Promise((resolve, reject) => {
      const child = spawn(command, [EXTRACTOR], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let output = '';
      let settled = false;
      const timer = setTimeout(() => { child.kill(); finish(new Error('document text extraction timed out')); }, 120_000);
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 2_000_000) { child.kill(); finish(new Error('document text extraction output exceeded limit')); } });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (code !== 0) return finish(new Error('document text extraction failed'));
        try {
          const result = JSON.parse(output);
          if (result.status !== 'ok' || typeof result.text !== 'string') return finish(new Error(result.error || 'document text extraction failed'));
          finish(null, result.text);
        } catch { finish(new Error('document text extraction returned invalid output')); }
      });
      child.stdin.end(JSON.stringify({ path: file }));
    });
  }

  async importDirectory({ directory, recursive = true, maxFiles = MAX_FILES } = {}) {
    const source = await this.#validateDirectory(directory);
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('maxFiles must be a positive integer');
    const cap = Math.min(maxFiles, MAX_FILES);
    const id = randomUUID();
    const taskId = `import-${id}`;
    const now = new Date().toISOString();
    const destination = path.join(this.workspaceRoot, '_imports', id, 'files');
    await mkdir(destination, { recursive: true });
    const importRoot = await realpath(destination);
    if (!within(this.workspaceRoot, importRoot)) throw new Error('Import workspace resolves outside workspaceRoot');
    const warnings = [];
    const selected = [];
    let totalBytes = 0;
    const started = Date.now();
    let visitedDirectories = 0;
    let omittedWarnings = 0;
    let stopped = false;
    const warn = (filePath, reason) => {
      if (warnings.length < MAX_WARNINGS) warnings.push({ path: filePath || '.', reason });
      else omittedWarnings++;
    };
    const walk = async (dir, rel = '', depth = 0) => {
      if (stopped) return;
      if (Date.now() - started >= MAX_ELAPSED_MS) { warn(rel, `30 second import time limit reached (${MAX_ELAPSED_MS} ms)`); stopped = true; return; }
      visitedDirectories++;
      if (visitedDirectories > MAX_DIRECTORIES) { warn(rel, `directory count limit reached (${MAX_DIRECTORIES})`); stopped = true; return; }
      const handle = await opendir(dir);
      for await (const entry of handle) {
        if (stopped) break;
        const relative = rel ? path.join(rel, entry.name) : entry.name;
        if (Date.now() - started >= MAX_ELAPSED_MS) { warn(relative, `30 second import time limit reached (${MAX_ELAPSED_MS} ms)`); stopped = true; break; }
        if (entry.isSymbolicLink()) { warn(relative, 'symlink or junction skipped'); continue; }
        if (entry.name.startsWith('.') || SECRET_NAME.test(entry.name)) { warn(relative, 'hidden, configuration, or credential path skipped'); continue; }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) { warn(relative, 'dependency, build, or cache directory skipped'); continue; }
          if (!recursive) continue;
          if (depth + 1 > MAX_DEPTH) { warn(relative, `maximum directory depth exceeded (${MAX_DEPTH})`); continue; }
          await walk(full, relative, depth + 1);
          continue;
        }
        if (!entry.isFile()) { warn(relative, 'not a regular file'); continue; }
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED.has(ext)) { warn(relative, 'unsupported file type'); continue; }
        if (selected.length >= cap) { warn(relative, `file count limit reached (${cap})`); stopped = true; break; }
        let buffer;
        try { buffer = await this.#readStable(full, source); } catch (error) { warn(relative, error.message); continue; }
        if (totalBytes + buffer.byteLength > MAX_TOTAL_BYTES) { warn(relative, `total import size limit reached (${MAX_TOTAL_BYTES} bytes)`); continue; }
        totalBytes += buffer.byteLength;
        const hash = sha(buffer);
        const duplicate = this.findSource.get(full, hash);
        if (duplicate) {
          const row = this.findArtifact.get(duplicate.artifact_id);
          if (row) { selected.push({ relative, original: full, hash, reused: row }); continue; }
        }
        const copy = path.join(destination, relative);
        await mkdir(path.dirname(copy), { recursive: true });
        await writeFile(copy, buffer, { flag: 'wx' });
        let text = '';
        let extractionStatus = 'failed';
        let extractionError = null;
        if (['.txt', '.md', '.markdown', '.csv', '.json'].includes(ext)) {
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); extractionStatus = 'indexed'; }
          catch { extractionError = 'invalid UTF-8'; warn(relative, 'invalid UTF-8; retained as a file without full-text indexing'); }
        } else if (VISUAL_IMAGE_EXTENSIONS.has(ext)) {
          extractionStatus = 'visual';
        } else {
          try {
            text = String(await this.#extract(copy, ext) ?? '');
            if (!text.trim() && ext === '.pdf') extractionStatus = 'visual';
            else if (!text.trim()) throw new Error('no extractable text');
            else extractionStatus = 'extracted';
          } catch (error) {
            extractionError = error.message || 'document text extraction failed';
            warn(relative, `text extraction failed; file retained without full-text indexing (${extractionError})`);
          }
        }
        if (SECRET_CONTENT.test(text)) {
          warn(relative, 'credential-like content skipped');
          await rm(copy, { force: true });
          continue;
        }
        selected.push({ relative, original: full, hash, copied: copy, text, extractionStatus, extractionError });
      }
    };

    try {
      await walk(source);
      const archiveRows = await this.archive.collect({ taskId, cwd: path.dirname(destination) });
      const bySource = new Map(archiveRows.map((record) => [path.resolve(record.sourcePath), record]));
      const artifacts = [];
      for (const file of selected) {
        let record = file.reused;
        if (!record) {
          record = bySource.get(path.resolve(file.copied));
          if (!record || record.hash !== file.hash) {
            warnings.push({ path: file.relative, reason: 'archived file could not be matched to its source hash' });
            continue;
          }
        }
        if (file.text) {
          const excerpt = file.text.replace(/\s+/g, ' ').trim().slice(0, 320);
          this.updateArtifactText.run(file.text, excerpt, record.id);
          record.excerpt = excerpt;
        }
        artifacts.push(record);
        if (!file.reused) {
          this.insertSource.run(record.id, source, file.original, file.relative, id, file.hash, file.extractionStatus, file.extractionError, now);
        }
      }
      const status = warnings.length || omittedWarnings ? (artifacts.length ? 'partial' : 'failed') : 'completed';
      const warningCount = warnings.length + omittedWarnings;
      if (omittedWarnings) {
        const summary = { path: '.', reason: `${omittedWarnings} additional warnings omitted` };
        if (warnings.length >= MAX_WARNINGS) warnings[MAX_WARNINGS - 1] = summary;
        else warnings.push(summary);
      }
      this.insertImport.run(id, taskId, source, status, artifacts.length, warningCount, JSON.stringify(warnings), now);
      return { id, taskId, artifacts, warnings, sourceDirectory: source };
    } catch (error) {
      const failure = { path: '.', reason: String(error?.message ?? 'import failed').slice(0, 500) };
      if (warnings.length < MAX_WARNINGS) warnings.push(failure);
      this.insertImport.run(id, taskId, source, 'failed', 0, warnings.length + omittedWarnings, JSON.stringify(warnings), now);
      throw error;
    }
  }
}
