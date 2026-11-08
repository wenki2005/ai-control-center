import {execFile} from 'node:child_process';import{promisify}from'node:util';
const run=promisify(execFile);
export async function sampleLocalGpu({execute=run,executable='nvidia-smi',now=Date.now}={}){
 const unknown=reason=>({usedBytes:null,totalBytes:null,utilizationPercent:null,source:'nvidia-smi',reason,observedAt:new Date(now()).toISOString()});
 try{
  const {stdout}=await execute(executable,['--id=0','--query-gpu=memory.total,memory.used,utilization.gpu','--format=csv,noheader,nounits'],{windowsHide:true,timeout:1800,maxBuffer:8192,encoding:'utf8'});
  const fields=stdout.trim().split(',').map(s=>s.trim());
  if(fields.length!==3||fields.some(s=>!/^\d+(?:\.\d+)?$/.test(s)))return unknown('unsupported-or-missing-metrics');
  const [total,used,utilizationPercent]=fields.map(Number);
  if(total<=0||used>total||utilizationPercent>100)return unknown('invalid-metrics');
  return {totalBytes:total*1048576,usedBytes:used*1048576,utilizationPercent,source:'nvidia-smi:gpu0',observedAt:new Date(now()).toISOString()};
 }catch(error){return unknown(error.code==='ENOENT'?'collector-unavailable':error.killed||error.code==='ETIMEDOUT'?'collector-timeout':'collector-failed');}
}

// Reuse the hub's existing no-new-text observation; this is not proof of a hung engine.
export function sampleLocalTaskStalls(store,{now=Date.now()}={}){
 const active=store.db.prepare("SELECT id,runVersion FROM tasks WHERE role='worker' AND status='running' ORDER BY createdAt LIMIT 100").all();
 const ages=active.map(task=>Number(store.meta(`worker-stall-since:${task.id}:${task.runVersion||0}`))).filter(value=>Number.isFinite(value)&&value>0&&value<=now).map(value=>now-value);
 return {source:'hub-worker-supervision:no-new-text',stalledCount:ages.length,oldestAgeMs:ages.length?Math.max(...ages):0,meaning:'observed lack of new text; engine hang not established',scannedTasks:active.length};
}
