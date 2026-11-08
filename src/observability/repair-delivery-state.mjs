import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Reconcile against durable local turns, never infer non-delivery from age.
export async function repairDeliveryState(threadId,repairId,{stateFile=join(homedir(),'.codex','state_5.sqlite'),attempt=1,readNative=null}={}){
 const marker=`[中控内部修复 ${repairId}]`,matches=text=>String(text||'').includes(marker)&&Number(/\[修复轮次 (\d+)\]/u.exec(text)?.[1]||1)===attempt;
 if(readNative){
   let native;try{native=await readNative();}catch{return {state:'unknown'};}
   const queued=native.queue?.find(row=>matches(row.text));if(queued)return {state:'queued',request:queued.text};
   for(const turn of native.turns||[]){
     const request=(turn.items||[]).filter(item=>item.type==='userMessage').map(item=>(item.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')).find(matches);
     if(!request)continue;
     // A different app-server can label an actively owned turn interrupted.
     // Explicitly absent completion time is not a genuine terminal event.
     if(turn.status==='inProgress'||turn.completedAt===null)return {state:'running'};
     if(['completed','failed','interrupted'].includes(turn.status))return {state:'completed',engine:'codex',sessionId:threadId,request,status:turn.status==='completed'?'completed':'failed',result:(turn.items||[]).filter(item=>item.type==='agentMessage'&&item.phase==='final_answer').map(x=>x.text||'').join('\n'),error:turn.error?.message|| (turn.status==='interrupted'?'原生修复回合已中断':'')};
   }
   if(['active','running','busy','waitingForApproval'].includes(native.status))return {state:'running'};
   return {state:native.historyComplete&&['idle','notLoaded'].includes(native.status)?'not-found':'unknown'};
 }
 let db,file;
 try{db=new DatabaseSync(stateFile,{readOnly:true});file=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(threadId)?.rollout_path;}catch{return {state:'unknown'};}finally{db?.close();}
 if(!file)return {state:'unknown'};
 try{
  const before=await stat(file);
  let request='',matchingRequest='',found=false,active=null,final='',terminal=null;
  const stream=createReadStream(file),lines=createInterface({input:stream,crlfDelay:Infinity});
  try{for await(const line of lines){
   let r;try{r=JSON.parse(line);}catch{continue;}const p=r.payload||{};
   if(r.type==='event_msg'&&p.type==='task_started'){active=true;final='';}
   if(r.type==='event_msg'&&p.type==='user_message'||r.type==='response_item'&&p.type==='message'&&p.role==='user'){
    request=typeof p.message==='string'?p.message:typeof p.content==='string'?p.content:Array.isArray(p.content)?p.content.map(x=>x.text||'').join(''):'';
    if(matches(request)){found=true;matchingRequest=request;}
   }
   if(r.type==='response_item'&&p.type==='message'&&p.role==='assistant'&&p.phase==='final_answer')final=(p.content||[]).map(x=>x.text||'').join('');
   if(r.type==='event_msg'&&['task_complete','task_failed','turn_aborted'].includes(p.type)){
    active=false;
    if(matches(request))terminal={state:'completed',engine:'codex',sessionId:threadId,request,status:p.type==='task_complete'?'completed':'failed',result:p.last_agent_message||final,error:p.error?.message||p.reason||''};
   }
  }}finally{lines.close();stream.destroy();}
  const after=await stat(file);
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)return {state:'unknown'};
  if(terminal)return terminal;
  if(active===true)return {state:'running'};
  if(!found&&active===false)return {state:'not-found'};
  return {state:'unknown'};
 }catch{return {state:'unknown'};}
}
