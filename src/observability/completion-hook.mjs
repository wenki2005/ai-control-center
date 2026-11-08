import { mkdirSync,writeFileSync,renameSync,existsSync,readFileSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { join,resolve } from 'node:path';
import { redact } from '../redact.mjs';

export function queueAgentCompletion(root,input){
  const dir=resolve(root);mkdirSync(dir,{recursive:true});
  const value={...input,title:String(redact(input.title||'')).slice(0,180),request:String(redact(input.request||'')).slice(0,1400),result:String(redact(input.result||'')).slice(0,5000),error:String(redact(input.error||'')).slice(0,800)};
  const key=createHash('sha256').update(`${value.engine}\0${value.sessionId}\0${value.turnId}`).digest('hex');
  const destination=join(dir,key+'.json');if(existsSync(destination))return;
  const temp=join(dir,`${key}.${randomUUID()}.tmp`);writeFileSync(temp,JSON.stringify(value),{flag:'wx'});renameSync(temp,destination);
}

const textOf=data=>{const value=data?.message?.content??data?.content??data?.text??'';return typeof value==='string'?value:Array.isArray(value)?value.filter(x=>x?.type==='text').map(x=>x.text||'').join(''):'';};

// Session events are emitted after append, including a genuine terminal reason.
// No compressed histories are decompressed, polled or modified.
export function installDshCompletionHook(ctx,{root}){
  mkdirSync(root,{recursive:true});const sourceFile=join(root,'dsh-source-status.json'),instance=randomUUID();
  writeFileSync(sourceFile,JSON.stringify({active:true,pid:process.pid,instance,installedAt:new Date().toISOString()}));
  ctx.effect?.(()=>()=>{try{const state=JSON.parse(readFileSync(sourceFile,'utf8'));if(state.instance===instance)writeFileSync(sourceFile,JSON.stringify({...state,active:false}));}catch{}});
  ctx.on('session/event',(session,event)=>{
    if(event?.type!=='turn/end')return;
    const kind=event.data?.reason?.kind;if(!['completed','error','blocked','aborted','interrupted'].includes(kind))return;
    const turn=event.data?.turn;let request='',result='',title='';
    const events=session.snapshotEvents();let seenStart=false;
    for(let i=events.length-1,n=0;i>=0&&n++<3000;i--){const e=events[i];
      if(!title&&e.type==='session/title')title=e.data?.title||'';
      if(!result&&e.type==='assistant/message'&&!seenStart)result=textOf(e.data);
      if(e.type==='turn/start'&&e.data?.turn===turn)seenStart=true;
      if(e.type==='user/message'&&!request&&(e.data?.turn===turn||seenStart))request=textOf(e.data);
      if(request&&title)break;
    }
    queueAgentCompletion(root,{engine:'dsh',sessionId:String(session.id||session.header?.id||''),turnId:String(turn??event.seq),
      title,request,result,cwd:session.header?.cwd||'',status:kind==='completed'?'completed':['aborted','interrupted'].includes(kind)?'cancelled':'failed',
      error:kind==='completed'?'':String(event.data?.reason?.error?.message||kind),finishedAt:new Date(event.time||Date.now()).toISOString(),terminal:'dsh.turn/end'});
  });
}
