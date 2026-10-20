import { redact } from '../redact.mjs';

export async function retractChatMessage(hub,id) {
  const chatId=Number(id);
  if(!Number.isSafeInteger(chatId)||chatId<1)throw Error('消息无效');
  const {store}=hub,row=store.db.prepare('SELECT * FROM chat WHERE id=?').get(chatId);
  if(!row||row.role!=='user')throw Error('只能撤回自己的消息');
  if(row.retractedAt)return {ok:true,stopped:0};
  const roots=store.db.prepare("SELECT taskId FROM events WHERE type='chat.request' AND json_extract(data,'$.chatId')=?").all(chatId).map(item=>item.taskId);
  const tasks=[],seen=new Set(),queue=[...roots];
  while(queue.length) {
    const taskId=queue.shift();if(seen.has(taskId))continue;seen.add(taskId);
    const task=store.task(taskId);if(task)tasks.push(task);
    for(const event of store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created'").all(taskId)) {
      try {const child=JSON.parse(event.data||'{}').workerId;if(child)queue.push(child);}catch{}
    }
  }
  const active=tasks.filter(task=>['queued','running','waiting'].includes(task.status));
  let external=tasks.some(task=>task.role==='worker'&&task.status!=='queued'||store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='dsh.tool-activity' LIMIT 1").get(task.id));
  store.transaction(()=>{
    store.db.prepare("UPDATE chat SET text='这条消息已撤回',retractedAt=? WHERE id=?").run(store.now(),chatId);
    if(store.companionSearchAvailable)store.db.prepare('DELETE FROM companion_chat_fts WHERE rowid=?').run(chatId);
    for(const task of tasks) {
      store.event(task.id,'task.message-retracted',{chatId});
      store.db.prepare("UPDATE outbox SET status='suppressed',updatedAt=? WHERE status='pending' AND instr(dedupe,?)>0").run(store.now(),task.id);
    }
    for(const task of active) {
      // Invalidate callbacks before awaiting remote cancellation, so a racing
      // completed frame cannot create another coordinator or publish a reply.
      store.update(task.id,{status:'cancelled',runVersion:(task.runVersion||0)+1,error:'用户已撤回原消息，停止后续处理。'});
      store.db.prepare("UPDATE approvals SET status='cancelled',updatedAt=? WHERE taskId=? AND status IN ('pending','resolving')").run(store.now(),task.id);
      store.event(task.id,'task.cancelled',{source:'chat-retract',chatId});
    }
    store.event(null,'chat.retracted',{chatId,stopped:active.length});
  });
  let uncertain=false;
  await Promise.all(active.filter(task=>task.status!=='queued').map(async task=>{
    let timeout;
    try {await Promise.race([hub.adapters[task.engine].cancel(task),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('引擎停止确认超时')),5000);})]);}
    catch(error){uncertain=true;store.event(task.id,'task.cancel-unconfirmed',{message:redact(error.message)});}
    finally{clearTimeout(timeout);}
  }));
  hub.pumpWorkerQueue();hub.kickDirector();hub.emit();
  return {ok:true,stopped:active.length,...(uncertain?{warning:'消息已撤回，中枢已停止继续处理；引擎尚未确认停止，请在原会话核对。已经发生的外部操作无法自动撤销。'}:external?{warning:'已停止后续处理；已经发出的邮件或其他外部操作无法通过撤回自动撤销。'}:!roots.length?{warning:'消息已撤回。这条历史消息没有可核实的任务关联，无法自动撤销此前可能发生的操作。'}:{})};
}
