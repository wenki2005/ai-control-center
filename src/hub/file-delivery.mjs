import {basename,resolve} from 'node:path';
import {isQqShareableArtifact} from '../knowledge/share-policy.mjs';
import {collectTaskDeliverables} from '../knowledge/task-deliverables.mjs';

export function createFileDeliverySupport({store,qq,archive,workspaceRoot,owner}){
 let login=null,loginAt=0;
 return {
  async verifyFileReceipt(task,claim){
   if(typeof qq.call!=='function')return null;
   if(!login||Date.now()-loginAt>60000){login=await qq.call('get_login_info',{});loginAt=Date.now();}
   const message=await qq.call('get_msg',{message_id:claim.messageId});
   return matchesFileReceipt(message,{task,claim,owner,senderId:login.user_id})?{time:Number(message.time)}:null;
  },
  async registerVerifiedFileDelivery(task,receipt){
   const records=await collectTaskDeliverables({task,archive,workspaceRoot,verifiedDelivery:receipt});
   for(const record of records){
    const filePath=await archive.resolveFile(record.id);
    store.transaction(()=>{
     const row=store.enqueueAttachment({artifactId:record.id,filePath,dedupe:`verified-native-file:${task.id}:${task.runVersion}:${receipt.messageId}`});
     store.attachment(row.id,'sent');
     store.event(task.id,'qq.attachment-sent',{attachmentId:row.id,artifactId:record.id,messageId:receipt.messageId,source:'verified-native-history',nativeSentAt:new Date(receipt.time*1000).toISOString()});
    });
   }
   return records;
  }
 };
}

export function claimedFileReceipts(task){
 const text=String(task.result||''),ids=[...new Set([...text.matchAll(/(?:message_id|消息(?:编号|ID))\s*[`"：:=\s]*(-?\d{1,20})(?![\d.])/gi)].map(m=>m[1]))].slice(0,4);
 const paths=[...text.matchAll(/[A-Za-z]:[\\/][^\r\n<>"|?*`]+?\.(?:md|markdown|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|txt)(?=[\s）)。，；;、"'`]|$)/gi)].map(m=>m[0]);
 return ids.flatMap(messageId=>paths.filter(path=>String(task.prompt).includes(path)&&isQqShareableArtifact({name:basename(path),isImage:/\.(png|jpe?g|webp|gif)$/i.test(path)})).map(path=>({messageId,path:resolve(path),name:basename(path)}))).slice(0,8);
}

/** Trust platform metadata, never the worker's prose alone. */
export function matchesFileReceipt(message,{task,claim,owner,senderId,now=Date.now()}){
 const time=Number(message?.time),start=Date.parse(task.startedAt||task.createdAt)/1000;
 if(message?.message_type!=='private'||String(message.target_id)!==String(owner)||String(message.sender?.user_id)!==String(senderId)
  ||String(message.message_id)!==claim.messageId||!Number.isFinite(time)||!Number.isFinite(start)||time<start-2||time>now/1000+5)return false;
 return Array.isArray(message.message)&&message.message.some(part=>part.type==='file'&&basename(String(part.data?.name||part.data?.file||'').replaceAll('\\','/'))===claim.name);
}

export function refreshFileDelivery(store,task){
 const delivery=task.fileDelivery;if(!delivery?.attachmentId)return task;
 const row=store.db.prepare('SELECT status FROM attachment_outbox WHERE id=?').get(delivery.attachmentId);
 if(!row||row.status===delivery.state)return task;
 const summary=row.status==='sent'?`《${delivery.name||'目标文件'}》已取得QQ发送确认。`
  :['pending','sending'].includes(row.status)?`《${delivery.name||'目标文件'}》已登记发送，尚待QQ确认。`:`《${delivery.name||'目标文件'}》的发送${row.status==='uncertain'?'结果尚未确认':'失败'}，需要核对原记录。`;
 return {...task,result:summary,fileDelivery:{...delivery,state:row.status,summary}};
}

/** A single completion owner: existing intent, verified native send, then collection. */
export async function finishFileDelivery(hub,task,collected=[]){
 const {store}=hub;
 const previous=store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='file-delivery.resolved' ORDER BY id DESC LIMIT 1").get(task.id);
 if(previous){const outcome=JSON.parse(previous.data);if(outcome.runVersion===task.runVersion)return outcome;}
 const save=outcome=>{const value={...outcome,runVersion:task.runVersion};store.event(task.id,'file-delivery.resolved',value);return value;};
 const candidates=collected.filter(record=>record?.id&&isQqShareableArtifact(record));
 const existing=store.db.prepare(`SELECT o.*,a.name FROM attachment_outbox o LEFT JOIN artifacts a ON a.id=o.artifactId
  WHERE (a.task_id=? OR o.dedupe LIKE ?) AND o.createdAt>=? ORDER BY o.updatedAt DESC`).all(task.id,`file-delivery:${task.id}:%`,task.startedAt||task.createdAt);
 if(existing.length){
  const row=existing.find(r=>r.status==='sent')||existing[0],state=row.status;
  return save({state,attachmentId:row.id,artifactIds:[row.artifactId],name:row.name||'目标文件',summary:state==='sent'?`《${row.name||'目标文件'}》已取得QQ发送确认。`:['pending','sending'].includes(state)?`《${row.name||'目标文件'}》已经进入发送流程，尚待QQ确认。`:`《${row.name||'目标文件'}》的发送结果${state==='uncertain'?'尚未确认':'为失败'}，需要核对原记录。`});
 }
 for(const claim of claimedFileReceipts(task)){
  try{
   const receipt=await hub.verifyFileReceipt?.(task,claim);
   if(!receipt)continue;
   let artifactIds=[];
   try{artifactIds=(await hub.registerVerifiedFileDelivery?.(task,{...claim,...receipt})||[]).map(a=>a.id);}catch(error){store.event(task.id,'file-delivery.archive-unavailable',{message:error.message});}
   return save({state:'sent',name:claim.name,artifactIds,messageId:claim.messageId,summary:`《${claim.name}》已由工作会话发送，QQ平台回读确认了文件消息。`});
  }catch(error){store.event(task.id,'file-delivery.receipt-check-failed',{message:error.message});}
 }
 // An existing send claim is not permission to send another copy.
 if(/(?:已(?:经)?(?:通过.{0,25})?发(?:送|出)|文件已发|发送.{0,8}(?:成功|回执)|message_id\s*[`"：:=])/i.test(String(task.result))){
  return save({state:'unverified',artifactIds:[],summary:'工作会话报告已发送文件，但中枢尚未核实到本轮平台回执；发送结果待核对。'});
 }
 if(candidates.length===1){
  const artifact=candidates[0];
  try{const row=await hub.queueArtifact(artifact,{dedupe:`file-delivery:${task.id}:${task.runVersion}:${artifact.id}`});return save({state:row?.status||'pending',attachmentId:row?.id,artifactIds:[artifact.id],name:artifact.name,summary:`《${artifact.name}》已找到并登记发送，尚待QQ确认。`});}
  catch(error){return save({state:'failed',artifactIds:[artifact.id],name:artifact.name,summary:`《${artifact.name}》已找到，但附件发送尚未完成：${error.message}`});}
 }
 return save({state:'unresolved',artifactIds:[],summary:candidates.length>1?'归档中有多份候选文件，需要进一步核对用户所指的目标。':'本轮尚未取得可确认交付的归档文件，需要核对原任务的文件位置；归档为空不代表源文件不存在。'});
}
