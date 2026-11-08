import {createHash} from 'node:crypto';

/** The supervisor talks to a paired device directly; never creates a local worker. */
export class RemoteSupervisor {
 constructor({store,remote,waitMs=8500,pollMs=250}){Object.assign(this,{store,remote,waitMs,pollMs});}
 async request(caller,{action,engine,deviceId,targetSessionId,query,text,remoteRequestId}={}){
  if(!this.remote)throw Error('远端会话接入尚未就绪');
  const state=this.remote.state(),devices=state.devices.filter(d=>d.status==='approved');
  if(action==='devices')return {scope:'remote',devices:devices.map(({id,name,online,selected,capabilities,dshExecutionPolicy,executionPolicy})=>({id,name,online,selected,capabilities,dshExecutionPolicy,executionPolicy}))};
  if(!['codex','dsh'].includes(engine)||!['list','read','message','status'].includes(action))throw Error('远端会话支持 Codex / DSH 的 list、read、message、status');
  const device=devices.find(d=>d.id===(deviceId||state.activeDeviceId));if(!device)throw Error('请先在陪伴助手选择已批准的远端电脑');
  let job;
  if(action==='status'){
   job=this.remote.reads.get(remoteRequestId);if(!job||job.deviceId!==device.id||job.engine!==engine)throw Error('请求不属于所选远端电脑和引擎');
  }else{
   const nativeAction=action==='message'?'post':action;
   const hash=createHash('sha256').update(JSON.stringify([caller.id,device.id,engine,nativeAction,targetSessionId||'',action==='message'?text:''])).digest('hex');
   const key='director:remote-request:'+hash,previous=this.store.meta(key);
   job=previous?this.remote.reads.get(previous):null;
   if(!job){
    job=this.remote.reads.enqueue({deviceId:device.id,engine,action:nativeAction,sessionId:targetSessionId,prompt:action==='message'?text:undefined});
    this.store.meta(key,job.id);this.store.event(caller.id,'director.remote-operation',{deviceId:device.id,engine,action,remoteRequestId:job.id,sessionId:targetSessionId||null});
   }
  }
  const deadline=Date.now()+this.waitMs;
  while(['pending','reading','sending'].includes(job.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,this.pollMs));job=this.remote.reads.get(job.id);}
  let result=job.result;
  if(job.action==='list'&&result?.items&&query){const q=String(query).toLocaleLowerCase();result={...result,items:result.items.filter(x=>String(x.title||'').toLocaleLowerCase().includes(q))};}
  return {scope:'remote',device:{id:device.id,name:device.name},engine,remoteRequestId:job.id,status:job.status,result,error:job.error||null,
   meaning:job.status==='completed'&&job.action==='post'?'远端原生会话已确认接收，不等于任务完成；继续读取同一远端会话或等待原生完成回报。':['pending','reading','sending'].includes(job.status)?'请求处理中，使用 status 和 remoteRequestId 查询，不重复发送。':job.status==='uncertain'?'提交结果未知，只核对原会话，不重发。':undefined};
 }
}

// Old supervisor instructions sometimes describe API forwarding as local work.
// This boundary detects that concrete transport address, not ordinary task intent.
export function isRemoteRelayDispatch(prompt){
 const text=String(prompt||'');
 return /\/api\/remote-companion\/(?:sessions|context)/u.test(text)
  && /直接连接|查询远端.{0,80}会话|向.{0,80}会话.{0,40}发送/u.test(text)
  && !/^\s*(?:修复|升级|开发|实现|修改).{0,20}(?:中枢|接口|代码|路由)/u.test(text);
}
