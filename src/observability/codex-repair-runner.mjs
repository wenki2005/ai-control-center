import {createRequire} from 'node:module';
import {resolveCodexExecutable} from '../adapters/codex.mjs';
import {enqueueTaskEvent} from '../hub/event-chain.mjs';
const require=createRequire(import.meta.url);
const {CodexReadonly}=require('../../remote-client/codex-native.cjs');

export async function inspectRepairThread(threadId,{command}={}) {
  const client=new CodexReadonly({executable:()=>resolveCodexExecutable({command}),allowMessages:true,timeoutMs:10000});
  try{
    await client.connect();
    const snapshot=await client.send('thread/read',{threadId,includeTurns:false});
    const items=[];let cursor;
    do{const page=await client.send('thread/queue/list',{threadId,limit:100,...(cursor?{cursor}:{})});items.push(...(page.data||[]));cursor=page.nextCursor;if(cursor&&items.length>=500)return {status:'unknown'};}while(cursor);
    const turns=[];let turnCursor;
    do{const page=await client.send('thread/turns/list',{threadId,limit:20,sortDirection:'desc',itemsView:'summary',...(turnCursor?{cursor:turnCursor}:{})});turns.push(...(page.data||[]));turnCursor=page.nextCursor;}while(turnCursor&&turns.length<100);
    return {status:snapshot.thread?.status?.type||'unknown',turns,historyComplete:!turnCursor,queue:items.map(row=>({id:row.id,text:(row.input||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')}))};
  }finally{await client.close();}
}

// Uses the existing engine adapter: native model is retained, approvals follow
// the ordinary Hub UI, and success is based on its real terminal event.
export async function runRepairTurn(hub,threadId,prompt,{cwd}) {
  const repairId=/\[中控内部修复 ([a-f0-9]{24})\]/u.exec(prompt)?.[1];
  const attempt=Number(/\[修复轮次 (\d+)\]/u.exec(prompt)?.[1]||1);
  if(!repairId)throw Error('修复请求缺少稳定引用');
  const id=`t-repair-${repairId}-${attempt}`;
  const prior=hub.store.task(id);
  if(prior&&['running','waiting'].includes(prior.status))return;
  const task=prior||hub.store.createTask({id,engine:'codex',role:'maintenance',sessionId:threadId,prompt,cwd});
  hub.store.update(id,{status:'running',error:null,runVersion:(task.runVersion||0)+1});
  hub.store.event(id,'internal-repair.execution-started',{repairId,attempt});
  let settled=false;
  const onEvent=event=>{
    enqueueTaskEvent(hub,id,async()=>{
      if(settled||!['running','waiting'].includes(hub.store.task(id)?.status))return;
      if(event.type==='approval'){await hub.handle(id,event);return;}
      if(event.type==='session'){hub.store.update(id,{sessionId:event.sessionId});hub.store.event(id,'session',event);}
      if(event.type==='progress')hub.store.event(id,'internal-repair.progress',event);
      if(event.type==='completed'||event.type==='failed'){
        settled=true;
        if(event.type==='failed'&&!event.nativeTurnId){
          hub.store.update(id,{status:'interrupted',error:event.error||'原生投递状态未确认'});
          hub.store.event(id,'internal-repair.execution-uncertain',event);
          hub.store.db.prepare("UPDATE internal_repairs SET status='delivery-uncertain',updatedAt=?,detail=? WHERE id=? AND status IN ('sending','accepted','delivery-uncertain')").run(hub.store.now(),event.error||'',repairId);hub.emit();return;
        }
        hub.store.update(id,{status:event.type==='completed'?'completed':'failed',result:event.text||null,error:event.error||null});
        hub.store.event(id,event.type,event);
        hub.internalRepair.receive({engine:'codex',sessionId:threadId,request:prompt,status:event.type==='completed'?'completed':'failed',result:event.text||'',error:event.error||''});
      }
      hub.emit();
    },error=>hub.store.event(id,'internal-repair.event-failed',{error:String(error.message).slice(0,500)}));
  };
  const retiredRepairIds=hub.store.db.prepare("SELECT id FROM internal_repairs WHERE status IN ('resolved','validated') ORDER BY updatedAt DESC LIMIT 500").all().map(row=>row.id);
  await hub.adapters.codex.start({...task,preserveNativeSession:true,nativeQueue:{clientUserMessageId:`repair-${repairId}-${attempt}`,retiredRepairIds}},onEvent);
}
