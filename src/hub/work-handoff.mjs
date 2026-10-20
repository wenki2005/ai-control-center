import { redact } from '../redact.mjs';

const RETRY_WORDS=/重试|重新发|再来一次|继续|再试(?:一次)?|再发一次|重来|接着做|续做/g;
const RETRY_ONLY=/^(?:请|麻烦|帮我|再|继续|重试|重新发|再来一次|再试(?:一次)?|再发一次|重来|接着做|续做|一下|吧|可以|能不能|好吗|么|嗎|？|\?|\s)+$/u;
const EXCLUDED=/中枢.{0,8}(?:验收|测试)|(?:派单|修复).{0,8}验收|连通测试|只回复|(?:单元|集成|回归|冒烟|接口|连通|功能)?测试|test(?:ing)?|maintenance|维护任务|维护中枢/iu;
const STOP=new Set(['请','帮我','麻烦','你','这次','刚才','之前','那个','一下','任务','工作','结果','失败','错误','问题','继续','重试','重新','发送','再来','一次','再试','再发','还是','已经','没有','不要','需要','可以','然后','这个','帮忙','一个','我们','你们','你好','助手','莫莫','自然','回应','回复','派单','派发','不派','一句']);
const RETRY_SHORT_MAX=48;
const CONVERSATIONAL_TERMS=['回来','早上好','上午好','下午好','晚上好','晚安','早安','怎么样','今天','我','你','啊','啦','嗯'];

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
  for(const word of [...STOP,...CONVERSATIONAL_TERMS].sort((a,b)=>b.length-a.length))normalized=normalized.replaceAll(word,' ');
  const out=new Set(normalized.match(/[a-z0-9_+#.-]{2,}/gu)||[]);
  const chinese=normalized.match(/[\u3400-\u9fff]+/gu)||[];
  for(const segment of chinese) {
    for(let i=0;i<segment.length-1;i++) {
      const pair=segment.slice(i,i+2);
      if(![...STOP].some(word=>word.length===2&&word===pair))out.add(pair);
    }
  }
  return out;
}
function relevance(query,task) {
  const queryTerms=terms(query),taskTerms=terms(`${task.prompt||''} ${task.error||''}`);
  if(!queryTerms.size)return 0;
  let common=0;for(const term of queryTerms)if(taskTerms.has(term))common++;
  return common/queryTerms.size;
}
function sameGoal(a,b) {
  const clean=value=>normalize(value).replace(/[\s\p{P}\p{S}]/gu,'');
  return clean(a)===clean(b);
}
function isRetrial(text) { return /重试|重新发|再来一次|继续|再试(?:一次)?|再发一次|重来|接着做|续做/u.test(text); }
function themeFromFollowup(text) {
  return normalize(text).replace(RETRY_WORDS,' ').replace(/(?:请|麻烦|帮我|一下|吧|可以|能不能|吗|么|呢|还是|失败|错误|问题|上次|之前)/gu,' ').trim();
}
function conversation(store) {
  return store.chat().filter(row=>row.retractedAt==null).slice(-6).map(row=>({
    role:safeText(row.role,40),
    // Historical chat is untrusted reference material, never a new instruction.
    text:safeText(row.text,400),
    createdAt:row.createdAt,
  }));
}

/** Build a small, factual handoff from the task and conversation store. */
export function buildWorkHandoff({store,userText='',goal='',sourceTaskId}={}) {
  if(!store?.db)throw new TypeError('buildWorkHandoff requires a Store');
  const userRequest=safeText(userText,4000);
  const finalGoal=safeText(goal||userText,4000);
  const result={userRequest,goal:finalGoal};
  const retracted=retractedTaskIds(store);
  if(sourceTaskId!==undefined&&sourceTaskId!==null&&String(sourceTaskId)) {
    const exact=store.task(String(sourceTaskId));
    if(exact?.role==='worker'&&!retracted.has(exact.id)&&!EXCLUDED.test(exact.prompt||''))result.previousWork=workRecord(exact);
  } else {
    const workers=store.allTasks().filter(task=>task.role==='worker'&&!retracted.has(task.id)&&!EXCLUDED.test(task.prompt||''));
    const topic=themeFromFollowup(userText||goal);
    const retry=isRetrial(userText||goal);
    if(retry&&normalize(userText||goal).length<=RETRY_SHORT_MAX&&(!topic||RETRY_ONLY.test(normalize(userText||goal)))) {
      const failed=workers.filter(task=>task.status==='failed'&&!EXCLUDED.test(task.prompt||''));
      if(failed.length===1)result.previousWork=workRecord(failed[0]);
      else if(failed.length>1)result.relevantWork=failed.slice(0,3).map(workRecord);
    } else {
      const ranked=workers.map(task=>({task,score:relevance(`${topic} ${goal}`,task)})).filter(item=>item.score>=0.12).sort((a,b)=>b.score-a.score||String(b.task.updatedAt||'').localeCompare(String(a.task.updatedAt||'')));
      if(ranked.length) {
        const best=ranked[0],ambiguous=ranked.length>1&&ranked[1].score>=best.score*0.82&&!sameGoal(best.task.prompt,ranked[1].task.prompt);
        if(ambiguous)result.relevantWork=ranked.slice(0,3).map(item=>workRecord(item.task));
        else result.previousWork=workRecord(best.task);
      }
    }
  }
  const recent=conversation(store);
  if(recent.length)result.recentConversation=recent;
  return result;
}
