import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';

const HOURS6=6*60*60*1000;
const clean=value=>String(value||'').replace(/<[^>]*>/g,'').trim().slice(0,200);
const tagsOf=value=>Array.isArray(value)?[...new Set(value.map(clean).filter(Boolean))].slice(0,30):[];
/** Header dimensions are a cheap reject filter; visual approval is still required. */
export function imageDimensions(b,ext){
  if(ext==='png'&&b.length>=24)return [b.readUInt32BE(16),b.readUInt32BE(20)];
  if(ext==='gif'&&b.length>=10)return [b.readUInt16LE(6),b.readUInt16LE(8)];
  if(ext==='jpg'){
    for(let i=2;i+4<b.length;){
      if(b[i++]!==255)continue;const marker=b[i++];
      if(marker===0xd9||marker===0xda)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      const len=b.readUInt16BE(i);if(len<2||i+len>b.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&len>=7)return [b.readUInt16BE(i+5),b.readUInt16BE(i+3)];i+=len;
    }
  }
  if(ext==='webp'){
    for(let i=12;i+8<=b.length;){const kind=b.toString('ascii',i,i+4),size=b.readUInt32LE(i+4),p=i+8;if(p+size>b.length)break;
      if(kind==='VP8X'&&size>=10)return [1+b.readUIntLE(p+4,3),1+b.readUIntLE(p+7,3)];
      if(kind==='VP8L'&&size>=5&&b[p]===0x2f){const v=b.readUInt32LE(p+1);return [(v&0x3fff)+1,((v>>>14)&0x3fff)+1];}
      if(kind==='VP8 '&&size>=10&&b[p+3]===0x9d&&b[p+4]===1&&b[p+5]===0x2a)return [b.readUInt16LE(p+6)&0x3fff,b.readUInt16LE(p+8)&0x3fff];i=p+size+(size%2);
    }
  }
  throw Error('无法读取图片尺寸');
}

