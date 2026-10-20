import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(directory, prefix='', pattern=/\.(?:mjs|js|cjs|html|css|ps1|sh|json)$/u) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const relativePath=prefix?`${prefix}/${entry.name}`:entry.name;
    const absolutePath=join(directory,entry.name);
    if(entry.isDirectory())return sourceFiles(absolutePath,relativePath,pattern);
    return entry.isFile() && pattern.test(entry.name)?[{relativePath,absolutePath}]:[];
  });
}

// Capture once during process creation. Later disk edits do not change the
// identity this process reports as its loaded release.
export function captureReleaseIdentity(root, startedAt = new Date().toISOString()) {
  const hash = createHash('sha256');
  const sources=['src','public','scripts','plugins','patches'].flatMap(directory=>{
    const absolutePath=join(root,directory);
    return existsSync(absolutePath)?sourceFiles(absolutePath,directory):[];
  });
  const manifest=[join(root,'package.json'),join(root,'package-lock.json')]
    .filter(absolutePath=>existsSync(absolutePath))
    .map(absolutePath=>({relativePath:absolutePath.slice(root.length+1).replaceAll('\\','/'),absolutePath}));
  for (const source of [...manifest,...sources].sort((a,b)=>a.relativePath.localeCompare(b.relativePath))) {
    hash.update(source.relativePath).update('\0').update(readFileSync(source.absolutePath)).update('\0');
  }
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || version; } catch {}
  const sourceFingerprint = hash.digest('hex');
  return Object.freeze({ releaseId: `${version}+${sourceFingerprint.slice(0, 12)}`, startedAt, sourceFingerprint });
}

// A direct DSH bridge is a persistent connection, not active center-owned
// work. Pending approvals and all other tasks still block reload.
export function reloadBlockers(store, computerActions = []) {
  const tasks = store.db.prepare("SELECT id,status FROM tasks WHERE role!='direct' AND status IN ('queued','running','waiting') ORDER BY createdAt").all();
  const approvals = store.db.prepare("SELECT id,taskId FROM approvals WHERE status IN ('pending','resolving') ORDER BY createdAt").all();
  return { tasks, approvals, computerActions };
}
