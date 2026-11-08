import { createHash } from 'node:crypto';
import { parseProtocolObject } from '../protocol/director-output.mjs';
import { buildWorkHandoff } from './work-handoff.mjs';
import {isRemoteRelayDispatch} from '../remote-supervisor.mjs';
import {dispatchConversationText} from '../dispatch-notice-policy.mjs';

export function supervisorDirective(text,marker) {
  const source=String(text||'');
  if(!source.includes(marker))return null;
  if(source.split(marker).length!==2)throw Error('主管同一轮重复输出了 '+marker);
  try{return parseProtocolObject(source,marker);}
  catch(error){if(error.message?.includes('重复'))throw error;return null;}
}

export function linkedSupervisorTask(hub,task) {
  const row=hub.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 1").get(task.id);
  try{return hub.store.task(JSON.parse(row?.data||'{}').workerId);}catch{return null;}
}

export function supervisorDispatches(text,{partial=false}={}){
 const source=String(text||''),out=[];let offset=0;
 while(true){const index=source.indexOf('[HUB-DISPATCH]',offset);if(index<0)break;
  try{const parsed=parseProtocolObject(source.slice(index),'[HUB-DISPATCH]');out.push({value:parsed.value,start:index,end:index+parsed.end});offset=index+parsed.end;}
  catch(error){if(partial)break;throw error;}
  if(out.length>8)throw Error('主管本轮派单目标过多，已停止新增目标');
 }
 return out;
}

export function stripSupervisorDispatches(text){
 let source=String(text||'');for(const item of supervisorDispatches(source).reverse())source=source.slice(0,item.start)+source.slice(item.end);return source.trim();
}

