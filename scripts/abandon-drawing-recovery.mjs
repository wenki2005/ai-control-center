// Explicit operator maintenance: record one confirmed recovery waiver, no service control.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ResourceRecovery,drawingRecoveryVersion} from '../src/lifecycle/resource-recovery.mjs';
const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
try{
  const apply=args.includes('--apply'),jobId=value('--job');if(!jobId)throw Error('--job requires an exact drawing ID');
  if(apply&&(!args.includes('--confirmed')||!value('--expected-version')||!value('--authorization-file')))throw Error('Apply requires --confirmed, --expected-version and --authorization-file');
  const database=value('--database')||resolve(dirname(fileURLToPath(import.meta.url)),'../runtime/control.sqlite');
  const db=new DatabaseSync(database,{readOnly:!apply,timeout:10000});
  try{
    const row=db.prepare('SELECT * FROM companion_drawings WHERE id=?').get(jobId);if(!row)throw Error('Drawing not found');
    if(!apply)console.log(JSON.stringify({jobId:row.id,status:row.status,remoteId:row.remoteId,updatedAt:row.updatedAt,version:drawingRecoveryVersion(row),mode:'preview-no-write'}));
    else{
      const recovery=new ResourceRecovery({db,now:()=>new Date().toISOString()});
      const authorization=JSON.parse(readFileSync(value('--authorization-file'),'utf8'));
      console.log(JSON.stringify({...recovery.abandonDrawing({jobId,expectedVersion:value('--expected-version'),confirmed:true,authorization}),mode:'durable-record-only',runningProcessBudgetReleased:false}));
    }
  }finally{db.close();}
}catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
