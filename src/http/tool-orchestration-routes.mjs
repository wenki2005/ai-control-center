import {redact} from '../redact.mjs';

// Only short, typed Hub capabilities. Engine execution and device permissions
// remain owned by their existing routes, queues and approval ledgers.
const allowed=(method,path)=>{
 const p=path.split('?')[0];
 if(method==='GET')return ['/api/workers','/api/workers/memory','/api/reports/status','/api/screen-companion','/api/screen-companion/inspect','/api/server-monitor','/api/companion/social','/api/companion/social/drafts','/api/companion/memory/recall','/api/usage/daily','/api/companion/drawings','/api/companion/singing'].includes(p)||/^\/api\/companion\/(?:drawings|singing)\/[\w-]+$/u.test(p);
 return method==='POST'&&(['/api/director/native-session','/api/director/amend-task','/api/director/fixed-worker','/api/screen-companion/share','/api/companion/social/browse','/api/companion/links/read','/api/companion/drawings','/api/companion/singing','/api/companion/stickers/search','/api/workbuddy/open'].includes(p)||/^\/api\/companion\/(?:drawings|singing|stickers)\/[\w-]+\/(?:send|review)$/u.test(p));
};
export function createToolOrchestrationRoutes({store,body,json,fetchImpl=fetch}){
 return async(req,res,url)=>{
  if(url.pathname!=='/api/coordinator/tool'||req.method!=='POST')return false;
  const value=await body(req),{sessionId,path,method='GET',data}=value;
  const caller=store.db.prepare("SELECT * FROM tasks WHERE role='coordinator' AND engine='dsh' AND sessionId=? AND status='running' ORDER BY createdAt DESC LIMIT 1").get(String(sessionId||''));
  if(!caller)return json(res,403,{error:'工具调用由当前工具编排会话处理；对话主管只负责交流和交接。'}),true;
  if(typeof path!=='string'||!path.startsWith('/api/')||path.includes('\\')||path.includes('#')||path.includes('..')||!allowed(method,path))return json(res,400,{error:'未开放该编排能力入口'}),true;
  const origin='http://127.0.0.1:'+(req.socket?.localPort||3188);
  let response;
  try{
   response=await fetchImpl(origin+path,{method,headers:{origin,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({...data,sessionId:caller.sessionId,requestId:caller.id})}:{}),signal:AbortSignal.timeout(65000)});
   const result=await response.json();
   // The observed response, not the model's claim, is the query evidence.
   const cleaned=redact(JSON.stringify(result));
   store.event(caller.id,'coordinator.tool-result',{path,method,httpStatus:response.status,ok:response.ok,result:cleaned.length>20000?{text:cleaned.slice(0,20000),truncated:true}:JSON.parse(cleaned||'null')});
   return json(res,response.status,result),true;
  }catch(error){
   store.event(caller.id,'coordinator.tool-uncertain',{path,method,error:redact(error.message).slice(0,300),sideEffectPossible:method==='POST'});
   return json(res,503,{error:'工具响应未能确认，已保留原请求；涉及发送或设备操作时先核对结果。',uncertain:true}),true;
  }
 };
}
