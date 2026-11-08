import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { CompanionSinging } from './companion-singing.mjs';
import { sendSinging } from './singing-delivery.mjs';
import { SingingEngine } from './singing-engine.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRoot = resolve(here, '..');
const MAX_BODY = 20 * 1024;

async function readBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>MAX_BODY)throw Object.assign(Error('请求内容不能超过20KB'),{status:413}); chunks.push(chunk); }
  if(!size)return {};
  try { const value=JSON.parse(Buffer.concat(chunks).toString('utf8')); if(!value||typeof value!=='object'||Array.isArray(value))throw Error(); return value; }
  catch { throw Object.assign(Error('请求内容必须是JSON对象'),{status:400}); }
}
function json(res,status,value) { const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body); }

export async function createSingingService({root=defaultRoot,port=9894,store:providedStore,singing:providedSinging}={}) {
  root=resolve(root); const runtime=join(root,'runtime'); let store=providedStore,singing=providedSinging,engine=null,ownsStore=false,ownsSinging=false;
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1'); const pathname=url.pathname;
      if(req.method==='GET'&&pathname==='/health')return json(res,200,{service:'ai-center-singing',status:'ready'});
      if(req.method==='GET'&&pathname==='/singing')return json(res,200,singing.status());
      if(req.method==='POST'&&(pathname==='/singing'||/^\/singing\/[^/]+\/send$/.test(pathname))){const origin=req.headers.origin;if(origin&&origin!=='http://127.0.0.1:3188')return json(res,403,{error:'请求来源不允许'});}
      if(req.method==='POST'&&pathname==='/singing'){
        const args=await readBody(req);const job=await singing.request(args);
        if(job?.id){const pending=singing.pending?.get(job.id);if(pending)void Promise.resolve(pending).then(()=>{if(singing.get(job.id)?.status==='completed')sendSinging({singing,store,id:job.id});}).catch(()=>{});}
        return json(res,202,job);
      }
      const match=/^\/singing\/([^/]+)(?:\/(send))?$/.exec(pathname);
      if(match&&req.method==='GET'&&!match[2]){const id=decodeURIComponent(match[1]),job=singing.get(id);if(!job)return json(res,404,{error:'找不到演唱任务'});const delivery=store?.db?.prepare("SELECT status FROM outbox WHERE dedupe=?")?.get('singing-audio:'+id)?.status||'not_sent';return json(res,200,{...job,delivery});}
      if(match&&req.method==='POST'&&match[2]){await readBody(req);const id=decodeURIComponent(match[1]);if(!singing.get(id))return json(res,404,{error:'找不到演唱任务'});return json(res,202,sendSinging({singing,store,id}));}
      return json(res,404,{error:'找不到接口'});
    } catch(error) { if(!res.headersSent)json(res,error.status||400,{error:String(error.message||error)}); }
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolveListen);});
  try {
    if(!store){store=new Store(join(runtime,'control.sqlite'));ownsStore=true;}
    if(!singing){const configFile=join(runtime,'singing.json');const config=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{};
      if(config.generator?.resident&&existsSync(config.generator.script)&&existsSync(config.generator.python)){
        const activeProfile=config.profiles?.find(p=>p.id===store.meta('qq:voice-profile'));
        engine=new SingingEngine({config:{...config.generator,warmReferences:activeProfile?.reference?[activeProfile.reference]:[]},root:join(runtime,'singing','engine')});
      }
      singing=new CompanionSinging({...config,originalEngine:engine,store,root:join(runtime,'singing'),runtimeRoot:join(runtime,'singing'),owner:'autonomous-singing'});ownsSinging=true;
    }
  } catch(error) { await new Promise(resolveClose=>server.close(resolveClose));if(ownsStore)store?.close?.();throw error; }
  return {server,store,singing,port:server.address().port,close:async()=>{await new Promise(resolveClose=>server.close(resolveClose));if(ownsSinging)await singing.close();if(engine)await engine.close();if(ownsStore)store.close();}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try { const service=await createSingingService();process.on('SIGINT',()=>void service.close().then(()=>process.exit(0)));process.on('SIGTERM',()=>void service.close().then(()=>process.exit(0))); }
  catch(error){const log=join(defaultRoot,'runtime','singing-service.log');mkdirSync(join(defaultRoot,'runtime'),{recursive:true});appendFileSync(log,`${new Date().toISOString()} ${String(error.message||error)}\n`);process.exitCode=1;}
}
