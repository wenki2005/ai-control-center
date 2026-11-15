import { createHash } from 'node:crypto';
import {sessionExecutionRequested,protectedSession} from '../routing/session-continuation.mjs';

const engines=new Set(['dsh','codex','workbuddy']);
const active=new Set(['running','queued','starting','awaiting_approval','active']);
export function createNativeSessionRoutes({store,hub,nativeSessions,remoteSupervisor,body,json}) {
  return async function handle(req,res,url) {
    const path=url.pathname;
    if(path==='/api/native-sessions'&&req.method==='GET') {
      const engine=url.searchParams.get('engine'); if(engine&&!engines.has(engine))return json(res,400,{error:'engine 无效'}),true;
      const value=await nativeSessions.list({engine:engine||undefined,query:url.searchParams.get('q')||undefined,limit:100});
      return json(res,200,value),true;
    }
    const match=path.match(/^\/api\/native-sessions\/([^/]+)\/([^/]+)$/u);
    if(match&&req.method==='GET') {const engine=decodeURIComponent(match[1]),sessionId=decodeURIComponent(match[2]);if(!engines.has(engine))return json(res,400,{error:'engine 无效'}),true;return json(res,200,await nativeSessions.read({engine,sessionId,limit:200})),true;}
    if(path!=='/api/director/native-session'||req.method!=='POST')return false;
    const args=await body(req),{requestId,sessionId,engine,action,targetSessionId,query,text}=args;
    if(args.scope!==undefined&&!['local','remote'].includes(args.scope)||args.scope==='local'&&args.deviceId)return json(res,400,{error:'会话范围无效，请明确选择本机或远端'}),true;
    const caller=requestId?store.task(requestId):store.db.prepare("SELECT * FROM tasks WHERE engine='dsh' AND role='coordinator' AND sessionId=? AND status='running' ORDER BY createdAt DESC LIMIT 1").get(String(sessionId||''));
    if(!caller||caller.engine!=='dsh'||!sessionId||caller.role!=='coordinator'||caller.status!=='running'||caller.sessionId!==sessionId)return json(res,403,{error:'会话工具由当前工具编排层处理，对话主管只交接请求。'}),true;
    if(args.scope==='remote'||args.deviceId){
      if(!remoteSupervisor)return json(res,503,{error:'远端主管通道尚未就绪'}),true;
      return json(res,200,await remoteSupervisor.request(caller,args)),true;
    }
    if(!engines.has(engine)||!['list','read','message'].includes(action))return json(res,400,{error:'引擎或操作无效'}),true;
    if(action==='list'){
      const catalog=await nativeSessions.list({engine,query,limit:100});
      const userRequest=hub.workHandoff?.(caller)?.userRequest||caller.prompt;
      if(query&&catalog.items?.length>1&&!catalog.truncated&&!catalog.errors?.length&&sessionExecutionRequested(userRequest)){
        store.event(caller.id,'director.native-session-candidates',{code:'NATIVE_SESSION_AMBIGUOUS',userRequest,candidates:catalog.items.map(({engine,sessionId,title,cwd,status})=>({engine,sessionId,title,cwd,status,scope:'local'}))});
      }
      return json(res,200,catalog),true;
    }
    if(typeof targetSessionId!=='string'||!targetSessionId)return json(res,400,{error:'目标会话无效'}),true;
    if(action==='message'&&(typeof text!=='string'||!text.trim()||text.length>20000))return json(res,400,{error:'消息内容需要1至20000字符'}),true;
    const messageKey=action==='message'?'director:'+caller.id+':'+createHash('sha256').update(engine+'\0'+targetSessionId+'\0'+text).digest('hex').slice(0,24):null;
    const existing=messageKey?store.task('t-'+createHash('sha256').update(messageKey).digest('hex').slice(0,12)):null;
    if(existing)return json(res,200,{task:existing,sessionTitle:hub.sessionTitleForTask(existing),duplicate:true}),true;
    const record=await nativeSessions.read({engine,sessionId:targetSessionId,limit:100});
    if(record.engine!==engine||record.sessionId!==targetSessionId)return json(res,409,{error:'原生会话返回的身份不匹配，没有转交'}),true;
    const target={...record,title:record.title||record.sessionName,scope:'local'};
    if(action==='message'&&record.sessionId===sessionId)return json(res,400,{error:'不能向主管自身会话发送消息'}),true;
    if(action==='message'&&protectedSession({store,target,caller,repairIds:[hub.codexRepairThreadId,hub.codexAutoRepairThreadId]}))return json(res,409,{error:'该目标属于Bot、修复、直连或其他受保护内部会话，请核对目标'}),true;
    store.event(caller.id,'director.native-session-verified',{engine,sessionId:record.sessionId,cwd:record.cwd,title:target.title,status:record.status,scope:'local',action});
    if(action==='read')return json(res,200,record),true;
    const handoff=hub.workHandoff?.(caller);
    const confirmedChoice=[handoff?.requestedSession,...(handoff?.nativeContinuationTargets||[])].some(c=>c?.source==='user-choice'&&c.engine===engine&&c.sessionId===targetSessionId&&sessionExecutionRequested(c.originalRequest||''));
    if(!sessionExecutionRequested(handoff?.userRequest||caller.prompt,{targetTitles:[target.title]})&&!confirmedChoice)return json(res,403,{error:'本轮只要求查询或提及会话，发送与继续工作需要用户明确要求'}),true;
    if(active.has(String(record.status||'').toLowerCase()))return json(res,409,{error:'目标会话仍在运行，不能发送续接消息'}),true;
    if(record.sessionId===sessionId)return json(res,400,{error:'不能向主管自身会话发送消息'}),true;
    if(!target.cwd)return json(res,409,{error:'已读到原会话，但尚未取得可核验的原工作目录；没有改派固定会话'}),true;
    if(store.task(caller.id)?.status!=='running')return json(res,409,{error:'本轮主管请求已结束，没有发送消息'}),true;
    const task=await hub.create({engine,prompt:text,originalUserText:text,messageKey,nativeSession:{...target,engine},role:'worker'});
    return json(res,200,{task,sessionTitle:hub.sessionTitleForTask(task)}),true;
  };
}
