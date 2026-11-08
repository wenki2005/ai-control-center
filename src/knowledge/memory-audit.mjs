import { createHash } from 'node:crypto';
import { workplaceStatement } from '../companion.mjs';

const TABLE='companion_memory_audit';
const STATE='companion:memory-audit:v1';
const excludedText=/^(?:\[?(?:内部工作回报|系统修复|repair|withdrawn|已撤回|记忆审计)\]?)/iu;
const nonMemory=/^(?:我想|我希望|我准备|我打算|我计划|可能|也许|如果|假如)/u;
const stable=/喜欢|偏好|习惯|长期|一直|以后|过敏|忌口|生日|住在|家住|来自|职业|单位|公司|任职|就职|供职/u;

export class MemoryAudit {
  constructor({store,companion,sourceChatId='canonical',pageSize=100}={}) {
    if(!store?.db)throw new TypeError('store.db required');
    Object.assign(this,{store,companion,sourceChatId:String(sourceChatId),pageSize:Math.max(1,Math.min(1000,Math.floor(pageSize)||100))});
    this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(id TEXT PRIMARY KEY,sourceChatId TEXT NOT NULL,chatId INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,quote TEXT NOT NULL,conflictWith TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL); CREATE INDEX IF NOT EXISTS companion_memory_audit_status ON ${TABLE}(status,createdAt);`);
  }
  cursor(){try{return JSON.parse(this.store.meta(STATE)||'{}')[this.sourceChatId]||0}catch{return 0}}
  status(){return {sourceChatId:this.sourceChatId,cursor:this.cursor(),lastChatId:this.db.prepare('SELECT MAX(id) AS id FROM companion_chat').get()?.id||0,pending:this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE status='pending'`).get().n}}
  resetCursor(id=0){this.store.meta(STATE,JSON.stringify({...this.#cursors(),[this.sourceChatId]:Math.max(0,Number(id)||0)}));return this.status()}
  #cursors(){try{return JSON.parse(this.store.meta(STATE)||'{}')}catch{return {}}}
  scan({budget=this.pageSize,pageSize=this.pageSize,applyCandidates=false}={}){
    const cap=Math.max(1,Math.min(5000,Math.floor(Number(budget)||this.pageSize))),size=Math.max(1,Math.min(cap,Math.floor(Number(pageSize)||this.pageSize)));
    let cursor=this.cursor(),scanned=0,candidates=0,conflicts=0,last=cursor;const preview=[];
    const normalize=text=>String(text).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
    const knownQuotes=new Set(this.db.prepare(`SELECT quote FROM ${TABLE} WHERE kind='candidate' AND status IN ('pending','candidate_saved')`).all().map(row=>normalize(row.quote)));
    const rows=this.db.prepare(`SELECT id,role,text,createdAt FROM companion_chat WHERE id>? AND retractedAt IS NULL ORDER BY id LIMIT ?`).all(cursor,cap);
    const insert=this.db.prepare(`INSERT OR IGNORE INTO ${TABLE}(id,sourceChatId,chatId,kind,status,quote,conflictWith,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)`);
    for(let off=0;off<rows.length;off+=size){
      const batch=rows.slice(off,off+size);this.db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of batch){last=row.id;scanned++;if(row.role!=='user'||row.retractedAt||excludedText.test(row.text)||nonMemory.test(row.text))continue;
          const statement=workplaceStatement(row.text);let kind='candidate';
          if(statement?.historical)continue;
          if(statement&&!statement.historical){
            const fact=this.db.prepare("SELECT value,validFrom FROM companion_facts WHERE key='当前工作单位' AND status='active' ORDER BY validFrom DESC LIMIT 1").get();
            if(fact&&fact.value===statement.value){
              kind='known-reference';
              preview.push({sourceChatId:this.sourceChatId,chatId:row.id,kind});
              if(applyCandidates){const id=this.#id(row.id,kind);insert.run(id,this.sourceChatId,row.id,kind,'known-reference',row.text,String(fact.value),this.store.now(),this.store.now());}
              continue;
            }
            if(fact&&fact.value!==statement.value){
              const historical=String(row.createdAt)<String(fact.validFrom);
              kind=historical?'historical-change':'conflict';
              if(!historical)conflicts++;
              preview.push({sourceChatId:this.sourceChatId,chatId:row.id,kind,quote:row.text,conflictWith:fact.value});
              if(applyCandidates){const id=this.#id(row.id,kind);insert.run(id,this.sourceChatId,row.id,kind,historical?'historical-change':'pending',row.text,String(fact.value),this.store.now(),this.store.now());}
              continue;
            }
          }
          if(!statement&&(!stable.test(row.text)||! /^(?:我|本人|以后|今后|记住|请记住|不要再|别再)/u.test(row.text)||/[？?]/u.test(row.text)))continue;
          if(knownQuotes.has(normalize(row.text))) {
            if(applyCandidates)insert.run(this.#id(row.id,'duplicate-reference'),this.sourceChatId,row.id,'duplicate-reference','duplicate-reference',row.text,null,this.store.now(),this.store.now());
            continue;
          }
          knownQuotes.add(normalize(row.text));
          candidates++;preview.push({sourceChatId:this.sourceChatId,chatId:row.id,kind,quote:row.text});const id=this.#id(row.id,kind);const saved=applyCandidates?insert.run(id,this.sourceChatId,row.id,kind,'pending',row.text,null,this.store.now(),this.store.now()):{changes:0};
          if(applyCandidates&&saved.changes&&this.companion){
            const provenance=`${row.createdAt}｜来源聊天 ${this.sourceChatId} #${row.id}｜用户原话：`;
            const bounded=provenance+row.text.slice(0,Math.max(0,990-provenance.length));
            this.companion.saveMemory({text:bounded.slice(0,990),status:'pending',source:`memory-audit:${this.sourceChatId}:chat${row.id}`});
            this.db.prepare(`UPDATE ${TABLE} SET status='candidate_saved',updatedAt=? WHERE id=?`).run(this.store.now(),id);
          }
        }
        if(applyCandidates)this.store.meta(STATE,JSON.stringify({...this.#cursors(),[this.sourceChatId]:last}));this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    return {scanned,candidates,conflicts,cursor:applyCandidates?last:cursor,nextCursor:last,done:rows.length<cap,sourceChatId:this.sourceChatId,candidatePreview:preview};
  }
  #id(chatId,kind){return createHash('sha256').update(`${this.sourceChatId}\0${chatId}\0${kind}`).digest('hex')}
  list({status='pending',limit=100}={}){return this.db.prepare(`SELECT id,sourceChatId,chatId,kind,status,quote,conflictWith,createdAt,updatedAt FROM ${TABLE} WHERE status=? ORDER BY chatId LIMIT ?`).all(status,Math.max(1,Math.min(1000,Number(limit)||100)))}
  resolve(id,action) {
    if(!['keep-current','review-quote'].includes(action))throw Error('请选择保留当前资料或加入待确认记忆');
    const row=this.db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(id);if(!row)throw Error('找不到这条待确认记录');
    if(row.status!=='pending')return {ok:true,duplicate:true};
    if(action==='review-quote') {
      if(!this.companion)throw Error('记忆服务未连接');
      this.companion.saveMemory({text:`待核对的历史原话：${row.quote}`.slice(0,990),status:'pending',source:`memory-audit:review:chat${row.chatId}`});
    }
    this.db.prepare(`UPDATE ${TABLE} SET status=?,updatedAt=? WHERE id=?`).run(action==='keep-current'?'dismissed':'candidate_saved',this.store.now(),id);
    this.store.event(null,'memory.audit-resolved',{auditId:id,action});return {ok:true};
  }
}
