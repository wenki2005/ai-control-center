import {createHash} from 'node:crypto';
import {readFile,rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

// A completed temporary blob can be retried safely: its content is immutable,
// and an existing destination is accepted only after an integrity check.
export async function publishArchiveBlob({source,destination,hash,renameFile=rename,read=readFile,wait=delay,validate=async()=>{}}) {
  const retryable=new Set(['EPERM','EACCES','EBUSY','EEXIST']);
  const delays=[50,100,200,400];
  for(let attempt=0;;attempt++) {
    await validate();
    try { await renameFile(source,destination); return; }
    catch(error) {
      if(!retryable.has(error.code))throw error;
      let existing;
      try { existing=await read(destination); }
      catch(readError) { if(!['ENOENT','EPERM','EACCES','EBUSY'].includes(readError.code))throw readError; }
      if(existing) {
        if(createHash('sha256').update(existing).digest('hex')===hash)return;
        throw new Error('Existing archive blob failed its SHA-256 integrity check');
      }
      if(attempt>=delays.length)throw error;
      await wait(delays[attempt]);
    }
  }
}
