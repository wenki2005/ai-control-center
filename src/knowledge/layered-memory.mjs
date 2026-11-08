import {DatabaseSync} from 'node:sqlite';
import {companionFtsQuery} from '../companion-search.mjs';
import {sentNotifications} from './notification-context.mjs';

export const MEMORY_LAYERS=Object.freeze([
  {id:'identity',source:'项目人设文档',policy:'启动及版本变化时读取，与用户事实分离'},
  {id:'semantic',source:'companion_facts / companion_memories',policy:'仅已确认事实，保留来源及更正历史'},
  {id:'episodic',source:'companion_chat / timeline_entries',policy:'按需检索真实原话，排除修复和撤回内容'},
  {id:'work',source:'tasks / artifacts',policy:'通过 hub_work_recall 查询，按任务原会话续接'},
  {id:'reflection',source:'companion_reflections',policy:'推论保留证据及置信度，不提升为用户事实'}
]);
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const normalized=text=>String(text).toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
export const expandMemoryQuery=query=>String(query).replace(/(?:哪里|哪儿|在哪).{0,4}(?:工作|上班)|工作单位|公司|任职|就职|供职|谋生|雇主|打卡的地方/gu,'工作 单位 公司 任职 就职 供职');

/** Read existing canonical stores. No model calls, copied histories, or fact rewrites. */
export function retrieveLayeredMemory(database,query='',limit=12,{now=Date.now(),maxChars=4200,layer='all'}={}){
  const db=new DatabaseSync(database,{readOnly:true});
  try{
    const has=name=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
    const facts=has('companion_facts')?db.prepare("SELECT key,value,source,validFrom,updatedAt FROM companion_facts WHERE status='active' ORDER BY updatedAt DESC").all().filter(f=>!Number.isFinite(Date.parse(f.validFrom))||Date.parse(f.validFrom)<=now):[];
    const memories=has('companion_memories')?db.prepare("SELECT text,source,updatedAt FROM companion_memories WHERE status='active' ORDER BY updatedAt DESC").all():[];
    const expanded=expandMemoryQuery(query);
    const tokens=companionFtsQuery(expanded).match(/"([^"]+)"/g)?.map(x=>x.slice(1,-1))||[];
    const score=text=>tokens.reduce((sum,t)=>sum+(String(text).toLowerCase().includes(t)?t.length:0),0);
    const explicit=/\b(20\d{2}-\d{2}-\d{2})\b/u.exec(query)?.[1];
    const targetDay=explicit&&Number.isFinite(Date.parse(explicit))?explicit:/今天|今早|今晨|今日/u.test(query)?day(now):/昨天|昨晚/u.test(query)?day(now-86400000):null;
    let episodes=[];
    if(query&&has('companion_chat')){
      const columns=new Set(db.prepare('PRAGMA table_info(companion_chat)').all().map(x=>x.name));
      const visible=columns.has('retractedAt')?'AND c.retractedAt IS NULL':'';
      const match=companionFtsQuery(query);
      if(match&&has('companion_chat_fts'))episodes=db.prepare(`SELECT c.id,c.text,c.createdAt FROM companion_chat_fts JOIN companion_chat c ON c.id=companion_chat_fts.rowid WHERE companion_chat_fts MATCH ? AND c.role='user' ${visible} ORDER BY bm25(companion_chat_fts),c.id DESC LIMIT 120`).all(match);
      // Date requests include that day's events even when the exact words differ.
      if(targetDay)episodes.push(...db.prepare(`SELECT c.id,c.text,c.createdAt FROM companion_chat c WHERE c.role='user' ${visible} AND c.createdAt>=? AND c.createdAt<? ORDER BY c.id DESC LIMIT 300`).all(new Date(Date.parse(targetDay+'T00:00:00+08:00')).toISOString(),new Date(Date.parse(targetDay+'T00:00:00+08:00')+86400000).toISOString()));
      else if(!has('companion_chat_fts'))episodes=db.prepare(`SELECT c.id,c.text,c.createdAt FROM companion_chat c WHERE c.role='user' ${visible} ORDER BY c.id DESC LIMIT 1000`).all();
      episodes=episodes.filter(e=>Date.parse(e.createdAt)<=now&&(!targetDay||day(e.createdAt)===targetDay));
    }
    const timeline=query&&has('timeline_entries')?db.prepare("SELECT title,text,occurredAt,recordedAt,dateBasis,sourceLabel FROM timeline_entries WHERE active=1 AND (sourceKind IN ('note','note-file') OR (sourceKind='fact' AND sourceLabel LIKE '历史事实%')) ORDER BY occurredAt DESC LIMIT 1000").all().filter(t=>!targetDay||(t.occurredAt&&day(t.occurredAt)===targetDay)):[];
    const reflections=layer==='reflection'&&has('companion_reflections')?db.prepare('SELECT text,evidence,confidence,createdAt FROM companion_reflections ORDER BY createdAt DESC LIMIT 100').all().map(r=>({text:r.text,source:'反思（推论，非用户事实）',evidence:String(r.evidence||'').slice(0,600),confidence:r.confidence,savedAt:r.createdAt,kind:'reflection',layer:'reflection'})):[];
    const notifications=query&&['all','episodic'].includes(layer)?sentNotifications(db,{query,limit:8,now}).filter(n=>!targetDay||day(n.savedAt)===targetDay):[];
    const rows=[...notifications,...reflections,...facts.map(f=>({text:`${f.key}：${f.value}`,source:f.source||'用户事实',savedAt:f.updatedAt,validFrom:f.validFrom,kind:'fact',layer:'semantic'})),
      ...memories.map(m=>({text:m.text,source:m.source||'共用记忆',savedAt:m.updatedAt,kind:'memory',layer:'semantic'})),
      ...timeline.map(t=>({text:`${t.occurredAt||'日期未确定'}（${t.dateBasis}）：${t.title}；${t.text}`,source:t.sourceLabel,savedAt:t.recordedAt,kind:'timeline',layer:'episodic'})),
      ...episodes.map(e=>({text:`用户原话：${e.text}`,source:`真实聊天 #${e.id}`,savedAt:e.createdAt,validFrom:e.createdAt,kind:'episode',layer:'episodic'}))];
    const seen=new Set();let used=0;
    const matches=rows.filter(r=>layer==='all'||r.layer===layer).map((r,index)=>({...r,index,rank:score(r.text)+(targetDay&&r.kind==='episode'?2:0)+(!query&&r.kind==='fact'&&/工作|单位|公司|称呼|姓名|生日|住址|偏好/.test(r.text)?3:0)})).filter(r=>!query||r.rank>0)
      .sort((a,b)=>b.rank-a.rank||(a.kind==='fact'?-1:b.kind==='fact'?1:0)||a.index-b.index)
      .filter(r=>{const key=normalized(r.text.replace(/^用户原话：/,''));if(seen.has(key))return false;seen.add(key);return true;})
      .slice(0,Math.max(1,Math.min(20,Math.floor(Number(limit)||12))))
      .map(({index,rank,...r})=>({...r,text:r.text.slice(0,420)})).filter(r=>{const size=r.text.length+String(r.source).length+100;if(used+size>maxChars)return false;used+=size;return true;});
    return {source:'AI 中枢分层共用记忆（不含 DS Bot 团队记忆）',facts:facts.length,memories:memories.length,timeline:timeline.length,matches,layers:MEMORY_LAYERS,budget:{maxChars,usedChars:used},dateScope:targetDay};
  }finally{db.close();}
}
