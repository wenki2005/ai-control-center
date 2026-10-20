import { createHash } from 'node:crypto';
import { parseProtocolObject } from '../protocol/director-output.mjs';
import { buildWorkHandoff } from './work-handoff.mjs';

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

// A full, validated directive admits work. It is not an engine completion:
// only the worker's genuine terminal event can complete the execution task.
export async function publishSupervisorProgress(hub,task,text) {
  if(task.role!=='director'||/^\[(?:内部工作回报|前台回应)\]/u.test(task.prompt))return null;
  const ack=supervisorDirective(text,'[HUB-ACK]');
  if(ack) {
    const value=ack.value;
    if(!value||typeof value.text!=='string'||!value.text.trim()||value.text.length>1200||/\[HUB-/u.test(value.text))throw Error('主管前台回应格式无效');
    if(!hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.ack-delivered'").get(task.id)) {
      hub.store.transaction(()=>{
        hub.say(value.text.trim());hub.notification(value.text.trim(),`frontdesk:${task.id}`);
        hub.store.event(task.id,'director.ack-delivered',{text:value.text.trim()});
      });
    }
  }
  const dispatch=supervisorDirective(text,'[HUB-DISPATCH]');
  if(!dispatch)return linkedSupervisorTask(hub,task);
  const request=dispatch.value;
  if(!request||Array.isArray(request)||Object.keys(request).some(key=>!['engine','prompt','project','requestId','reply','contextTaskId'].includes(key))||!Object.hasOwn(hub.adapters,request.engine)||typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>20000||(request.project!==undefined&&(typeof request.project!=='string'||request.project.length>100))||(request.requestId!==undefined&&request.requestId!==task.id)||(request.reply!==undefined&&(typeof request.reply!=='string'||request.reply.length>1200))||(request.contextTaskId!==undefined&&typeof request.contextTaskId!=='string'))throw Error('主管派单协议无效');
  let coordinator=linkedSupervisorTask(hub,task);
  if(!coordinator) {
    if(hub.nativeTasks&&hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='dsh.tool-activity' LIMIT 1").get(task.id)) {
      if(!await hub.nativeTasks.poll({fresh:true}))throw Error('暂时无法核对原生派单，暂停补派以避免重复执行。');
      coordinator=linkedSupervisorTask(hub,task);
    }
  }
  if(!coordinator) {
    const prompt=request.prompt.trim();
    const context=hub.workHandoff(task)||buildWorkHandoff({store:hub.store,userText:task.prompt});
    if(request.contextTaskId&&!([context.previousWork,...(context.relevantWork||[])].some(work=>work?.taskId===request.contextTaskId)))throw Error('续接目标不在本轮已核验的任务上下文中');
    const handoff={...(request.contextTaskId?buildWorkHandoff({store:hub.store,userText:context.userRequest,goal:prompt,sourceTaskId:request.contextTaskId}):context),goal:prompt,preferredEngine:request.engine,...(request.project&&context.userRequest?.includes(request.project)?{requestedProject:request.project}:{})};
    const digest=createHash('sha256').update(request.engine+'\0'+prompt).digest('hex').slice(0,24);
    let imagePaths=[];try{const row=hub.store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='task.images' ORDER BY id DESC LIMIT 1").get(task.id);imagePaths=JSON.parse(row?.data||'{}').paths||[];}catch{}
    coordinator=await hub.create({engine:'dsh',role:'coordinator',prompt,messageKey:`director:${task.id}:${digest}`,imagePaths,handoff});
    hub.store.event(task.id,'director.dispatch-admitted',{coordinatorId:coordinator.id});
  }
  if(!hub.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='director.delegation-announced'").get(task.id)) {
    const reply=request.reply?.trim()||`已经交给二级主管「${hub.sessionTitleForTask(coordinator)}」安排，承接的工作会话确认后我再告诉你。`;
    hub.store.transaction(()=>{hub.say(reply);hub.notification(reply,`director-delegated:${task.id}`);hub.store.event(task.id,'director.delegation-announced',{text:reply});});
  }
  return coordinator;
}

export function stripSupervisorAck(text) {
  const ack=supervisorDirective(text,'[HUB-ACK]');
  if(!ack)return String(text||'');
  const start=String(text).indexOf('[HUB-ACK]');
  return (String(text).slice(0,start)+String(text).slice(ack.end)).trim();
}
