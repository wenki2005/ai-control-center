import { randomUUID } from 'node:crypto';
import { UsageMetrics } from './usage-metrics.mjs';

const ZONE='Asia/Shanghai';
const dayOf=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
const fields=['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens'];
const roles={director:'交流主管',coordinator:'任务分发',worker:'工作会话',reporter:'结果汇报',narrator:'结果汇报',proactive:'主动联系',news:'新闻分享',diary:'每日记事',cognition:'记忆反思与计划',maintenance:'维护助手',librarian:'资料管理员',direct:'直连会话'};
function number(obj,...keys){for(const key of keys){const v=obj?.[key];if((typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))&&Number(v)>=0)return Number(v);}return null;}
function tokens(raw,engine){
  const input=number(raw,'inputTokens','input_tokens','promptTokens','prompt_tokens');
  const output=number(raw,'outputTokens','output_tokens','completionTokens','completion_tokens');
  const read=number(raw,'cacheReadTokens','cache_read_tokens','cachedInputTokens','cached_input_tokens');
  const write=number(raw,'cacheWriteTokens','cache_write_tokens');
  // DSH reports uncached input separately; Codex input includes cached input.
  const providedTotal=number(raw,'totalTokens','total_tokens');
  const normalizedInput=engine==='dsh'
    ?providedTotal!==null&&output!==null&&providedTotal>=output?providedTotal-output
      :input!==null&&read!==null&&write!==null?input+read+write:null
    :input;
  return {inputTokens:normalizedInput,outputTokens:output,totalTokens:providedTotal??(normalizedInput!==null&&output!==null?normalizedInput+output:null),cacheReadTokens:read,cacheWriteTokens:write};
}
function bucket(){return {entries:0,reliableEntries:0,...Object.fromEntries(fields.map(k=>[k,{total:null,knownEntries:0,unknownEntries:0}]))};}
function add(b,row){b.entries++;b.reliableEntries+=row.reliable?1:0;for(const key of fields){if(row[key]===null)b[key].unknownEntries++;else{b[key].total=(b[key].total??0)+row[key];b[key].knownEntries++;}}}
function dayRange(day){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('日期格式需要 YYYY-MM-DD');
  const start=Date.parse(day+'T00:00:00+08:00');if(!Number.isFinite(start)||dayOf(start)!==day)throw Error('日期无效');
  return {since:new Date(start).toISOString(),until:new Date(start+86400000).toISOString()};
}
function taskRole(task){return /^diary-/.test(task.id)?'diary':/^news-/.test(task.id)?'news':/^proactive-/.test(task.id)?'proactive':task.role||'worker';}

