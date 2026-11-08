// Cancel is not a successful task completion. DSH keeps inbox work by default,
// so remove only occurrences proven to belong to this adapter request.
export async function cancelDshTask({task,record,call,timeoutMs=8000}){
 const sessionId=record?.sessionId||task.sessionId;if(!sessionId)return{stopped:true,notStarted:true};
 const signal=AbortSignal.timeout(timeoutMs),ids=new Set([record?.followRequestId,task.followRequestId,...(record?.ownedRequestIds||[])].filter(Boolean));
 const marker=record?.followPromptMarker||task.followPromptMarker;
 let queueKnown=false,queueError=null,removedPending=0;
 try{
  const projection=await call('session/projections',{request:{sessionId}},signal);
  const inbox=projection?.values?.inbox;
  if(!record){
   const last=projection?.values?.turnOutline?.at(-1),prompt=String(last?.prompt||'');
   if(!marker&&!task.prompt||!(marker&&prompt.includes(marker))&&!(task.prompt&&prompt.includes(String(task.prompt))))throw Error('无法核实原任务是否仍占用此会话，未中断可能无关的工作');
  }
  if(inbox&&Array.isArray(inbox['next-turn'])&&Array.isArray(inbox['next-step'])){
   queueKnown=true;
   for(const entry of [...inbox['next-turn'],...inbox['next-step']]){
    const m=entry.message||entry.event?.data||entry,source=m.source||{},content=m.content||entry.content;
    const text=typeof content==='string'?content:Array.isArray(content)?content.filter(x=>x.type==='text').map(x=>x.text||'').join(''):'';
    if(!ids.has(source.rpcId)&&!(marker&&text.includes(marker)))continue;
    const itemId=entry.id||m.id;if(!itemId)throw Error('无法识别原任务待处理消息');
    try{await call('session/updateQueue',{request:{sessionId,itemId,action:{kind:'remove'}}},signal);removedPending++;}catch(error){if(!/queued item is no longer pending|queue-item-not-found/iu.test(error.message))throw error;}
   }
  }
 }catch(error){if(signal.aborted||!record)throw error;queueError=error;/* Still interrupt this known active execution. */}
 if(record?.terminal&&!record.busy){if(queueError||!queueKnown)throw Error('原回合已结束，但无法核实待处理队列');return{stopped:true,queueChecked:true,removedPending};}
 if(record)record.cancelRequested=true;
 try{await call('session/cancel',{request:{sessionId}},signal);}catch(error){
  if(!/not found \(not attached\)|session\/not-found/iu.test(error.message))throw error;
 }
 while(!signal.aborted){
  const list=await call('session/list',{_request:{}},signal);
  const state=list?.items?.find(row=>row.sessionId===sessionId);
  if(state?.running===false||(record?.terminal&&!record.busy)){if(!queueKnown||queueError)throw Error('当前执行已中断，但未能核实待处理队列；停止状态尚未完全确认');return{stopped:true,queueChecked:true,removedPending};}
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 throw Error('执行端未在限时内确认停止，已阻止中枢自动接续');
}
