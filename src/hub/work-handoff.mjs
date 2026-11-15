import { redact } from '../redact.mjs';
import {adjacentContinuationContext,continuationRequested,independentRequest} from '../routing/session-continuation.mjs';

const RETRY_WORDS=/重试|重新发|再来一次|继续|再试(?:一次)?|再发一次|重来|接着做|续做/g;
// Exclude recognizable probes, not real user work merely containing “测试”.
const EXCLUDED=/^\s*(?:Internal reliability acceptance\.|\[(?:中枢|连接|表情|每日\s*Token).{0,24}(?:验收|接入检查|连通测试)\]|(?:请)?只(?:需)?回复|(?:中枢|中控).{0,8}(?:自动测试|验收)|连通测试[：:])/iu;
const STOP=new Set(['请','帮我','麻烦','你','这次','刚才','之前','那个','一下','任务','工作','结果','失败','错误','问题','继续','重试','重新','发送','再来','一次','再试','再发','还是','已经','没有','不要','需要','可以','然后','这个','帮忙','一个','我们','你们','你好','助手','莫莫','自然','回应','回复','派单','派发','不派','一句']);
const CONVERSATIONAL_TERMS=['回来','早上好','上午好','下午好','晚上好','晚安','早安','怎么样','今天','我','你','啊','啦','嗯'];
const NOISE_WORDS=[...STOP,...CONVERSATIONAL_TERMS].sort((a,b)=>b.length-a.length);
const STOP_PAIRS=new Set([...STOP].filter(word=>word.length===2));

