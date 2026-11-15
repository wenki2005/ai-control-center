import {randomUUID} from 'node:crypto';
import {waitingForReply} from './companion-waiting.mjs';
import {redact} from './redact.mjs';
import {conversationSource} from './hub/tool-orchestration.mjs';
import {workPresenceYieldsToReply} from './report-progress.mjs';

const MINUTE=60000;
export class WorkPresence {
 constructor({store,hub,reports,companion,isAvailable=()=>false,now=()=>Date.now(),intervalMs=15000,onChange=()=>{}}){
  Object.assign(this,{store,hub,reports,companion,isAvailable,now,intervalMs,onChange});this.running=false;this.closed=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS work_presence_checks(key TEXT PRIMARY KEY,taskId TEXT NOT NULL,runVersion INTEGER NOT NULL,anchorUserId INTEGER NOT NULL,personaId TEXT,createdAt TEXT NOT NULL,status TEXT NOT NULL); CREATE INDEX IF NOT EXISTS work_presence_created ON work_presence_checks(createdAt);`);
 }
 settings(){let lastDecision=null;try{lastDecision=JSON.parse(this.store.meta('companion:work-presence-last-decision')||'null');}catch{}return {enabled:this.store.meta('companion:work-presence-enabled')!=='false',firstAfterSeconds:90,directorWaitSeconds:45,intervalMinutes:8,maxPerUnansweredTask:3,dailyLimit:12,running:this.running,lastDecision};}
 configure({enabled}={}){if(typeof enabled!=='boolean')throw Error('enabled 必须为布尔值');this.store.meta('companion:work-presence-enabled',String(enabled));this.onChange();return this.settings();}
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>void this.poll(),this.intervalMs);this.timer.unref?.();}
 close(){this.closed=true;clearInterval(this.timer);}
 gate({preferredTask}={}){
  const now=this.now(),s=this.settings(),boundary=waitingForReply(this.store,now);
  if(this.closed||!s.enabled||this.store.meta('companion:proactive-enabled')==='false')return {ready:false,reason:'disabled'};
  if(!this.isAvailable()||this.hub.directMode?.()||this.hub.repairMode?.())return {ready:false,reason:'unavailable'};
  if(boundary.boundary||boundary.quiet||this.hub.screenCompanionActive)return {ready:false,reason:'quiet-or-shared-companionship'};
  const anchorUserId=this.store.db.prepare("SELECT id FROM companion_chat WHERE role='user' AND retractedAt IS NULL ORDER BY id DESC LIMIT 1").get()?.id;
  if(!anchorUserId)return {ready:false,reason:'no-conversation'};
  if(this.store.db.prepare("SELECT 1 FROM approvals WHERE status IN ('pending','resolving') LIMIT 1").get())return {ready:false,reason:'approval-needs-user'};
  if(workPresenceYieldsToReply(this.store,{now}))return {ready:false,reason:'recent-reply'};
  const latest=this.store.db.prepare('SELECT createdAt FROM work_presence_checks ORDER BY createdAt DESC LIMIT 1').get();
  if(latest&&now-Date.parse(latest.createdAt)<s.intervalMinutes*MINUTE)return {ready:false,reason:'cooldown'};
  const day=new Date(now+8*60*MINUTE).toISOString().slice(0,10),since=new Date(day+'T00:00:00+08:00').toISOString();
  if(this.store.db.prepare('SELECT count(*) n FROM work_presence_checks WHERE createdAt>=?').get(since).n>=s.dailyLimit)return {ready:false,reason:'daily-budget'};
  const tasks=preferredTask?[this.store.task(preferredTask.id)]:this.store.db.prepare("SELECT * FROM tasks WHERE status='running' AND role IN ('director','coordinator','worker') AND prompt NOT LIKE '[内部工作回报]%' ORDER BY CASE role WHEN 'director' THEN 0 WHEN 'worker' THEN 1 ELSE 2 END,createdAt LIMIT 12").all();
  for(const task of tasks.filter(Boolean)){
   if(task.status!=='running'||task.engine!=='dsh'&&task.role==='director')continue;
   const source=conversationSource(this.store,task),userOrigin=source&&this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='chat.request'").get(source.id)||this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND type='task.user-origin'").get(task.id);
   if(!userOrigin)continue;
   const start=this.store.db.prepare("SELECT id,createdAt FROM events WHERE taskId=? AND type='task.started' ORDER BY id DESC LIMIT 1").get(task.id);
   if(!start||now-Date.parse(start.createdAt)<(task.role==='director'?s.directorWaitSeconds:s.firstAfterSeconds)*1000)continue;
   if(task.role==='director'&&(String(task.result||'').trim()||this.store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND id>=? AND type='director.ack-delivered'").get(task.id,start.id)))continue;
   const count=this.store.db.prepare('SELECT count(*) n FROM work_presence_checks WHERE taskId=? AND runVersion=? AND anchorUserId=?').get(task.id,task.runVersion,anchorUserId).n;
   if(count>=s.maxPerUnansweredTask)continue;
   if(workPresenceYieldsToReply(this.store,{now,taskId:task.id,runVersion:task.runVersion}))continue;
   const recent=this.store.db.prepare("SELECT type,createdAt,json_extract(data,'$.progress.kind') progressKind,json_extract(data,'$.progress.code') progressCode FROM events WHERE taskId=? AND id>=? AND type IN ('dsh.prompt-received','dsh.model-started','dsh.tool-activity','message','session') ORDER BY id DESC LIMIT 1").get(task.id,start.id);
   if(!recent)continue;
   const key=task.role==='director'&&count===0?`director-wait:${task.id}:${task.runVersion}`:`work-companion:${task.id}:${task.runVersion}:${anchorUserId}:${count}`;
   if(this.store.db.prepare('SELECT 1 FROM work_presence_checks WHERE key=?').get(key))continue;
   const state=now-Date.parse(recent.createdAt)>2*MINUTE?'awaiting-new-evidence':recent.progressKind==='model-retry'?'model-retrying':recent.type==='dsh.tool-activity'?'tool-activity-observed':recent.type==='dsh.model-started'||recent.type==='message'?'model-activity-observed':recent.type==='dsh.prompt-received'?'native-accepted':'session-connected';
   const statements={
    'native-accepted':'原生会话已接收工作请求，正在等待新的进度；仅凭接收无法判断工具或命令是否已经开始。',
    'session-connected':'已经连接原生会话；还没有本轮请求被接收或开始执行的证据。',
    'model-activity-observed':'有模型活动记录，工作尚无最终结果；具体执行步骤和剩余时间未确认。',
    'tool-activity-observed':'有真实工具活动记录，任务尚无最终结果；不能据此推断特定命令仍在运行或剩余时间。',
    'awaiting-new-evidence':'最近没有新的执行证据，任务仍登记为进行中，正在等待新的进度。',
    'model-retrying':recent.progressCode==='RATE_LIMIT'?'刚收到上游限流及重试记录，正在等原请求的新进度。':recent.progressCode==='TIMEOUT'?'刚收到超时及重试记录，正在等原请求的新进度。':'模型请求记录了重试，正在等新进度。'
   };
   return {ready:true,task,key,anchorUserId,personaId:this.store.meta('companion:active-persona-id'),stage:{state,verifiedStatement:statements[state],observedAt:recent.createdAt,startedAt:start.createdAt,sessionName:this.hub.sessionTitleForTask(task)}};
  }
  return {ready:false,reason:'no-long-running-work'};
 }
 async poll(options={}){
  if(this.running||this.closed)return;
  const gate=this.gate(options);if(!gate.ready)return;
  if(this.reports.busy||this.reports.announcementFlights?.size||this.reports.narrator?.pending?.size)return;
  const token=randomUUID(),now=this.now();
  const leased=this.store.transaction(()=>{let lease;try{lease=JSON.parse(this.store.meta('companion:outreach-lease')||'null');}catch{}
   if(lease?.expiresAt>now)return false;
   const claimed=this.store.db.prepare("INSERT OR IGNORE INTO work_presence_checks VALUES(?,?,?,?,?,?,'considering')").run(gate.key,gate.task.id,gate.task.runVersion,gate.anchorUserId,gate.personaId,new Date(now).toISOString());
   if(!claimed.changes)return false;
   this.store.meta('companion:outreach-lease',JSON.stringify({token,kind:'work-companion',expiresAt:now+70000}));return true;
  });if(!leased)return;
  this.running=true;
  const task={...gate.task,result:'',error:'',presenceAnchorUserId:gate.anchorUserId,presencePersonaId:gate.personaId,presence:{...gate.stage,currentTime:new Date(this.now()).toISOString(),timeZone:'Asia/Shanghai'},
   presenceConversation:this.store.db.prepare("SELECT role,substr(text,1,200) text FROM companion_chat WHERE retractedAt IS NULL ORDER BY id DESC LIMIT 5").all().reverse(),presenceTopics:(this.hub.conversation?.topics(now)||[]).slice(0,3).map(t=>({text:t.text,kind:t.kind}))};
  try{
   const text=await this.reports.announce({task,kind:'work-companion',dedupe:gate.key,situation:'工作间隙陪用户随口聊两句。'});
   this.store.db.prepare('UPDATE work_presence_checks SET status=? WHERE key=?').run(text?'queued':'suppressed',gate.key);
   this.store.meta('companion:work-presence-last-decision',JSON.stringify({at:new Date(this.now()).toISOString(),state:text?'queued':'suppressed',stage:gate.stage.state}));
   if(text)this.store.meta('companion:work-presence-last-offered-at',new Date(this.now()).toISOString());
  }catch(error){this.store.db.prepare("UPDATE work_presence_checks SET status='failed' WHERE key=?").run(gate.key);this.store.event(gate.task.id,'companion.work-presence-failed',{error:redact(error.message).slice(0,200)});}
  finally{let lease;try{lease=JSON.parse(this.store.meta('companion:outreach-lease')||'null');}catch{}if(lease?.token===token)this.store.meta('companion:outreach-lease','');this.running=false;this.onChange();}
 }
}
