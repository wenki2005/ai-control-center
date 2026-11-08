/** Accept the compact observer contract and known structured visual responses.
 * Never turn arbitrary JSON or inferred context into a successful observation. */
export function parseScreenObservationResult(text){
 const parsed=JSON.parse(String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('屏幕观察摘要格式无效');
 let summary=typeof parsed.summary==='string'?parsed.summary:typeof parsed.observation?.summary==='string'?parsed.observation.summary:null;
 if(summary===null&&parsed.state_summary&&typeof parsed.state_summary==='object'){
  const state=parsed.state_summary;
  const details=[typeof state.activeApp==='string'&&state.activeApp.trim()?'当前应用：'+state.activeApp.slice(0,300):'',typeof state.pageState==='string'&&state.pageState.trim()?'可见页面状态：'+state.pageState.slice(0,600):'',typeof state.assistantState==='string'&&state.assistantState.trim()?'可见工作状态：'+state.assistantState.slice(0,300):''].filter(Boolean);
  // pageState is an observed fact, inferredContext is deliberately excluded.
  if(details.length)summary=details.join('。');
 }
 if(typeof summary!=='string'||!summary.trim()||summary.length>1600)throw Error('屏幕观察摘要格式无效');
 return {summary:summary.trim(),changed:parsed.changed===true||(!('changed'in parsed)&&Array.isArray(parsed.screen?.changeVsPrevious)&&parsed.screen.changeVsPrevious.length>0),worthSharing:parsed.worthSharing===true,contentKind:['game','work','other','self-ui','sensitive'].includes(parsed.contentKind)?parsed.contentKind:'other'};
}
