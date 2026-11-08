import {workTopicScore,isWorkRecord} from './work-handoff.mjs';
import {redact} from '../redact.mjs';

// Bounded native reference, never appended to the user's original words.
export function fileDeliveryContext(store,text) {
 if(!/(?:发(?:送)?给我|给我发|发我|转发给我|拿给我|(?:截图|图片|文件).{0,6}(?:发来|发过来|给我看看))/u.test(text))return '';
 const cutoff=new Date(Date.now()-86400000).toISOString();
 const rows=store.db.prepare(`SELECT t.id,t.role,t.status,substr(t.prompt,1,1200) prompt,substr(t.result,1,1200) result,t.error FROM tasks t WHERE role='worker' AND updatedAt>?
  AND NOT EXISTS(SELECT 1 FROM events e WHERE e.taskId=t.id AND e.type='task.message-retracted')
  ORDER BY updatedAt DESC LIMIT 20`).all(cutoff)
  .filter(t=>isWorkRecord(t)&&workTopicScore(text,{prompt:t.prompt+' '+(t.result||'')})>=0.15).slice(0,2);
 if(!rows.length)return '';
 const hasArtifacts=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='artifacts' AND type='table'").get();
 const facts=rows.map(t=>({task:t.id,status:t.status,goal:redact(t.prompt).slice(0,120),
  result:redact(t.result||t.error||'尚无结果').slice(0,360),
  files:hasArtifacts?store.db.prepare('SELECT id,name FROM artifacts WHERE task_id=? ORDER BY created_at DESC LIMIT 2').all(t.id):[]}));
 return '内部执行依据，不是对用户的回复文案：用户正在索取已有文件。用hub_work_recall/hub_delivery_status核对以下交付证据，沿原任务取得并发送文件。生成新版本需要用户另有要求。主管是否见过原图与系统能否发图分别核对；历史回执不是本次重发的回执，发送成功须有本轮回执。对用户只自然回应正在找或发送哪份文件，执行规则留在内部。\n'+JSON.stringify(facts).slice(0,1200);
}
