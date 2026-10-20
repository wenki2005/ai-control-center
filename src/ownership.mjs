import {openSync,writeFileSync,readFileSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Claim ownership before recovery can modify tasks or sending notifications.
export function claimServer(runtime) {
  const path=join(runtime,'hub-owner.lock'),owner={pid:process.pid,id:randomUUID()};
  for(let attempt=0;attempt<2;attempt++) {
    let fd;
    try {fd=openSync(path,'wx');writeFileSync(fd,JSON.stringify(owner));closeSync(fd);break;}
    catch(error) {
      if(fd!==undefined)closeSync(fd);
      if(error.code!=='EEXIST')throw error;
      let previous;try{previous=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('中控所有权文件无效，保留现场等待检查');}
      if(!Number.isSafeInteger(previous.pid)||previous.pid<=0)throw Error('中控所有权记录无效');
      try {process.kill(previous.pid,0);throw Error('已有中控服务持有数据库，请复用正在运行的程序');}
      catch(check){if(check.code!=='ESRCH')throw check;}
      // Only this one verified stale lock file is removed, never any runtime tree.
      unlinkSync(path);
    }
  }
  if(JSON.parse(readFileSync(path,'utf8')).id!==owner.id)throw Error('中控所有权竞争，请稍后重试');
  return ()=>{try{if(JSON.parse(readFileSync(path,'utf8')).id===owner.id)unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}};
}
