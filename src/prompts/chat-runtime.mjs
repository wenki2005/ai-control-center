/** A bounded handoff index, not another copy of task results or chat history. */
export function compactNativeHandoff(payload={}){
  const tasks=(payload.tasks||[]).filter(x=>x.role==='worker'&&['queued','running','waiting'].includes(x.status)).slice(0,3);
  const choices=(payload.answeredChoices||[]).slice(0,2);
  return [
    tasks.length?'仍在处理：'+tasks.map(t=>`${t.id} ${String(t.prompt||'').slice(0,90)}（${t.status}；查hub_work_recall，勿重复派单）`).join('；'):'',
    choices.length?'已答选择：'+choices.map(x=>`${String(x.question||'').slice(0,70)}→${String(x.answer||'').slice(0,70)}`).join('；'):'',
    payload.reason==='reply-timeout'?'前轮可能存在已执行操作，先核对状态，不重放原任务。':''
  ].filter(Boolean).join('\n').slice(0,650);
}