function safeText(value,limit=20_000) {
  return redact(String(value??'')).slice(0,limit);
}
function retractedTaskIds(store) {
  return new Set(store.db.prepare("SELECT DISTINCT taskId FROM events WHERE type='task.message-retracted' AND taskId IS NOT NULL").all().map(row=>row.taskId));
}
function workRecord(task) {
  return {
    taskId:task.id,
    engine:task.engine,
    sessionId:task.sessionId||null,
    cwd:task.cwd||null,
    goal:safeText(task.prompt,2000),
    status:task.status,
    result:safeText(task.result,1600),
    error:safeText(task.error,500),
  };
}
function normalize(text) {
  return safeText(text).toLocaleLowerCase('zh-CN').replace(/https?:\/\/\S+/g,' ').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu,' email ');
}
function terms(text) {
  // Match subject terms, not generic request words or individual characters
  // such as 任/务 that occur in almost every historical task.
  let normalized=normalize(text);
  for(const word of NOISE_WORDS)normalized=normalized.replaceAll(word,' ');
  const out=new Set(normalized.match(/[a-z0-9_+#.-]{2,}/gu)||[]);
  const chinese=normalized.match(/[\u3400-\u9fff]+/gu)||[];
  for(const segment of chinese) {
    for(let i=0;i<segment.length-1;i++) {
      const pair=segment.slice(i,i+2);
      if(!STOP_PAIRS.has(pair))out.add(pair);
    }
  }
  return out;
}
function relevance(query,task) {
  return createWorkTopicScorer(query)(task);
}
export function createWorkTopicScorer(query){
 const queryTerms=terms(query);
 return task=>{
  if(!queryTerms.size)return 0;
  const taskTerms=terms(`${task.prompt||''} ${task.error||''}`);
  let common=0;for(const term of queryTerms)if(taskTerms.has(term))common++;
  return common/queryTerms.size;
 };
}
export function workTopicScore(query,task){return relevance(query,task);}
export function isWorkRecord(task){return task?.role==='worker'&&!EXCLUDED.test(task.prompt||'');}
function isRetrial(text) { return /重试|重新发|再来一次|继续|再试(?:一次)?|再发一次|重来|接着做|续做/u.test(text); }
function themeFromFollowup(text) {
  return normalize(text).replace(RETRY_WORDS,' ').replace(/(?:请|麻烦|帮我|一下|吧|可以|能不能|吗|么|呢|还是|失败|错误|问题|上次|之前)/gu,' ').trim();
}
/** Build a small, factual handoff from the task and conversation store. */
export function buildWorkHandoff({store,userText='',goal='',sourceTaskId,currentTaskId,referencedTaskIds=[],referencedNativeSessions=[]}={}) {
  if(!store?.db)throw new TypeError('buildWorkHandoff requires a Store');
  const userRequest=safeText(userText,4000);
  const finalGoal=safeText(goal||userText,4000);
  const result={userRequest,goal:finalGoal,...(independentRequest(userText)?{independent:true}:{})};
  const retractedIds=retractedTaskIds(store);
  const eligible=task=>isWorkRecord(task)&&!retractedIds.has(task.id)&&!store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.stop-requested' LIMIT 1").get(task.id);
  const adjacent=currentTaskId?adjacentContinuationContext(store,userText,{currentTaskId}):null;
  const referenceIds=referencedTaskIds.length?referencedTaskIds:adjacent?.taskIds||[];
  const referenced=referenceIds.map(id=>store.task(id)).filter(eligible);
  const references=[...new Map(referenced.map(task=>[`${task.engine}:${task.sessionId||task.id}`,task])).values()];
  if(!result.independent&&(continuationRequested(userText)||adjacent?.nativeTarget)){
    const native=referencedNativeSessions.length?referencedNativeSessions:adjacent?.nativeTarget?[adjacent.nativeTarget]:adjacent?.nativeTargets||[];
    if(native.length)result.nativeContinuationTargets=native.map(target=>({...target,source:target.source||'verified-adjacent-native-read'}));
    if(references.length===1)result.previousWork=workRecord(references[0]);
    else if(references.length>1)result.continuationCandidates=references.map(task=>({...workRecord(task),title:task.prompt.slice(0,80),source:'canonical-dialogue-chain'}));
  }
  if(sourceTaskId!==undefined&&sourceTaskId!==null&&String(sourceTaskId)) {
    const retracted=retractedTaskIds(store);
    const exact=store.task(String(sourceTaskId));
    if(!result.independent&&eligible(exact))result.previousWork=workRecord(exact);
  } else if(!result.independent&&!result.previousWork&&!result.nativeContinuationTargets&&!result.continuationCandidates) {
    const topic=themeFromFollowup(userText||goal);
    const retry=isRetrial(userText||goal);
    if(retry&&topic) {
      const retracted=retractedTaskIds(store);
      const cutoff=new Date(Date.parse(store.now())-2*3600000).toISOString();
      const workers=store.db.prepare("SELECT id,role,engine,sessionId,prompt,error,updatedAt FROM tasks WHERE role='worker' AND updatedAt>=? ORDER BY createdAt DESC").all(cutoff).filter(task=>!retracted.has(task.id)&&eligible(task));
      const scoreTopic=createWorkTopicScorer(topic);
      const ranked=workers
        .map(task=>({task,score:scoreTopic(task)}))
        .filter(item=>item.score>=0.55)
        .sort((a,b)=>b.score-a.score||String(b.task.updatedAt||'').localeCompare(String(a.task.updatedAt||'')));
      const distinct=new Map();for(const item of ranked){const key=`${item.task.engine}:${item.task.sessionId||item.task.id}`;if(!distinct.has(key))distinct.set(key,item);}
      const contexts=[...distinct.values()]
        .sort((a,b)=>b.score-a.score||String(b.task.updatedAt||'').localeCompare(String(a.task.updatedAt||'')));
      // Continue only a clear subject match; unrelated/vague retries are not
      // forced into whichever worker happened to run last.
      if(contexts.length===1)result.previousWork=workRecord(store.task(contexts[0].task.id));
      else if(contexts.length>1)result.continuationCandidates=contexts.map(({task})=>({...workRecord(store.task(task.id)),title:task.prompt.slice(0,80),source:'recent-topic-candidate'}));
    }
  }
  return result;
}
