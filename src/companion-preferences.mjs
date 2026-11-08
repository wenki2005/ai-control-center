import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const TOPICS={AI:['AI','人工智能','大模型','智能体','开源项目'],科技:['科技','科学'],编程:['编程','开发工具','软件开发'],求职:['求职','招聘','就业','找工作','面试'],游戏:['游戏','游戏','明日方舟'],数码:['数码','电脑硬件','显卡'],财经:['财经','股票','金融'],国际:['国际局势','国际新闻','时政'],娱乐:['娱乐','八卦'],生活:['生活资讯','美食','旅行'],校园:['校园生活','校园时代'],动漫:['动漫','动画','败犬女主','路人女主'],音乐:['音乐','钢琴','弦乐']};
const NEG=/(?:不喜欢|不感兴趣|没兴趣|别再|不要再|不用再|少推|少发|不想看|别推|不要推|不要发|别发)/u;
const POS=/(?:我.{0,4}喜欢|我感兴趣|我关注|我想多看|多推|多发|优先推|多分享|更关注|希望多看)/u;
const topicMatch=(text,alias)=>/^[a-z]+$/i.test(alias)?new RegExp('\\b'+alias+'\\b','i').test(text):text.includes(alias);

/** A derived preference index. Every effective item must still have a live
 * user quotation; retractions/exclusions immediately invalidate its evidence. */
