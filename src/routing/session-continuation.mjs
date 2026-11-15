import {readFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {homedir} from 'node:os';
import {isInternalSession} from '../observability/internal-sessions.mjs';
import {requestedEngine} from './engine-policy.mjs';

const normal=id=>String(id||'').replace(/^session-/u,'');
const data=row=>{try{return JSON.parse(row?.data||'null');}catch{return null;}};
export const continuationRequested=text=>/(?:继续|接着|接续|续做|沿用|原会话|原来的会话|补充|再改|重试|follow.?up|continue|resume)/iu.test(String(text||''));
export const independentRequest=text=>/(?:另一个任务|新的任务|新任务|换个话题|另外.{0,6}(?:做|任务|项目)|独立任务|不沿用|不要续接|从头开始|新建会话)/u.test(String(text||''));
function namedSessionQuery(text){
  const quoted=/[「《“"『]([^」》”"』]{1,160})[」》”"』]\s*(?:的)?(?:会话|对话)|(?:会话|对话)\s*[「《“"『]([^」》”"』]{1,160})[」》”"』]/u.exec(text);
  if(quoted)return quoted[1]||quoted[2];
  const id=/(?:session-)?[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/iu.exec(text);if(id)return id[0];
  const plain=/(?:在|到|给|向|用|继续|接着)\s*([^，。；\n]{1,100}?)\s*(?:会话|对话)(?!管理|功能|机制|路由|设置|工具|模块|列表|系统)/u.exec(text),value=plain?.[1]?.replace(/^(?:DSH|Codex|WorkBuddy)(?:的|中|里)?\s*/iu,'').trim();
  // Deictic phrases refer to a recorded target; they are not new catalog names.
  const reference=/^(?:(?:原来|刚才|刚刚|上面|前面|之前|先前|当前|刚看过|刚提到)(?:的)?(?:这|那)?(?:一个|个)?|这(?:一个|个)?|那(?:一个|个)?)$/u;
  return reference.test(value||'')?null:value||null;
}
export function sessionExecutionRequested(text,{targetTitles=[]}={}){
  // Quoted names/content describe the target; they do not grant an action.
  let value=String(text||'').replace(/```[\s\S]*?```/gu,'').replace(/^\s*>.*$/gmu,'').replace(/[「《“"『][^」》”"』]*[」》”"』]/gu,'');
  for(const title of targetTitles.filter(Boolean))for(const noun of ['会话','对话'])value=value.replaceAll(title+noun,noun).replaceAll(noun+title,noun);
  if(/(?:不要|别|无需|不用).{0,6}(?:继续|发消息|发送|派单|执行)/u.test(value))return false;
  const resume=/(?:继续|接着|接续|续做|沿用|发(?:送)?(?:消息|给)|重试|continue|resume)/iu.test(value);
  const query=/(?:查看|读取|查询|看一下|看看|进度|历史|为什么|是否|有没有|状态|失败原因|提及|提到)/u.test(value);
  if(query&&!resume)return false;
  return resume||/(?:开发|修复|实现|修改|编写|构建|部署|完成|把.{0,30}改)/u.test(value);
}
export class SessionContinuationError extends Error {
  constructor(code,message,candidates=[]){super(message);this.name='SessionContinuationError';this.code=code;this.statusCode=409;this.candidates=candidates.map(x=>({engine:x.engine,sessionId:x.sessionId,title:x.title||x.sessionName||x.sessionId,scope:x.scope||'local',...(x.deviceId?{deviceId:x.deviceId}:{})}));}
}
export const isSessionContinuationError=error=>error instanceof SessionContinuationError;
const fail=(code,message,targets)=>{throw new SessionContinuationError(code,message,targets);};

export function protectedSession({store,target,caller,repairIds=[],botState=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'bot/state.json')}){
  const id=normal(target.sessionId);
  if(!id||id===normal(caller?.sessionId)||repairIds.some(value=>value&&normal(value)===id)||isInternalSession(store,target.engine,target.sessionId))return true;
  if(store.db.prepare("SELECT 1 FROM tasks WHERE (sessionId=? OR sessionId=?) AND role IN ('direct','repair','reporter','maintenance','librarian') LIMIT 1").get(id,'session-'+id))return true;
  try{const state=JSON.parse(readFileSync(botState,'utf8'));for(const [key,item]of [...Object.entries(state.bots||{}),...Object.entries(state.rooms||{})]){
    const ids=[key,item.id,item.sessionId,...Object.values(item.sessions||{}),...(Array.isArray(item.segments)?item.segments:Object.values(item.segments||{}).flat()).map(x=>x?.sessionId)];if(ids.some(value=>value&&normal(value)===id))return true;
  }}catch{}
  return /^(?:中枢自动测试|中控自动测试|连通测试|连接验收|Internal reliability acceptance)/iu.test(target.title||'');
}

/** Only canonical adjacent dialogue and its recorded dispatch/read edges anchor a short follow-up. */
export function adjacentContinuationContext(store,userText,{currentTaskId,now=Date.parse(store.now())}={}){
  if(independentRequest(userText)||!continuationRequested(userText)&&!/^\s*(?:选|选择|就)?第?[一二三四五六七八九十\d]+(?:个|项)?[，,。\s]*(?:继续.*)?$/u.test(userText))return null;
  const users=store.db.prepare("SELECT c.id,c.text,c.createdAt FROM chat c WHERE role='user' AND retractedAt IS NULL AND NOT EXISTS(SELECT 1 FROM chat_context_exclusions x WHERE x.chatId=c.id) ORDER BY id DESC LIMIT 2").all();
  if(users[0]?.text===String(userText).trim())users.shift();const previous=users[0];
  if(!previous||now-Date.parse(previous.createdAt)>2*3600000)return null;
  const roots=store.db.prepare("SELECT e.taskId,e.data FROM events e JOIN tasks t ON t.id=e.taskId WHERE e.type='chat.request' AND t.role='director' ORDER BY e.id DESC LIMIT 50").all();
  const root=roots.find(row=>row.taskId!==currentTaskId&&data(row)?.chatId===previous.id);if(!root)return null;
  if(store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.message-retracted' LIMIT 1").get(root.taskId))return null;
  const contextIds=[root.taskId];
  for(const event of store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 8").all(root.taskId)){
    const child=data(event)?.workerId;if(child&&store.task(child)?.role==='coordinator')contextIds.push(child);
  }
  const records=contextIds.flatMap(id=>store.db.prepare("SELECT id,data FROM events WHERE taskId=? AND type IN ('director.continuation-blocked','director.native-session-candidates') ORDER BY id DESC LIMIT 1").all(id)).sort((a,b)=>b.id-a.id);
  const blocked=data(records[0]);
  if(blocked?.code==='NATIVE_SESSION_AMBIGUOUS'&&blocked.candidates?.length){
    const match=/^\s*(?:选|选择|就)?第?([一二三四五六七八九十\d]+)(?:个|项)?[，,。\s]*(?:继续.*)?$/u.exec(userText);
    const index=match?(/^\d+$/u.test(match[1])?Number(match[1]):'一二三四五六七八九十'.indexOf(match[1])+1)-1:-1;
    const selected=blocked.candidates[index]||blocked.candidates.find(c=>String(userText).trim()===`选择${c.title}`);
    if(selected)return {nativeTarget:{...selected,source:'user-choice',originalRequest:blocked.userRequest},sourceTaskId:root.taskId};
  }
  const taskIds=new Set(),nativeTargets=[];let frontier=[root.taskId];
  for(let depth=0;depth<3;depth++){
    const next=[];for(const id of frontier){
      for(const row of store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.native-session-verified' ORDER BY id DESC LIMIT 10").all(id)){const value=data(row);if(value?.scope==='local')nativeTargets.push(value);}
      for(const row of store.db.prepare("SELECT data FROM events WHERE taskId=? AND type='director.worker-created' ORDER BY id DESC LIMIT 10").all(id)){const child=data(row)?.workerId;if(!child)continue;const task=store.task(child);if(task?.role==='worker')taskIds.add(child);else if(task?.role==='coordinator')next.push(child);}
    }frontier=next;
  }
  return {taskIds:[...taskIds],nativeTargets,sourceTaskId:root.taskId};
}

/** Resolve a requested identity before default pool selection; reading never authorizes a send. */
export async function resolveSessionContinuation({store,nativeSessions,nativeTasks,caller,userText,handoff={},repairIds=[],botState}={}){
  const execute=sessionExecutionRequested(userText),explicitEngine=requestedEngine(userText);
  if((handoff.requestedSession?.scope==='remote'||handoff.requestedSession?.deviceId)||/(?:远端|另一台电脑|那台电脑).{0,30}(?:会话|对话)/u.test(userText))
    fail('NATIVE_SESSION_REMOTE','请沿已选远端设备的原生会话通道核对和续接，当前请求没有改派到本机。');
  const verify=async target=>{
    if(!sessionExecutionRequested(userText,{targetTitles:[target.title]})&&target.source!=='user-choice')fail('NATIVE_SESSION_READ_ONLY','本轮是会话查询或提及，请读取原会话；发送或继续工作需要本轮明确要求。');
    if(target.scope==='remote'||target.deviceId)fail('NATIVE_SESSION_REMOTE','所选对象属于远端设备，请使用该设备的原生会话通道。');
    if(explicitEngine&&target.engine!==explicitEngine)fail('NATIVE_SESSION_ENGINE_CONFLICT','当前引擎选择与原会话所属引擎不同，请明确采用哪个；原会话没有换到其他引擎。',[target]);
    if(protectedSession({store,target,caller,repairIds,botState}))fail('NATIVE_SESSION_PROTECTED','该会话属于主管、Bot、修复、直连或受保护内部工作，不能作为普通开发续接目标。',[target]);
    let record;
    try{
      if(nativeSessions?.read)record=await nativeSessions.read({engine:target.engine,sessionId:target.sessionId,limit:1});
      else if(target.engine==='dsh'&&nativeTasks?.listSessions){const rows=await nativeTasks.listSessions();const row=rows.find(x=>normal(x.sessionId)===normal(target.sessionId));record=row&&{...row,engine:'dsh',status:row.running===true?'running':row.runningKnown===true?'idle':'unknown'};}
      else fail('NATIVE_SESSION_UNVERIFIED','当前没有可核验该原生会话身份的读取入口，保留原目标。',[target]);
    }catch(error){if(isSessionContinuationError(error))throw error;fail('NATIVE_SESSION_UNAVAILABLE','原会话暂时无法读取或已失效，保留原目标并核对后再继续。',[target]);}
    if(!record||record.engine!==target.engine||normal(record.sessionId)!==normal(target.sessionId)||!record.cwd||target.cwd&&record.cwd.replaceAll('\\','/').toLowerCase()!==target.cwd.replaceAll('\\','/').toLowerCase())fail('NATIVE_SESSION_UNAVAILABLE','原会话身份或工作目录已变化，尚未发送，也没有新建替代。',[target]);
    if(protectedSession({store,target:record,caller,repairIds,botState}))fail('NATIVE_SESSION_PROTECTED','核验到受保护的内部会话，普通开发续接未发送。',[record]);
    if(!['idle','completed','failed','interrupted','stopped','cancelled','canceled'].includes(String(record.status||'').toLowerCase()))fail('NATIVE_SESSION_BUSY',`会话「${record.title||record.sessionName||target.title||target.sessionId}」${record.status==='unknown'?'运行状态尚未核实':'仍在处理工作'}，本轮保留这个目标，待空闲后继续。`,[record]);
    return {...record,scope:'local',source:target.source||'verified-context',verified:true,...(target.originalRequest?{originalRequest:target.originalRequest}:{})};
  };
  const unique=targets=>[...new Map(targets.map(t=>[`${t.scope||'local'}:${t.deviceId||''}:${t.engine}:${normal(t.sessionId)}`,t])).values()];
  const choose=async targets=>{const values=unique(targets);if(values.length>1)fail('NATIVE_SESSION_AMBIGUOUS',`可续接的会话有：${values.map((v,i)=>`${i+1}. ${v.title||v.sessionId}（${v.engine}）`).join('；')}。你指哪一个？`,values);return values.length?verify(values[0]):null;};
  const named=/(?:会话|对话|session)/iu.test(userText)&&(/(?:继续|开发|修改|修复|实现|查看|历史|进度|读取|发消息|消息)/u.test(userText));
  const query=namedSessionQuery(userText);
  if(named&&query){
    const catalogEngine=explicitEngine||/\b(codex|dsh|workbuddy)\b.{0,30}(?:会话|对话)/iu.exec(userText)?.[1]?.toLowerCase();
    let result;
    if(nativeSessions?.list)result=await nativeSessions.list({...(catalogEngine?{engine:catalogEngine}:{}),query,limit:100});
    else if(nativeTasks?.listSessions&&(!catalogEngine||catalogEngine==='dsh'))result={items:(await nativeTasks.listSessions()).filter(row=>`${row.title} ${row.sessionId}`.includes(query)).map(row=>({...row,engine:'dsh'}))};
    else fail('NATIVE_SESSION_UNVERIFIED','当前原生目录读取入口尚未就绪，保留本轮指定会话，待核对后继续。');
    let candidates=(result.items||[]).filter(item=>userText.includes(item.sessionId)||item.title?.length>=2&&userText.toLocaleLowerCase().includes(item.title.toLocaleLowerCase()));
    if(candidates.length>1){
      // An explicit project/directory distinguishes same-name conversations.
      const inProject=candidates.filter(item=>{
        if(!item.cwd)return false;
        const leaf=basename(item.cwd.replaceAll('\\','/'));
        return leaf.length>=2&&(userText.includes(item.cwd)||new RegExp(leaf.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:项目|目录|文件夹)','u').test(userText));
      });
      if(inProject.length)candidates=inProject;
    }
    if(result.truncated||result.errors?.length)fail('NATIVE_SESSION_CATALOG_INCOMPLETE','原生会话目录尚未完整核对，请明确会话名和引擎；未列出不代表原会话不存在。',candidates);
    if(candidates.length)return choose(candidates.map(c=>({...c,source:'explicit-user-session'})));
    if(query||/(?:在|到|给|向|用|继续).{0,20}(?:会话|对话)|(?:会话|对话)[「《“"']/u.test(userText))fail('NATIVE_SESSION_UNAVAILABLE','没有找到本轮指定的原生会话，请核对会话名或已确认的选择；本轮没有新建替代。');
  }
  if(handoff.requestedSession)return verify(handoff.requestedSession);
  if(independentRequest(userText))return null;
  if(!execute&&!handoff.nativeContinuationTargets?.some(target=>target.source==='user-choice'))return null;
  if(handoff.nativeContinuationTargets?.length)return choose(handoff.nativeContinuationTargets);
  if(handoff.continuationCandidates?.length)fail('NATIVE_SESSION_AMBIGUOUS',`有多个承接对象：${handoff.continuationCandidates.map((t,i)=>`${i+1}. ${t.title||t.goal||t.sessionId}（${t.engine}）`).join('；')}。你指哪个会话？`,handoff.continuationCandidates);
  if(/^\s*(?:继续|接着|再来|继续吧|接着做)[。！!\s]*$/u.test(userText)&&!handoff.previousWork)fail('NATIVE_SESSION_UNANCHORED','这句继续还没有对应到唯一原任务或会话，请告诉我会话名或引用那条结果。');
  return null;
}
