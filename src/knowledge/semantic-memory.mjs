import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {semanticRecords} from './semantic-records.mjs';
import {retrieveLayeredMemory,expandMemoryQuery} from './layered-memory.mjs';

const MODEL='qwen3-embedding:0.6b',BASE='http://127.0.0.1:11435';
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const normalized=s=>s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
export function cosine(a,b){if(a.length!==b.length)throw Error('Embedding dimension mismatch');let dot=0,x=0,y=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}return x&&y?dot/Math.sqrt(x*y):0;}

export class SemanticMemory{
 constructor({store,database,runtime,embed=null,enabled=false,now=Date.now,coordinator=null,resourceEstimates={}}={}){
  Object.assign(this,{store,database,runtime,enabled,now,coordinator,resourceEstimates});this.db=store.db;this.cache=new Map();this.flights=new Map();this.embed=embed||((texts,timeoutMs)=>this.localEmbed(texts,timeoutMs));
  this.db.exec('CREATE TABLE IF NOT EXISTS companion_embeddings(key TEXT PRIMARY KEY,version TEXT NOT NULL,model TEXT NOT NULL,vector TEXT NOT NULL,updatedAt TEXT NOT NULL)');
 }
 async localEmbed(texts,timeoutMs=30000,{gpu=0}={}){
  const response=await fetch(BASE+'/api/embed',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(timeoutMs),body:JSON.stringify({model:MODEL,input:texts,truncate:false,keep_alive:'10m',options:{num_gpu:gpu,num_thread:4,num_ctx:2048}})});
  if(!response.ok)throw Error(`Local embedding HTTP ${response.status}`);const data=await response.json();
  if(!Array.isArray(data.embeddings)||data.embeddings.length!==texts.length||data.embeddings.some(v=>!Array.isArray(v)||!v.length||v.some(n=>!Number.isFinite(n))))throw Error('Invalid local embedding response');return data.embeddings;
 }
 records(){return semanticRecords(this.db,{now:this.now()});}
 async syncBatch({size=8}={}){
  if(this.stopping||this.busy||!this.enabled)return {skipped:true};this.busy=true;
  try{
   const records=this.records(),valid=new Set(records.map(r=>r.key));
   const saved=new Map(this.db.prepare('SELECT key,version,model FROM companion_embeddings').all().map(r=>[r.key,r]));
   const changed=records.filter(r=>saved.get(r.key)?.version!==r.version||saved.get(r.key)?.model!==MODEL),batch=changed.slice(0,Math.max(1,Math.min(32,size)));
   const vectors=batch.length?await this.runEmbedding(batch.map(r=>r.text),60000,{owner:'semantic-index',priority:-10}):[];
   if(vectors.length!==batch.length)throw Error('Incomplete embedding batch');
   // Re-read canonical data after inference: edits/retractions during inference win.
   const current=new Map(this.records().map(r=>[r.key,r]));
   const put=this.db.prepare('INSERT INTO companion_embeddings VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version,model=excluded.model,vector=excluded.vector,updatedAt=excluded.updatedAt');
   for(let i=0;i<batch.length;i++)if(current.get(batch[i].key)?.version===batch[i].version)put.run(batch[i].key,batch[i].version,MODEL,JSON.stringify(vectors[i]),new Date(this.now()).toISOString());
   for(const key of saved.keys())if(!valid.has(key))this.db.prepare('DELETE FROM companion_embeddings WHERE key=?').run(key);
   this.lastError=null;this.store.meta('semantic-memory:last-index',new Date(this.now()).toISOString());return {indexed:batch.length,remaining:Math.max(0,changed.length-batch.length),records:records.length};
  }catch(error){this.lastError=error.message;throw error;}finally{this.busy=false;}
 }
 async queryVector(query){
  const cached=this.cache.get(query);if(cached&&this.now()-cached.at<300000)return cached.vector;
  if(this.flights.has(query))return this.flights.get(query);
  const expanded=expandMemoryQuery(query);
  const flight=this.runEmbedding(['Instruct: Retrieve relevant personal facts and past conversations to answer the user question.\nQuery: '+query+(expanded!==query?'\nRelated terms: '+expanded:'')],5000,{owner:'semantic-recall',priority:100}).then(([vector])=>{this.cache.set(query,{at:this.now(),vector});if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value);return vector;}).finally(()=>this.flights.delete(query));this.flights.set(query,flight);return flight;
 }
 async runEmbedding(texts,timeoutMs,{owner,priority}){
  if(!this.coordinator)return this.embed(texts,timeoutMs);
  return this.coordinator.run({owner,kind:'light',priority,...this.resourceEstimates.embedding},()=>this.embed(texts,timeoutMs));
 }
 async recall(query='',{layer='all',limit=6,maxChars=2800}={}){
  const lexical=retrieveLayeredMemory(this.database,query,20,{layer,maxChars:10000,now:this.now()});
  const budget=Math.max(200,Math.min(4200,Number(maxChars)||2800)),count=Math.max(1,Math.min(12,Number(limit)||6));
  let semantic=[],mode='lexical',fallback=null;
  if(query.trim()&&this.enabled&&layer!=='reflection')try{
   const vector=await this.queryVector(query),current=new Map(this.records().map(r=>[r.key,r]));
   const explicit=/\b(20\d{2}-\d{2}-\d{2})\b/u.exec(query)?.[1];
   const target=explicit&&Number.isFinite(Date.parse(explicit))?explicit:/今天|今早|今晨|今日/u.test(query)?day(this.now()):/昨天|昨晚/u.test(query)?day(this.now()-86400000):null;
   for(const row of this.db.prepare('SELECT * FROM companion_embeddings WHERE model=?').iterate(MODEL)){
    const r=current.get(row.key);if(!r||r.version!==row.version||layer!=='all'&&r.layer!==layer||target&&r.layer==='episodic'&&(!r.validFrom||day(r.validFrom)!==target))continue;
    const similarity=cosine(vector,JSON.parse(row.vector));if(similarity>=0.42)semantic.push({...r,similarity});
   }
   semantic.sort((a,b)=>b.similarity-a.similarity);semantic=semantic.slice(0,20);mode='hybrid';
  }catch(error){fallback=error.name||'Error';}
  const candidates=new Map();
  const add=(r,score)=>{const key=normalized(r.text.replace(/^用户原话：/,''));const previous=candidates.get(key);if(previous)previous.rank+=score;else candidates.set(key,{...r,rank:score});};
  lexical.matches.forEach((r,i)=>add(r,1/(60+i)));
  semantic.forEach((r,i)=>add({...r,text:r.kind==='episode'?'用户原话：'+r.text:r.text},1.5/(60+i)));
  // Revalidate once more after model inference so revoked facts never escape via lexical fallback.
  const fresh=retrieveLayeredMemory(this.database,query,20,{layer,maxChars:10000,now:this.now()});
  {
   const allowed=new Map(this.records().map(r=>[r.key,r.version]));
   const freshLexical=new Set(fresh.matches.map(r=>normalized(r.text.replace(/^用户原话：/,''))));
   for(const [key,r]of candidates)if(r.version?allowed.get(r.key)!==r.version:!freshLexical.has(key))candidates.delete(key);
  }
  let used=0;const seen=new Set(),seenTexts=new Set(),matches=[];
  for(const r of [...candidates.values()].sort((a,b)=>b.rank-a.rank)){
   if(matches.length>=count)break;if(r.recordKey&&seen.has(r.recordKey))continue;
   const text=r.text.slice(0,420),textKey=normalized(text.replace(/^用户原话：/,'')),size=text.length+String(r.source).length+100;if(seenTexts.has(textKey)||used+size>budget)continue;
   seenTexts.add(textKey);
   used+=size;if(r.recordKey)seen.add(r.recordKey);const {rank,key,recordKey,version,similarity,...result}=r;matches.push({...result,text});
  }
  return {...fresh,matches,budget:{maxChars:budget,usedChars:used},retrieval:{mode,model:mode==='hybrid'?MODEL:null,fallback,indexed:this.db.prepare('SELECT count(*) n FROM companion_embeddings WHERE model=?').get(MODEL).n}};
 }
 status(){return {enabled:this.enabled,model:MODEL,provider:'local-ollama-cpu',indexed:this.db.prepare('SELECT count(*) n FROM companion_embeddings WHERE model=?').get(MODEL).n,lastIndexedAt:this.store.meta('semantic-memory:last-index')||null,lastError:this.lastError||null,busy:!!this.busy};}
 async ensureRuntime(){
  try{if((await fetch(BASE+'/api/version',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
  const executable=join(homedir(),'AppData/Local/Programs/Ollama/ollama.exe');if(!existsSync(executable))throw Error('Local embedding runtime missing');
  const root=resolve(this.runtime,'semantic-memory');mkdirSync(root,{recursive:true});const fd=openSync(join(root,'ollama.log'),'a');
  try{const child=spawn(executable,['serve'],{windowsHide:true,detached:true,stdio:['ignore',fd,fd],env:{...process.env,OLLAMA_HOST:'127.0.0.1:11435',OLLAMA_MODELS:join(root,'models'),OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1'}});child.on('error',()=>{});child.unref();}finally{closeSync(fd);}
 }
 start(){if(!this.enabled||this.timer)return;const tick=()=>{void this.ensureRuntime().then(()=>this.syncBatch()).catch(error=>{this.lastError=error.message;});};tick();this.timer=setInterval(tick,60000);this.timer.unref?.();}
 async close(){this.stopping=true;clearInterval(this.timer);while(this.busy)await new Promise(r=>setTimeout(r,25));}
}