export class PreferenceLearning {
 constructor({store,root=null}){this.store=store;this.root=root;store.db.exec(`CREATE TABLE IF NOT EXISTS companion_preferences(chatId INTEGER,domain TEXT,topic TEXT,value TEXT,quote TEXT,createdAt TEXT,PRIMARY KEY(chatId,domain,topic));
 CREATE TABLE IF NOT EXISTS companion_news_choices(url TEXT,key TEXT,createdAt TEXT,PRIMARY KEY(url,key));`);
 if(store.meta('preferences:index-version')!=='2'){store.db.exec('DELETE FROM companion_preferences');store.meta('preferences:chat-cursor','0');store.meta('preferences:index-version','2');}
 }
 observe({chatId,text,replyIds=[]}){
  const row=this.store.db.prepare("SELECT text,createdAt FROM companion_chat WHERE id=? AND role='user' AND retractedAt IS NULL").get(chatId);if(!row)return;
  const source=String(text??row.text);if(!row.text.includes(source))return;
  if(/这[个条类种]|这种/u.test(source)&&(NEG.test(source)||/多来点|多分享/u.test(source))){
   let previous;
   if(replyIds.length)previous=this.store.db.prepare("SELECT o.text,o.dedupe,o.updatedAt FROM qq_delivery_attempts a JOIN outbox o ON o.id=a.outboxId WHERE a.platformMessageId=? AND a.status='sent' ORDER BY a.finishedAt DESC LIMIT 1").get(String(replyIds[0]));
   else previous=this.store.db.prepare("SELECT text,dedupe,updatedAt FROM outbox WHERE status='sent' ORDER BY updatedAt DESC,rowid DESC LIMIT 1").get();
   if(previous?.dedupe.startsWith('companion-news:')&&Date.parse(this.store.now())-Date.parse(previous.updatedAt)<2*3600000){const topics=Object.entries(TOPICS).filter(([,aliases])=>aliases.some(a=>topicMatch(previous.text,a))).map(([t])=>t);if(topics.length===1)this.#save(chatId,'news',topics[0],NEG.test(source)?'exclude':'prefer',source,row.createdAt);}
  }
  // Preserve explicit interests whose examples follow a comma, e.g.
  // “我其实很喜欢，比如说，败犬女主…”. Mixed positive/negative clauses
  // remain separate below so one correction cannot invert another topic.
  for(const sentence of source.split(/[。！!？?；;\n]/u))if(POS.test(sentence)&&!NEG.test(sentence)&&!/(?:假如|假设|测试|验收|提示词|他说|她说|你说|中枢|修复|报错)/u.test(sentence))for(const [topic,aliases]of Object.entries(TOPICS))if(aliases.some(a=>topicMatch(sentence,a)))this.#save(chatId,'news',topic,'prefer',sentence,row.createdAt);
  for(const part of source.split(/[。！!？?；;，,\n]/u)){
   if(/假如|假设|例如|比如说|举例|测试|验收|提示词|指令注入|他说|她说|你说|文档里|资料里/u.test(part))continue;
   const newsContext=/新闻|资讯|报道|动态|推送|多推|少推/u.test(part);
   const systemContext=/中枢|人设|修复|报错|权限|派单|语气|回复/u.test(part);
   if((newsContext||!systemContext)&&(POS.test(part)||NEG.test(part))){
    const found=Object.entries(TOPICS).filter(([,aliases])=>aliases.some(a=>topicMatch(part,a))).map(([topic])=>topic);
    for(const topic of found)this.#save(chatId,'news',topic,NEG.test(part)?'exclude':'prefer',part,row.createdAt);
    if(!found.length){const custom=/(?:多推|多分享|更关注|别推|不要再推|少推)(?:送)?\s*(?:关于)?([\p{Script=Han}a-zA-Z0-9+.# -]{2,18}?)(?:相关|方面|的新闻|新闻|资讯)/u.exec(part)?.[1]?.trim();if(custom)this.#save(chatId,'news',custom,NEG.test(part)?'exclude':'prefer',part,row.createdAt);}
   }
   const styles=[['length','short',/(?:回复|回答|说话|消息).{0,10}(?:短一点|简短|别太长|不要太长)|别.{0,4}长篇/u],['length','detailed',/(?:回复|回答|解释).{0,8}(?:详细一点|展开一点|多说一点)/u],['tone','casual',/(?:说话|回复|语气).{0,10}(?:口语|自然|随意)|不要.{0,4}客服腔/u],['tone','formal',/(?:说话|回复|语气).{0,10}(?:正式一点|严肃一点)/u]];
   for(const [topic,value,re] of styles)if(re.test(part))this.#save(chatId,'style',topic,value,part,row.createdAt);
  }
  this.sync();
 }
 #save(chatId,domain,topic,value,quote,createdAt){this.store.db.prepare('INSERT INTO companion_preferences VALUES(?,?,?,?,?,?) ON CONFLICT(chatId,domain,topic) DO UPDATE SET value=excluded.value,quote=excluded.quote').run(chatId,domain,topic,value,quote.slice(0,200),createdAt);}
 reconcile({limit=500}={}){let cursor=Number(this.store.meta('preferences:chat-cursor')||0);const rows=this.store.db.prepare("SELECT id,text FROM companion_chat WHERE id>? AND role='user' AND retractedAt IS NULL ORDER BY id LIMIT ?").all(cursor,limit);
  // Defer document sync to the end of this local batch.
  const root=this.root;this.root=null;try{for(const r of rows){this.observe({chatId:r.id,text:r.text});cursor=r.id;}
   // Confirmed memories can point back to older quotations beyond the cursor.
   if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='companion_memories'").get())for(const m of this.store.db.prepare("SELECT source FROM companion_memories WHERE status='active' AND source LIKE '%chat%' LIMIT 300").all()){const id=/chat[:=]?(\d+)/u.exec(m.source||'')?.[1];if(id)this.observe({chatId:Number(id)});}
   this.store.meta('preferences:chat-cursor',String(cursor));}finally{this.root=root;}this.sync();return {processed:rows.length};
 }
 profile(){const rows=this.store.db.prepare("SELECT p.* FROM companion_preferences p JOIN companion_chat c ON c.id=p.chatId WHERE c.role='user' AND c.retractedAt IS NULL AND instr(c.text,p.quote)>0 ORDER BY p.chatId DESC").all(),latest=new Map();for(const r of rows){const k=r.domain+':'+r.topic;if(!latest.has(k))latest.set(k,r);}const current=[...latest.values()];return {topics:current.filter(r=>r.domain==='news'&&r.value==='prefer').map(r=>r.topic).slice(0,8),excludedTopics:current.filter(r=>r.domain==='news'&&r.value==='exclude').map(r=>r.topic).slice(0,8),style:Object.fromEntries(current.filter(r=>r.domain==='style').map(r=>[r.topic,r.value])),evidence:current.map(({chatId,domain,topic,value,quote})=>({chatId,domain,topic,value,quote}))};}
 guide(){const p=this.profile(),labels={short:'回复通常简短，复杂任务按需展开',detailed:'有用的解释可以展开',casual:'说话自然口语，避免客服腔',formal:'当前偏好更正式的表达'};return Object.values(p.style).map(v=>labels[v]).filter(Boolean).join('；').slice(0,160);}
 newsGuide(){const p=this.profile();return JSON.stringify({优先主题:p.topics,不感兴趣:p.excludedTopics,表达:p.style});}
 matches(source,topics){const text=source.title+' '+source.excerpt;return topics.some(t=>(TOPICS[t]||[t]).some(a=>topicMatch(text,a)));}
 eligible(source){if(this.matches(source,this.profile().excludedTopics))return false;return !this.store.db.prepare("SELECT 1 FROM companion_news_choices c JOIN outbox o ON o.dedupe=c.key WHERE c.url=? AND o.status='sent' AND o.updatedAt>? LIMIT 1").get(source.url,new Date(Date.parse(this.store.now())-72*3600000).toISOString());}
 rank(sources){const topics=this.profile().topics;return sources.filter(s=>this.eligible(s)).map((s,i)=>({s,i,score:this.matches(s,topics)?1:0})).sort((a,b)=>b.score-a.score||a.i-b.i).map(x=>x.s);}
 selected(sources,key){for(const s of sources)this.store.db.prepare('INSERT OR IGNORE INTO companion_news_choices VALUES(?,?,?)').run(s.url,key,this.store.now());}
 sync(){if(!this.root)return;const p=this.profile(),file=join(this.root,'相处与新闻偏好.md'),body='# 相处与新闻偏好\n\n根据仍有效的用户原话派生；不是人物背景，也不改变工具权限。明确纠正以最新表述为准，不从未回复推断厌恶。\n\n'+this.guide()+'\n\n'+this.newsGuide()+'\n\n依据：\n'+p.evidence.map(e=>'- '+e.quote).join('\n');if(!existsSync(file)||readFileSync(file,'utf8')!==body)writeFileSync(file,body,'utf8');}
}