// A full, validated directive admits work. It is not an engine completion:
// only the worker's genuine terminal event can complete the execution task.
export async function publishSupervisorProgress(hub,task,text,{sibling=false}={}) {
  if(task.role!=='director'||/^\[(?:内部工作回报|前台回应)\]/u.test(task.prompt))return null;
  const priorAmend=hub.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.amended' ORDER BY id DESC LIMIT 1").get(task.id);
  if(String(text).includes('[HUB-DISPATCH]')&&priorAmend){
    if(!hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.dispatch-suppressed' LIMIT 1").get(task.id))hub.store.event(task.id,'director.dispatch-suppressed',{reason:'original-task-already-amended'});
    try{return hub.store.task(JSON.parse(priorAmend.data||'{}').workerId);}catch{return null;}
  }
  const amended=supervisorDirective(text,'[HUB-AMEND]');
  if(amended) {
    const value=amended.value;
    if(!value||Object.keys(value).some(key=>!['taskId','text','reply'].includes(key))||typeof value.taskId!=='string'||typeof value.text!=='string'||!value.text.trim()||value.text.length>20000)throw Error('原任务补充协议无效');
    const target=hub.store.task(value.taskId);if(!target||target.role!=='worker')throw Error('原任务补充必须引用已核对的工作任务');
    const key=`director-amend:${task.id}:${createHash('sha256').update(value.taskId+'\0'+value.text).digest('hex')}`;
    await hub.message(target.id,value.text,{messageKey:key,source:'supervisor'});
    if(!hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.amended'").get(task.id))hub.store.event(task.id,'director.amended',{workerId:target.id});
    return target;
  }
  const ack=supervisorDirective(text,'[HUB-ACK]');
  if(ack) {
    const value=ack.value;
    if(!value||typeof value.text!=='string'||!value.text.trim()||value.text.length>1200||/\[HUB-/u.test(value.text))throw Error('主管前台回应格式无效');
    if(!hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.ack-delivered'").get(task.id)) {
      const reply=dispatchConversationText(value.text.trim());
      hub.store.transaction(()=>{
        if(reply){hub.say(reply);hub.notification(reply,`frontdesk:${task.id}`);}
        hub.store.event(task.id,'director.ack-delivered',{text:reply,display:reply?'conversation':'task-hint'});
      });
    }
  }
  const envelopes=supervisorDispatches(text,{partial:true});
  if(envelopes.length&&String(text).split('[HUB-DISPATCH]').length>2){
    let admitted=null;
    for(const envelope of envelopes)admitted=await publishSupervisorProgress(hub,task,'[HUB-DISPATCH] '+JSON.stringify(envelope.value),{sibling:true});
    return admitted;
  }
  const dispatch=supervisorDirective(text,'[HUB-DISPATCH]');
  if(!dispatch)return linkedSupervisorTask(hub,task);
  const request=dispatch.value;
  if(!request||Array.isArray(request)||Object.keys(request).some(key=>!['engine','prompt','project','requestId','reply','contextTaskId'].includes(key))||!Object.hasOwn(hub.adapters,request.engine)||typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>20000||(request.project!==undefined&&(typeof request.project!=='string'||request.project.length>100))||(request.requestId!==undefined&&request.requestId!==task.id)||(request.reply!==undefined&&(typeof request.reply!=='string'||request.reply.length>1200))||(request.contextTaskId!==undefined&&typeof request.contextTaskId!=='string'))throw Error('主管派单协议无效');
  if(isRemoteRelayDispatch(request.prompt)){
    if(!hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.remote-tool-required'").get(task.id))hub.store.event(task.id,'director.remote-tool-required',{reason:'remote-native-operation-is-not-local-worker-task'});
    return null;
  }
  const digest=createHash('sha256').update(request.engine+'\0'+request.prompt.trim()).digest('hex').slice(0,24);
  const dispatchKey=`director:${task.id}:${digest}`;
  const exact=()=>hub.store.task('t-'+createHash('sha256').update(dispatchKey).digest('hex').slice(0,12));
  let coordinator=sibling?exact():linkedSupervisorTask(hub,task);
  if(!coordinator) {
    if(hub.nativeTasks&&hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='dsh.tool-activity' LIMIT 1").get(task.id)) {
      if(!await hub.nativeTasks.poll({fresh:true}))throw Error('暂时无法核对原生派单，暂停补派以避免重复执行。');
      coordinator=sibling?exact():linkedSupervisorTask(hub,task);
      const unknownNative=sibling&&hub.store.db.prepare(`SELECT 1 FROM events e WHERE e.taskId=? AND e.type='director.worker-created'
        AND NOT EXISTS(SELECT 1 FROM events a WHERE a.taskId=e.taskId AND a.type='director.dispatch-admitted'
          AND json_extract(a.data,'$.coordinatorId')=json_extract(e.data,'$.workerId')) LIMIT 1`).get(task.id);
      if(unknownNative&&!coordinator)throw Error('无法确定原生派单与新增目标的对应关系，保留接收状态而不补派');
    }
  }
  if(!coordinator) {
    const prompt=request.prompt.trim();
    const context=hub.workHandoff(task)||buildWorkHandoff({store:hub.store,userText:task.prompt});
    if(request.contextTaskId&&!([context.previousWork,...(context.relevantWork||[])].some(work=>work?.taskId===request.contextTaskId))) {
      const previous=buildWorkHandoff({store:hub.store,userText:context.userRequest,sourceTaskId:request.contextTaskId}).previousWork;
      const owned=task.sessionId&&hub.store.db.prepare(`WITH RECURSIVE owned(id,depth) AS (
        SELECT id,0 FROM tasks WHERE role='director' AND sessionId=?
        UNION ALL SELECT json_extract(e.data,'$.workerId'),owned.depth+1 FROM owned
        JOIN events e ON e.taskId=owned.id AND e.type='director.worker-created' WHERE owned.depth<3
      ) SELECT 1 FROM owned WHERE id=? LIMIT 1`).get(task.sessionId,request.contextTaskId);
      if(!previous||!owned)throw Error('续接目标不在本轮已核验的任务上下文中');
      hub.store.event(task.id,'director.context-refreshed',{sourceTaskId:request.contextTaskId,reason:'verified-session-dispatch-chain'});
    }
    const handoff={...(request.contextTaskId?buildWorkHandoff({store:hub.store,userText:context.userRequest,goal:prompt,sourceTaskId:request.contextTaskId}):context),goal:prompt,preferredEngine:request.engine,...(request.project&&context.userRequest?.includes(request.project)?{requestedProject:request.project}:{})};
    let imagePaths=[];try{const row=hub.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.images' ORDER BY id DESC LIMIT 1").get(task.id);imagePaths=JSON.parse(row?.data||'{}').paths||[];}catch{}
    coordinator=await hub.create({engine:'dsh',role:'coordinator',prompt,messageKey:dispatchKey,imagePaths,handoff,siblingDispatch:sibling});
    hub.store.event(task.id,'director.dispatch-admitted',{coordinatorId:coordinator.id});
  }
  if(!hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.delegation-announced'").get(task.id)) {
    const withoutAck=stripSupervisorAck(text);
    const envelope=supervisorDirective(withoutAck,'[HUB-DISPATCH]');
    const outside=envelope?(withoutAck.slice(0,withoutAck.indexOf('[HUB-DISPATCH]'))+withoutAck.slice(envelope.end)).trim():'';
    const consumedText=outside&&!outside.includes('[HUB-')?outside:'';
    const reply=dispatchConversationText(consumedText||request.reply?.trim()||'');
    hub.store.transaction(()=>{if(reply){hub.say(reply);hub.notification(reply,`director-delegated:${task.id}`);}hub.store.event(task.id,'director.delegation-announced',{text:reply,consumedText,display:reply?'conversation':'task-hint',sessionName:hub.sessionTitleForTask(coordinator)});});
  }
  return coordinator;
}

export function stripSupervisorAck(text) {
  const ack=supervisorDirective(text,'[HUB-ACK]');
  if(!ack)return String(text||'');
  const start=String(text).indexOf('[HUB-ACK]');
  return (String(text).slice(0,start)+String(text).slice(ack.end)).trim();
}
