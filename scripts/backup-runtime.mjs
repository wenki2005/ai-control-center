import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createRuntimeBackup, restoreRuntimeBackup, verifyRuntimeBackup } from '../src/runtime-backup.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=path.join(projectRoot,'runtime');
const [command,...args]=process.argv.slice(2);

try {
  if(command==='create') {
    const configPath=path.join(runtimeRoot,'config.json');
    const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
    if(config.directorProjectPath!==undefined&&(typeof config.directorProjectPath!=='string'||!path.isAbsolute(config.directorProjectPath)))throw Error('主管项目路径配置无效，已停止备份');
    const companionRoot=config.directorProjectPath||null;
    const backup=await createRuntimeBackup({runtimeRoot,companionRoot});
    console.log(JSON.stringify({path:backup.path,createdAt:backup.manifest.createdAt,artifactCount:backup.manifest.verification.artifactCount,archiveFileCount:backup.manifest.archive.fileCount,companionDocumentCount:backup.manifest.companionDocuments.length}));
  } else if(command==='verify' && args.length===1) {
    console.log(JSON.stringify(await verifyRuntimeBackup(path.resolve(args[0]))));
  } else if(command==='restore' && args.length===2) {
    console.log(JSON.stringify(await restoreRuntimeBackup({snapshotPath:path.resolve(args[0]),targetRoot:path.resolve(args[1])})));
  } else {
    throw Error('用法：node scripts/backup-runtime.mjs create | verify <snapshot> | restore <snapshot> <new-target-directory>');
  }
} catch(error) {
  console.error(String(error?.message||'备份操作失败').slice(0,500));
  process.exitCode=1;
}