export class StickerLibrary {
  constructor({store,root,qq,onChange=()=>{},persona=()=>({id:'mornye',name:'助手'}),discover=async()=>[],seedManifest=[],fetchRemote,detectFormat,defaultBlocks=[],suitable=()=>true}){
    Object.assign(this,{store,qq,onChange,persona,discover,seedManifest,fetchRemote,detectFormat,suitable});this.root=resolve(root);mkdirSync(this.root,{recursive:true});this.pending=new Map();this.collectionRuns=new Set();this.sending=false;this.closed=false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_stickers(id TEXT PRIMARY KEY,query TEXT NOT NULL,title TEXT NOT NULL,sourceUrl TEXT NOT NULL,pageUrl TEXT NOT NULL,file TEXT NOT NULL,mediaType TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_sticker_sends(turnKey TEXT PRIMARY KEY,stickerId TEXT NOT NULL,attachmentId TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_sticker_blocks(id TEXT PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,label TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',personaId TEXT NOT NULL DEFAULT 'mornye',createdAt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS companion_sticker_blocks_kind_value ON companion_sticker_blocks(kind,value);
      CREATE TABLE IF NOT EXISTS companion_sticker_reviews(stickerId TEXT NOT NULL,personaId TEXT NOT NULL,reviewStatus TEXT NOT NULL DEFAULT 'pending',score REAL,pack TEXT NOT NULL DEFAULT '',character TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL DEFAULT '[]',note TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '',width INTEGER,height INTEGER,updatedAt TEXT NOT NULL,PRIMARY KEY(stickerId,personaId));
      CREATE TABLE IF NOT EXISTS companion_sticker_collection(personaId TEXT PRIMARY KEY,lastAttempt INTEGER NOT NULL,lastError TEXT NOT NULL DEFAULT '',lastCount INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS companion_sticker_feedback(id TEXT PRIMARY KEY,stickerId TEXT NOT NULL,personaId TEXT NOT NULL,decision TEXT NOT NULL,score REAL,tags TEXT NOT NULL,note TEXT NOT NULL,source TEXT NOT NULL,createdAt TEXT NOT NULL);`);
    if(!store.db.prepare('SELECT COUNT(*) AS c FROM companion_sticker_blocks').get().c)for(const block of defaultBlocks)this.addBlock(block);
    for(const [key,value] of [['enabled','true'],['autoCollect','true']])if(store.meta(`companion:stickers-${key}`)==null)store.meta(`companion:stickers-${key}`,value);
    // Unknown historical provenance never inherits approval for a newly selected persona.
    store.db.prepare(`INSERT OR IGNORE INTO companion_sticker_reviews(stickerId,personaId,reviewStatus,source,updatedAt)
      SELECT id,'legacy','pending','legacy-cache',createdAt FROM companion_stickers WHERE NOT EXISTS(SELECT 1 FROM companion_sticker_reviews r WHERE r.stickerId=companion_stickers.id)`).run();
  }
  identity(){const p=this.persona()||{};return {id:clean(p.id)||'mornye',name:clean(p.name)||'助手'};}
  settings(){const p=this.identity(),state=this.store.db.prepare('SELECT * FROM companion_sticker_collection WHERE personaId=?').get(p.id);const counts={approved:0,pending:0,favorites:0,rejected:0};for(const row of this.store.db.prepare('SELECT reviewStatus,COUNT(*) AS c FROM companion_sticker_reviews WHERE personaId=? GROUP BY reviewStatus').all(p.id)){if(row.reviewStatus==='favorite'){counts.favorites=row.c;counts.approved+=row.c;}else if(row.reviewStatus in counts)counts[row.reviewStatus]+=row.c;}return {enabled:this.store.meta('companion:stickers-enabled')==='true',autoCollect:this.store.meta('companion:stickers-autoCollect')==='true',provider:'公开角色表情图库',maxPerMessage:1,collectionIntervalMs:HOURS6,repeatCooldownMs:HOURS6,persona:p,counts,lastCollectionAt:state?.lastAttempt??null,nextCollectionAt:state?state.lastAttempt+HOURS6:null,lastCollectionError:state?.lastError||'',lastCollectionCount:state?.lastCount||0};}
  configure(input={}){for(const key of ['enabled','autoCollect'])if(key in input){if(typeof input[key]!=='boolean')throw Error(`${key} 必须是布尔值`);this.store.meta(`companion:stickers-${key}`,String(input[key]));}this.onChange();return this.settings();}
  blocks(){return this.store.db.prepare('SELECT * FROM companion_sticker_blocks ORDER BY createdAt,id').all();}
  addBlock({kind,value,label,reason='',personaId=this.identity().id}={}){if(!['file','hash','style','source','message'].includes(kind)||!String(value||'').trim())throw Error('禁用项需要有效 kind 和 value');this.store.db.prepare('INSERT OR IGNORE INTO companion_sticker_blocks VALUES(?,?,?,?,?,?,?)').run(randomUUID(),kind,String(value),clean(label||value),clean(reason),String(personaId),this.store.now());return this.blocks();}
  isBlocked(fields,personaId=this.identity().id){const hay=(Array.isArray(fields)?fields:[fields]).filter(Boolean).map(x=>String(x).toLowerCase());return this.blocks().find(x=>x.kind!=='message'&&(x.personaId===personaId||x.personaId==='*')&&hay.some(v=>v.includes(x.value.toLowerCase())))||null;}
  rows(personaId=this.identity().id){return this.store.db.prepare(`SELECT s.*,r.reviewStatus,r.score,r.pack,r.character,r.tags,r.note,r.width,r.height FROM companion_stickers s JOIN companion_sticker_reviews r ON r.stickerId=s.id WHERE r.personaId=? ORDER BY CASE r.reviewStatus WHEN 'favorite' THEN 0 WHEN 'approved' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,r.score DESC,s.createdAt DESC`).all(personaId);}
  valid(row,personaId=this.identity().id){return this.suitable(row)&&existsSync(join(this.root,row.file))&&!this.isBlocked([row.hash,row.file,row.title,row.sourceUrl,row.pageUrl,row.pack,row.character,row.tags],personaId);}
  public(row){return {id:row.id,title:row.title,query:row.query,source:row.pageUrl,sourceUrl:row.sourceUrl,preview:`/api/companion/stickers/${row.id}/image`,animated:row.mediaType==='image/gif',reviewStatus:row.reviewStatus||'pending',score:row.score??null,pack:row.pack||'',character:row.character||'',tags:JSON.parse(row.tags||'[]'),width:row.width??null,height:row.height??null};}
  list(){const items=this.rows().filter(x=>x.reviewStatus!=='rejected'&&this.valid(x)).slice(0,120).map(x=>this.public(x));const legacyItems=this.rows('legacy').filter(x=>this.valid(x)).slice(0,80).map(x=>({...this.public(x),legacy:true}));return {settings:this.settings(),blocked:this.blocks(),items,legacyItems};}
  async ingest(candidate,{approved=false,score=null,query='',personaId,personaName}={}){
    const p=personaId?{id:personaId,name:personaName||this.identity().name}:this.identity();
    if(!candidate||!candidate.url)throw Error('候选图片需要 url');
    const character=clean(candidate.character),title=clean(candidate.title),tags=tagsOf(candidate.tags),pack=clean(candidate.pack);
    if(character&&![p.id,p.name].some(x=>character.toLowerCase()===x.toLowerCase()))throw Error('候选角色与当前人设不匹配');
    const url=new URL(candidate.url);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw Error('表情来源需要公开 HTTPS 地址');
    if(!this.suitable({title,pageUrl:candidate.pageUrl})||this.isBlocked([title,url.href,candidate.pageUrl,pack,character,...tags],p.id))throw Error('候选命中禁用或素材预览过滤');
    const result=await this.fetchRemote(url.href,2*1024*1024),bytes=Buffer.from(result.bytes),type=String(result.type||'').split(';')[0].toLowerCase().trim();
    if(bytes.length>2*1024*1024||!type.startsWith('image/'))throw Error('表情 MIME 或文件大小不合适');
    const [ext,mediaType]=this.detectFormat(bytes);if(type!==mediaType&&!(type==='image/jpg'&&mediaType==='image/jpeg'))throw Error('图片 MIME 与文件内容不符');
    const [width,height]=imageDimensions(bytes,ext);if(width<96||height<96||width>4096||height>4096||width/height<0.5||width/height>2)throw Error('图片清晰度或比例不适合表情');
    const hash=createHash('sha256').update(bytes).digest('hex');let row=this.store.db.prepare('SELECT * FROM companion_stickers WHERE hash=?').get(hash);
    if(this.isBlocked([hash,row?.file],p.id))throw Error('图片已被禁用');
    // An image already attributed to another character cannot be relabelled by a search title.
    if(row){const associations=this.store.db.prepare("SELECT personaId,character FROM companion_sticker_reviews WHERE stickerId=? AND personaId<>'legacy'").all(row.id);if(associations.some(x=>x.personaId!==p.id))throw Error('该图片已属于其他人设');}
    if(!row){const id=randomUUID(),file=`sticker-${hash.slice(0,24)}.${ext}`;writeFileSync(join(this.root,file),bytes);row={id,query:clean(query||candidate.query||p.name+' Q版可爱表情'),title,sourceUrl:url.href,pageUrl:clean(candidate.pageUrl||url.href),file,mediaType,hash,createdAt:this.store.now()};this.store.db.prepare('INSERT INTO companion_stickers VALUES(?,?,?,?,?,?,?,?,?)').run(...['id','query','title','sourceUrl','pageUrl','file','mediaType','hash','createdAt'].map(k=>row[k]));}
    this.store.db.prepare(`INSERT OR IGNORE INTO companion_sticker_reviews(stickerId,personaId,reviewStatus,score,pack,character,tags,source,width,height,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,p.id,'pending',score,pack,character||p.name,JSON.stringify(tags),clean(candidate.pageUrl||url.href),width,height,this.store.now());
    if(approved){if(this.identity().id!==p.id)throw Error('人设已变化，不能自动批准');return this.review(row.id,{decision:'approved',score,source:'reviewed-import'});}
    this.onChange();return this.public(this.rows(p.id).find(x=>x.id===row.id));
  }
  review(id,{decision,score=null,tags,note='',source='user'}={}){
    if(!['approved','rejected','favorite'].includes(decision))throw Error('decision 必须是 approved/rejected/favorite');
    if(score!==null&&(!Number.isFinite(score)||score<0||score>5))throw Error('score 必须是 0—5');
    if(source==='ai-visual'&&decision!=='rejected'&&!(score>=4))throw Error('视觉审核至少4分才进入可用图库');
    const p=this.identity();let row=this.rows(p.id).find(x=>x.id===String(id));
    // Legacy images stay visible for inspection but require explicit re-ingestion with character provenance.
    if(!row)throw Error('该表情尚未关联当前人设，请先重新收集审核');
    if(decision!=='rejected'&&!this.valid(row,p.id))throw Error('这张表情已禁用或文件不可用');
    const nextTags=tags===undefined?JSON.parse(row.tags||'[]'):tagsOf(tags);
    this.store.db.prepare('UPDATE companion_sticker_reviews SET reviewStatus=?,score=?,tags=?,note=?,source=?,updatedAt=? WHERE stickerId=? AND personaId=?').run(decision,score??row.score,JSON.stringify(nextTags),clean(note),clean(source),this.store.now(),String(id),p.id);
    this.store.db.prepare('INSERT INTO companion_sticker_feedback VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),String(id),p.id,decision,score,JSON.stringify(nextTags),clean(note),clean(source),this.store.now());this.onChange();return this.public(this.rows(p.id).find(x=>x.id===String(id)));
  }
  async search(input,{fresh=false}={}){
    if(!this.settings().enabled)throw Error('表情功能已关闭');const query=String(input||'').trim();if(!query||query.length>60)throw Error('表情关键词需要 1—60 字');if(this.isBlocked(query))throw Error('这个关键词命中人设禁用清单');
    const p=this.identity(),key=p.id+':'+query;if(this.pending.has(key))return this.pending.get(key);if(this.pending.size>=2)throw Error('已有表情搜索在进行，稍后再试');
    const work=(async()=>{const cached=this.rows(p.id).filter(x=>x.reviewStatus!=='rejected'&&this.valid(x,p.id)&&[x.query,x.title,x.tags].some(v=>v?.includes(query)));if(!fresh&&cached.filter(x=>['approved','favorite'].includes(x.reviewStatus)).length>=4)return {items:cached.slice(0,4).map(x=>this.public(x)),cached:true};
      const collected=await this.collect(query,p);if(this.identity().id!==p.id)throw Error('搜索期间人设已变化，请重新搜索当前角色');const items=this.rows(p.id).filter(x=>x.reviewStatus!=='rejected'&&this.valid(x,p.id)&&(cached.some(c=>c.id===x.id)||collected.some(c=>c.id===x.id))).slice(0,12).map(x=>this.public(x));return {items,cached:false,...(!items.length?{message:'没有找到当前角色的合适表情，继续保留审核标准。'}:{})};})();this.pending.set(key,work);try{return await work;}finally{this.pending.delete(key);}
  }
  async collect(query,p){
    const preferences=this.store.db.prepare("SELECT decision,tags,note FROM companion_sticker_feedback WHERE personaId=? ORDER BY createdAt DESC LIMIT 20").all(p.id);
    const term=`${p.name} Q版 可爱 表情包 ${query}`;
    const excludeUrls=this.store.db.prepare(`SELECT s.sourceUrl FROM companion_stickers s JOIN companion_sticker_reviews r ON r.stickerId=s.id WHERE r.personaId=?`).all(p.id).map(x=>x.sourceUrl);
    const excluded=new Set(excludeUrls);
    const found=await this.discover({name:p.name,query:term,limit:4,preferences,excludeUrls});
    const candidates=[...this.seedManifest.filter(x=>[p.name,p.id].includes(x.character)),...(Array.isArray(found)?found:[])].filter(x=>!excluded.has(x.url)).slice(0,4),items=[];
    items.errors=[];
    for(const candidate of candidates){if(this.closed)break;try{const item=await this.ingest(candidate,{query,personaId:p.id,personaName:p.name});if(item.reviewStatus!=='rejected'&&!items.some(x=>x.id===item.id))items.push(item);}catch(error){items.errors.push(clean(error?.message||error));}}
    return items;
  }
  tick(options={}){
    const operation=this.collectTick(options);this.collectionRuns.add(operation);
    const clear=()=>this.collectionRuns.delete(operation);void operation.then(clear,clear);return operation;
  }
  async collectTick({now=Date.now()}={}){
    const settings=this.settings();if(this.closed||!settings.enabled||!settings.autoCollect)return {skipped:true,reason:'disabled'};
    const time=now instanceof Date?now.getTime():Number(now);if(!Number.isFinite(time))throw Error('now 无效');const p=this.identity();
    const result=this.store.db.prepare(`INSERT INTO companion_sticker_collection(personaId,lastAttempt,lastError,lastCount) VALUES(?,?,'',0) ON CONFLICT(personaId) DO UPDATE SET lastAttempt=excluded.lastAttempt,lastError='',lastCount=0 WHERE companion_sticker_collection.lastAttempt<=?`).run(p.id,time,time-HOURS6);
    if(!result.changes)return {skipped:true,reason:'cooldown'};
    try{const items=await this.collect('可爱 日常互动',p);this.store.db.prepare('UPDATE companion_sticker_collection SET lastCount=?,lastError=? WHERE personaId=?').run(items.length,clean(items.errors.join('；')),p.id);this.onChange();return {collected:items.length};}
    catch(error){this.store.db.prepare('UPDATE companion_sticker_collection SET lastError=? WHERE personaId=?').run(clean(error?.message||error),p.id);this.onChange();return {collected:0,error:clean(error?.message||error)};}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending.values(),...this.collectionRuns]);}
  file(id){const row=this.store.db.prepare('SELECT * FROM companion_stickers WHERE id=?').get(String(id));if(!row)throw Error('表情不存在');const path=realpathSync(join(this.root,row.file)),rel=relative(realpathSync(this.root),path);if(rel.startsWith('..')||isAbsolute(rel))throw Error('表情路径无效');return {path,type:row.mediaType};}
  async send(id){
    if(!this.settings().enabled)throw Error('表情功能已关闭');const row=this.rows().find(x=>x.id===String(id));if(!row||!['approved','favorite'].includes(row.reviewStatus))throw Error('只允许发送当前人设已审核通过的表情');if(!this.valid(row))throw Error('这张表情已禁用或文件不可用');
    const turn=this.store.db.prepare("SELECT id FROM chat WHERE role='user' ORDER BY id DESC LIMIT 1").get();if(!turn)throw Error('尚无聊天消息');const key=`sticker:${turn.id}`,prior=this.store.db.prepare('SELECT attachmentId FROM companion_sticker_sends WHERE turnKey=?').get(key);if(prior)return this.receipt(prior.attachmentId,true);
    if(this.sending)throw Error('表情正在发送，请勿重复');const last=this.store.db.prepare('SELECT createdAt FROM companion_sticker_sends WHERE stickerId=? ORDER BY createdAt DESC LIMIT 1').get(row.id);if(last&&Date.now()-Date.parse(last.createdAt)<HOURS6)throw Error('同一张表情在六小时内不重复发送');
    this.sending=true;try{const {path}=this.file(id),attachment=this.store.enqueueAttachment({artifactId:`sticker:${id}`,filePath:path,image:true,dedupe:key});this.store.db.prepare('INSERT INTO companion_sticker_sends VALUES(?,?,?,?)').run(key,id,attachment.id,this.store.now());await this.qq.flush();this.onChange();return this.receipt(attachment.id,false);}finally{this.sending=false;}
  }
  receipt(id,repeated){const r=this.store.db.prepare('SELECT status FROM attachment_outbox WHERE id=?').get(id);return {status:r?.status||'unknown',repeated,sent:r?.status==='sent',message:r?.status==='sent'?(repeated?'这一轮已有一张表情发送成功，没有再次发送。':'表情已通过 QQ 图片消息发送。'):'表情尚未确认发出，请不要声称已发送或重复发送。'};}
}
