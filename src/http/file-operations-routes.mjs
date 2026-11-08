import path from 'node:path';

const within = (base, target) => { const rel = path.relative(base, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
const statusFor = error => error?.status || (/Unknown file operation plan/i.test(error?.message || '') ? 404 : /(?:already exists|changed|reconciliation|running|cancelled)/i.test(error?.message || '') ? 409 : 400);
const safeError = error => String(error?.message || '文件操作请求失败').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 240);

/** Returns a handler; server wiring remains with the caller. `runtimeRoot` is required. */
export function createFileOperationsRoutes({ operations, body, json, runtimeRoot = process.cwd() } = {}) {
  if (!operations || typeof operations.preview !== 'function' || typeof operations.status !== 'function') throw new TypeError('file operations service is required');
  if (typeof body !== 'function' || typeof json !== 'function') throw new TypeError('body and json helpers are required');
  const runtime = path.resolve(runtimeRoot);
  const roots = (operations.allowedRoots || []).map(x => path.resolve(x)).filter(x => within(runtime, x));
  const allowedRoot = root => typeof root === 'string' && path.isAbsolute(root) && roots.some(x => within(x, path.resolve(root)));
  const respondError = (res, error) => json(res, statusFor(error), { error: safeError(error) });
  return async function fileOperationsRoute(req, res, url) {
    const pathname = url instanceof URL ? url.pathname : String(url?.pathname || '');
    try {
      if (pathname === '/api/file-operations' && req.method === 'GET') {
        return json(res, 200, { allowedRoots: roots, security: { mutationScope: 'existing-files-and-directories-within-explicit-root', symlinks: 'rejected', destinationOverwrite: false, crossVolume: 'unsupported', atomicPathGuard: false, limitation: 'Node path-based filesystem calls cannot pin directory handles; root, parent identities and file paths are rechecked, but hostile concurrent replacement between check and mutation remains a platform race.' }, capabilities: { preview: true, commit: true, cancelUnexecutedPreview: true, undo: true, reconcile: true, dedupeReportOnly: true, delete: false, crossVolumeMove: false, nestedMutation: true, atomicPathGuard: false } });
      }
      if (pathname === '/api/file-operations/preview' && req.method === 'POST') {
        const input = await body(req);
        if (!allowedRoot(input?.root)) return json(res, 400, { error: '请选择配置范围内的绝对目录' });
        const result = await operations.preview({ root: input.root, operations: input.operations, dedupe: input.dedupe === true });
        return json(res, 200, result);
      }
      const match = /^\/api\/file-operations\/([a-f0-9-]{36})(?:\/(commit|undo|reconcile|cancel))?$/.exec(pathname);
      if (!match) return false;
      const [, id, action] = match;
      const status = operations.status(id);
      if (!allowedRoot(status.root)) return json(res, 404, { error: '操作记录不存在' });
      if (!action && req.method === 'GET') {
        const { id: planId, status: planStatus, createdAt, updatedAt, items } = status;
        return json(res, 200, { id: planId, status: planStatus, createdAt, updatedAt, security: status.security, items: items.map(({ item, kind, source, destination, hash, size, status: itemStatus, error }) => ({ item, kind, source, destination, hash, size, status: itemStatus, error })) });
      }
      if (action && req.method === 'POST') {
        const input = await body(req);
        if (input?.confirmed !== true) return json(res, 400, { error: '此操作需要明确确认' });
        const result = action === 'commit' ? await operations.commit(id) : action === 'undo' ? await operations.undo(id) : action === 'cancel' ? operations.cancel(id) : await operations.reconcile(id);
        return json(res, 200, result);
      }
      return false;
    } catch (error) { return respondError(res, error); }
  };
}
