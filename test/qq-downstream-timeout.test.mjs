import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QqBridge} from '../src/qq.mjs';
import {localHttpFetch} from './helpers/local-http-fetch.mjs';

test('OneBot HTTP 200 downstream timeout is ambiguous, a genuine rejection is not',async()=>{
 const root=mkdtempSync(join(tmpdir(),'qq-timeout-'));let message='send reply 8135 timed out after 15000 ms';
 const server=createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'failed',retcode:1200,message}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const originalFetch=globalThis.fetch;globalThis.fetch=localHttpFetch;
 try{
  const configFile=join(root,'qq.json');writeFileSync(configFile,JSON.stringify({owner:'123',snowluma:{httpUrl:`http://127.0.0.1:${server.address().port}`}}));
  const call=()=>QqBridge.prototype.call.call({configFile},'send_private_msg',{user_id:123,message:'test'});
  await assert.rejects(call(),error=>error.uncertain===true);
  message='permission denied';await assert.rejects(call(),error=>error.uncertain===false);
 }finally{globalThis.fetch=originalFetch;await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});
