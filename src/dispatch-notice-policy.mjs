/** Routing details remain in task cards/events, rather than a second chat reply. */
export function routineDispatchKey(key='') {
  return /^coordinator-(?:dispatched|recovered)(?:-fallback)?:/u.test(String(key));
}

/** Applied only to dispatch acknowledgements, never ordinary answers about routing. */
export function dispatchConversationText(text='') {
  return String(text).split(/(?<=[。！？!?])|\n/u).map(sentence=>{
    if(!/(?:固定(?:工作)?会话\s*[\d一二三]*|二级(?:主管|协调)(?:会话)?)/u.test(sentence)||!/(?:交给|交由|安排|派给|派发|接手)/u.test(sentence))return sentence;
    const index=sentence.search(/(?:我(?:已经|已)?|已经|已|任务(?:已经|已)?)?(?:交给|交由|派给|派发)|已由/u);
    const before=sentence.slice(0,Math.max(0,index));
    return index>0&&/[，、；：]\s*$/u.test(before)?before.replace(/[，、；：\s]+$/u,'')+'。':'';
  }).join('').trim();
}