export class DailyTokens {
  constructor({store,now=Date.now}){
    this.store=store;this.db=store.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS token_runs(id TEXT PRIMARY KEY,taskId TEXT,engine TEXT NOT NULL,role TEXT NOT NULL,sessionId TEXT,title TEXT NOT NULL,startedAt TEXT NOT NULL,endedAt TEXT,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS token_ledger(id TEXT PRIMARY KEY,runId TEXT NOT NULL,engine TEXT NOT NULL,role TEXT NOT NULL,sessionId TEXT,title TEXT NOT NULL,model TEXT,
      usageAt TEXT NOT NULL,observedAt TEXT NOT NULL,reliable INTEGER NOT NULL,inputTokens REAL,outputTokens REAL,totalTokens REAL,cacheReadTokens REAL,cacheWriteTokens REAL);
      CREATE INDEX IF NOT EXISTS token_ledger_date ON token_ledger(usageAt);
      CREATE INDEX IF NOT EXISTS token_runs_date ON token_runs(startedAt);
      CREATE INDEX IF NOT EXISTS token_ledger_run ON token_ledger(runId);`);
    if(!store.meta('tokens:collection-started-at'))store.meta('tokens:collection-started-at',new Date(now()).toISOString());
  }
  wrap(adapters){
    for(const [engine,adapter] of Object.entries(adapters)){
      if(typeof adapter?.start!=='function')continue;
      const original=adapter.start.bind(adapter);
      adapter.start=async(task,onEvent)=>{
        const run=randomUUID(),role=taskRole(task),title=String(task.displayTitle||`${engine.toUpperCase()} · ${roles[role]||'工作会话'}`).slice(0,120);
        let sessionId=task.sessionId||null;
        let tracking=true;
        try{this.db.prepare('INSERT INTO token_runs VALUES(?,?,?,?,?,?,?,?,?)').run(run,task.id||null,engine,role,sessionId,title,new Date(this.now()).toISOString(),null,'running');}catch{tracking=false;}
        const observe=event=>{
          if(!tracking)return onEvent(event);
          try{
            if(event.type==='session'&&event.sessionId){sessionId=event.sessionId;this.db.prepare('UPDATE token_runs SET sessionId=? WHERE id=?').run(sessionId,run);}
            if(event.usage){
              const value=tokens(event.usage,engine);
              const id=event.usageId?`${engine}:${sessionId||''}:${event.usageId}`:`unidentified:${run}:${randomUUID()}`;
              const when=event.usageAt&&Number.isFinite(Date.parse(event.usageAt))?new Date(event.usageAt).toISOString():new Date(this.now()).toISOString();
              this.db.prepare(`INSERT INTO token_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                inputTokens=COALESCE(excluded.inputTokens,token_ledger.inputTokens),outputTokens=COALESCE(excluded.outputTokens,token_ledger.outputTokens),
                totalTokens=COALESCE(excluded.totalTokens,token_ledger.totalTokens),cacheReadTokens=COALESCE(excluded.cacheReadTokens,token_ledger.cacheReadTokens),
                cacheWriteTokens=COALESCE(excluded.cacheWriteTokens,token_ledger.cacheWriteTokens),observedAt=excluded.observedAt`)
                .run(id,run,engine,role,sessionId,title,event.model||task.model||null,when,new Date(this.now()).toISOString(),event.usageId?1:0,...fields.map(k=>value[k]));
            }
            if(['completed','failed'].includes(event.type))this.db.prepare('UPDATE token_runs SET endedAt=?,status=? WHERE id=?').run(new Date(this.now()).toISOString(),event.type,run);
          }catch(error){try{this.store.event(null,'tokens.capture-failed',{message:String(error.message).slice(0,160)});}catch{/* Tracking never breaks the conversation. */}}
          return onEvent(event);
        };
        try{return await original(task,observe);}catch(error){try{if(tracking)this.db.prepare("UPDATE token_runs SET endedAt=?,status='failed' WHERE id=?").run(new Date(this.now()).toISOString(),run);}catch{}throw error;}
      };
    }
  }
  settings(){return {dailyBudget:Number(this.store.meta('tokens:daily-budget')||0),timeZone:ZONE,collectionStartedAt:this.store.meta('tokens:collection-started-at')};}
  configure({dailyBudget}){const value=Number(dailyBudget);if(!Number.isSafeInteger(value)||value<0||value>1000000000)throw Error('每日提醒线需要是 0—10亿的整数，0 表示关闭');this.store.meta('tokens:daily-budget',String(value));return this.settings();}
  snapshot(day=dayOf(this.now())){
    const {since,until}=dayRange(day),totals=bucket(),groups=new Map(),sessions=new Map();
    for(const row of this.db.prepare('SELECT * FROM token_ledger WHERE usageAt>=? AND usageAt<? ORDER BY usageAt,id').iterate(since,until)){
      add(totals,row);const groupKey=`${row.engine}:${row.role}`,sessionKey=`${row.engine}:${row.sessionId||row.title}`;
      if(!groups.has(groupKey))groups.set(groupKey,{engine:row.engine,role:roles[row.role]||row.role,...bucket()});add(groups.get(groupKey),row);
      if(!sessions.has(sessionKey))sessions.set(sessionKey,{name:row.title,engine:row.engine,...bucket()});add(sessions.get(sessionKey),row);
    }
    const coverage=this.db.prepare(`SELECT COUNT(*) runs,SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM token_ledger l WHERE l.runId=r.id) THEN 1 ELSE 0 END) withoutUsage,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failedRuns FROM token_runs r WHERE startedAt>=? AND startedAt<?`).get(since,until);
    const historySince=new Date(Date.parse(since)-6*86400000).toISOString();
    const history=this.db.prepare(`SELECT substr(datetime(usageAt,'+8 hours'),1,10) day,COUNT(*) entries,SUM(totalTokens) totalTokens,
      SUM(CASE WHEN totalTokens IS NULL THEN 1 ELSE 0 END) unknownEntries FROM token_ledger WHERE usageAt>=? AND usageAt<? GROUP BY day ORDER BY day`).all(historySince,until);
    const settings=this.settings(),amount=totals.totalTokens.total;
    const legacyEnd=Math.min(Date.parse(until),Date.parse(settings.collectionStartedAt),this.now());
    let historicalReference=null;
    if(legacyEnd>Date.parse(since)){
      const old=new UsageMetrics({db:this.db,now:()=>legacyEnd}).snapshot({windowMs:legacyEnd-Date.parse(since)});
      const known=old.usage.map(x=>x.tokens.totalTokens.total).filter(x=>x!==null);
      historicalReference={totalTokens:known.length?known.reduce((a,b)=>a+b,0):null,entries:old.usage.reduce((n,x)=>n+x.events,0),truncated:old.sample?.truncated||false,
        note:'采集启用前的旧日志参考，可能含重放和遗漏，不计入上方新账本总量；不能与新账本直接相加。'};
    }
    return {date:day,timeZone:ZONE,window:{since,until,boundary:'左闭右开'},settings,totals,
      groups:[...groups.values()].sort((a,b)=>(b.totalTokens.total||0)-(a.totalTokens.total||0)),
      sessions:[...sessions.values()].sort((a,b)=>(b.totalTokens.total||0)-(a.totalTokens.total||0)),history,coverage,historicalReference,
      budget:{limit:settings.dailyBudget,exceeded:settings.dailyBudget>0&&amount!==null&&amount>=settings.dailyBudget},
      scope:'仅统计经过本机中枢适配器的调用，包含主动消息、新闻、日记和结果汇报；不代表整个 DSH、Codex 账号或此修复对话的总消耗。',
      quality:{unidentifiedEntries:totals.entries-totals.reliableEntries,unknownIsZero:false,cacheIncludedInInput:true,note:'按真实引擎用量回传统计；缓存已包含在输入中，不重复加到总量，不换算账单价格。缺失回传和不带可靠标识的条目会标出。采集开始前的数据不混入新账本。'}};
  }
  markdown(day){const data=this.snapshot(day),count=v=>v===null?'未知':Number(v).toLocaleString('zh-CN');return `# 每日 Token 用量 · ${data.date}\n\n时区：上海\n\n${data.scope}\n\n- 总量：${count(data.totals.totalTokens.total)}\n- 输入（含缓存）：${count(data.totals.inputTokens.total)}\n- 输出：${count(data.totals.outputTokens.total)}\n- 缓存命中：${count(data.totals.cacheReadTokens.total)}\n- 未提供用量的运行尝试：${data.coverage.withoutUsage||0}\n\n## 会话消耗\n\n${data.sessions.map(s=>`- ${s.name.replace(/[\r\n]/g,' ')}：${count(s.totalTokens.total)} Token`).join('\n')||'尚无已采集用量。'}\n\n${data.quality.note}\n`;}
}
