import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {canDetachDshTask} from './dsh-reload.mjs';

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
// work. Accepted DSH turns run independently and can be followed after reload.
export function reloadBlockers(store, computerActions = []) {
  const active=store.db.prepare("SELECT * FROM tasks WHERE role!='direct' AND status IN ('queued','running','waiting') ORDER BY createdAt").all();
  const tasks=active.filter(task=>!canDetachDshTask(store,task)).map(({id,status})=>({id,status}));
  const continuingDshTasks=active.filter(task=>canDetachDshTask(store,task)).length;
  const approvals = store.db.prepare("SELECT id,taskId FROM approvals WHERE status IN ('pending','resolving') ORDER BY createdAt").all();
  return { tasks, approvals, computerActions,continuingDshTasks };
}

// Manual and background reloads must observe the same live activity boundary.
// Only actual activity blocks reload: connected bridges and idle engines do not.
export function reloadActivity(store, services = {}) {
  const computerActions=(services.computerBroker?.list()||[]).filter(action=>
    ['awaiting_approval','approved','running','verification_required','uncertain'].includes(action.status));
  const {tasks,approvals,continuingDshTasks}=reloadBlockers(store,computerActions);
  const blockers={tasks:tasks.length,approvals:approvals.length,computerActions:computerActions.length};
  for(const name of ['proactive','news','diary','dailyReview'])blockers[name]=services[name]?.running?1:0;
  const remote=services.remoteCompanion?.activity();
  const extras={workPresence:services.workPresence?.running,singing:services.singing?.active,qqDelivery:services.qq?.flushing,gm:services.gm?.busy,
    screenSharing:services.screenCompanion?.state().active,screenAnalysis:services.screenCompanion?.running,
    remoteSharing:remote?.sharing,remoteAnalysis:remote?.analyzing,
    reports:services.reports?.busy||services.reports?.announcementFlights?.size||services.reports?.narrator?.pending?.size,
    drawing:services.drawings?.busy,localModelWork:services.localServices?.busy||services.localServices?.coordinator?.state().active.length||services.localServices?.coordinator?.state().queued,mail:services.mailMonitor?.busy,repairValidation:services.internalRepair?.validating};
  for(const [name,active] of Object.entries(extras))if(active)blockers[name]=1;
  return {busy:Object.values(blockers).some(Boolean),blockers,continuing:{dshTasks:continuingDshTasks}};
}
