import {supervisorDirective} from './supervisor-progress.mjs';

export function conversationSource(store,task){
 let current=task;
 for(let depth=0;current&&depth<4;depth++){
  if(current.role==='director')return current;
  const row=store.db.prepare("SELECT taskId FROM events WHERE type='director.worker-created' AND json_extract(data,'$.workerId')=? ORDER BY id DESC LIMIT 1").get(current.id);
  current=row?store.task(row.taskId):null;
 }
 return null;
}

/** A coordinator may finish a verified lookup without manufacturing a worker. */
export function orchestrationResult(store,task,text){
 const result=supervisorDirective(text,'[HUB-TOOL-RESULT]');
 if(!result)return null;
 const value=result.value;
 if(!value||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>2400||!['query','submitted','question'].includes(value.kind))throw Error('工具编排回报格式无效');
 const runStart=store.db.prepare("SELECT MAX(id) id FROM events WHERE taskId=? AND type='task.started'").get(task.id)?.id||0;
 const observed=store.db.prepare("SELECT type,data FROM events WHERE taskId=? AND id>? AND type IN ('coordinator.tool-result','coordinator.tool-uncertain') ORDER BY id DESC LIMIT 5").all(task.id,runStart).map(r=>({type:r.type,...JSON.parse(r.data)}));
 if(!observed.length)throw Error('工具编排缺少本轮真实接口结果，不能把文字当成工具成功');
 const latest=observed[0],unconfirmed=latest.type==='coordinator.tool-uncertain'||!latest.ok;
 if(value.kind==='submitted'&&(unconfirmed||latest.method!=='POST'))throw Error('最近的提交结果未确认，不能声称提交成功');
 const evidence=observed;
 const facts={kind:unconfirmed?'question':value.kind,summary:value.summary,evidence,businessCompletion:false,unconfirmed,note:'编排结束不代表后台工作完成；以实际工作终态和平台回执为准。'};
 store.event(task.id,'coordinator.result-verified',{kind:value.kind});
 return JSON.stringify(facts);
}
