import {createRequire} from 'node:module';
import {readdir,open,realpath,access} from 'node:fs/promises';
import {join,relative,isAbsolute,basename,dirname} from 'node:path';
import {homedir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {redact} from './redact.mjs';

const require=createRequire(import.meta.url);
const {CodexReadonly}=require('../remote-client/codex-native.cjs');
const {DshReadonly}=require('../remote-client/dsh-native.cjs');
const WebSocket=require('ws');
const MAX_MESSAGES=100,MAX_TEXT=12000,MAX_TOTAL=160000,FILE_BYTES=2*1024*1024;
const safeId=id=>typeof id==='string'&&/^[\w-]{1,180}$/.test(id);
const cap=(n,fallback=30)=>Math.max(1,Math.min(100,Math.floor(Number(n)||fallback)));
const clean=value=>redact(String(value??'')).replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,'[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/ig,'Bearer [REDACTED]').replace(/((?:cookie|authorization)\s*[:=]\s*)[^\r\n]+/ig,'$1[REDACTED]').slice(0,MAX_TEXT);
const statusOf=x=>typeof x==='string'?x:x?.type||'unknown';
const visible=x=>typeof x==='string'?x:Array.isArray(x)?x.filter(p=>['text','input_text','output_text'].includes(p?.type)&&typeof p.text==='string'&&(!p.channel||['final','commentary'].includes(p.channel))).map(p=>p.text).join('\n'):'';
function bounded(messages,limit){let budget=MAX_TOTAL;return messages.filter(m=>['user','assistant'].includes(m.role)&&typeof m.text==='string'&&(!m.channel||['final','commentary'].includes(m.channel))).slice(-limit).reverse().map(m=>{const text=clean(m.text).slice(0,budget);budget-=text.length;return {role:m.role,text};}).filter(m=>m.text).reverse();}
function item(engine,x){return {engine,sessionId:String(x.sessionId||x.id||''),title:clean(x.title||x.sessionName||x.name||''),...(typeof x.cwd==='string'&&x.cwd?{cwd:clean(x.cwd)}:{}),status:clean(statusOf(x.status||(x.running===true?'running':x.runningKnown===true?'idle':null))).slice(0,100)};}
function inside(root,file){const rel=relative(root,file);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');}
async function checked(root,file){const canonicalRoot=await realpath(root),canonicalFile=await realpath(file);if(!inside(canonicalRoot,canonicalFile))throw Error('会话历史路径超出允许目录');return canonicalFile;}
// Read whole JSONL records only; discard the first partial line at a tail boundary.
async function records(root,file,{head=false}={}){const actual=await checked(root,file),handle=await open(actual,'r');try{const stat=await handle.stat();if(!stat.isFile())throw Error('会话历史不是文件');const count=Math.min(stat.size,head?65536:FILE_BYTES),start=head?0:stat.size-count,buffer=Buffer.alloc(count);const {bytesRead}=await handle.read(buffer,0,count,start);let text=buffer.subarray(0,bytesRead).toString('utf8');if(start>0){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}if(head&&stat.size>count)text=text.slice(0,Math.max(0,text.lastIndexOf('\n')));return text.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}finally{await handle.close();}}

export class NativeSessions {
 constructor({nativeTasks,codex,dsh,workbuddyRoots,workbuddyProjects,workbuddyDatabase}={}) {
  this.nativeTasks=nativeTasks;this.codex=codex||new CodexReadonly();
  this.dsh=dsh||new DshReadonly({WebSocketImpl:WebSocket,...(nativeTasks?.baseUrl?{baseUrl:nativeTasks.baseUrl}:{})});
  if(!dsh&&nativeTasks?.authCookie)this.dsh.auth=()=>nativeTasks.authCookie();
  this.workbuddyProjects=workbuddyProjects||workbuddyRoots||[join(homedir(),'.workbuddy/projects'),join(homedir(),'.codebuddy/projects')];
  this.workbuddyDatabase=workbuddyDatabase===undefined?join(process.env.APPDATA||join(homedir(),'AppData/Roaming'),'WorkBuddy/codebuddy-sessions.vscdb'):workbuddyDatabase;
  this.owned={codex:!codex,dsh:!dsh};
 }
 async catalog(engine){
  if(engine==='codex'){
   const rows=[],seen=new Set();let cursor;
   for(let page=0;page<20;page++){const result=await this.codex.list({cursor,limit:100});rows.push(...(result.items||[]));if(!result.nextCursor)return {rows};if(seen.has(result.nextCursor))return {rows,truncated:true};seen.add(result.nextCursor);cursor=result.nextCursor;}
   return {rows,truncated:true};
  }
  if(engine==='dsh')return {rows:this.nativeTasks?.listSessions?await this.nativeTasks.listSessions({includeDelegated:true}):await this.dsh.list()};
  if(engine==='workbuddy')return {rows:await this.listWorkbuddy()};
  throw Error('不支持的会话引擎');
 }
 async list({engine,query='',limit=50}={}) {
  const items=[],errors=[];let truncated=false;
  for(const e of engine?[engine]:['codex','dsh','workbuddy'])try{const result=await this.catalog(e);truncated ||= !!result.truncated;for(const row of result.rows){const value=item(e,row);if(value.sessionId&&`${value.sessionId} ${value.title} ${value.cwd||''}`.toLowerCase().includes(String(query).toLowerCase()))items.push(value);}}catch(error){errors.push({engine:e,error:clean(`读取会话目录失败：${error.message||error}`).slice(0,400)});}
  const take=cap(limit,50);return {items:items.slice(0,take),...(truncated||items.length>take?{truncated:true}:{}),...(errors.length?{errors}:{})};
 }
 async workbuddyMetadata(){
  const map=new Map();if(!this.workbuddyDatabase)return map;let db;
  try{await access(this.workbuddyDatabase);db=new DatabaseSync(this.workbuddyDatabase,{readOnly:true});for(const row of db.prepare('SELECT value FROM ItemTable').iterate())try{const x=JSON.parse(typeof row.value==='string'?row.value:Buffer.from(row.value).toString('utf8'));if(safeId(x.conversationId))map.set(x.conversationId,x);}catch{}}
  catch(error){if(error.code!=='ENOENT')throw error;}
  finally{db?.close();}return map;
 }
 async listWorkbuddy(){
  const metadata=await this.workbuddyMetadata(),out=[];
  for(const root of this.workbuddyProjects){
   let canonical;try{canonical=await realpath(root);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   const walk=async(directory,depth)=>{for(const entry of await readdir(directory,{withFileTypes:true})){
    const file=join(directory,entry.name);
    if(entry.isDirectory()&&depth<3){const actual=await checked(canonical,file);await walk(actual,depth+1);}
    else if(entry.isFile()&&entry.name.endsWith('.jsonl')&&safeId(basename(entry.name,'.jsonl'))){
     const sessionId=basename(entry.name,'.jsonl'),rows=[...await records(canonical,file,{head:true}),...await records(canonical,file)],meta=metadata.get(sessionId)||{};
     const matching=rows.filter(x=>!x.sessionId||x.sessionId===sessionId);
     const title=matching.findLast(x=>x.type==='custom-title')?.customTitle||matching.findLast(x=>x.type==='custom-title')?.title||meta.title||matching.findLast(x=>x.type==='ai-title')?.aiTitle||'';
     const cwd=meta.cwd||matching.findLast(x=>typeof x.cwd==='string')?.cwd;
     out.push({sessionId,title,cwd,status:statusOf(meta.status),root:canonical,file});
    }
   }};await walk(canonical,0);
  }
  return out;
 }
 async read({engine,sessionId,limit=30}={}) {
  if(!['codex','dsh','workbuddy'].includes(engine)||!safeId(sessionId))throw Error('需要有效引擎与精确会话 ID');
  try{
   let result,metadata={};
   if(engine==='workbuddy'){
    const rows=await this.listWorkbuddy(),matches=rows.filter(x=>x.sessionId===sessionId);
    if(matches.length!==1)throw Error(matches.length?'会话 ID 对应多个历史，请先明确来源':'未找到精确会话 ID');
    metadata=matches[0];const records_=await records(metadata.root,metadata.file);
    result={...metadata,messages:records_.filter(x=>(!x.sessionId||x.sessionId===sessionId)&&['message','user','assistant'].includes(x.type)&&(!x.channel||['final','commentary'].includes(x.channel))).map(x=>({role:x.role||x.message?.role||x.type,channel:x.message?.channel,text:visible(x.message?.content??x.content)}))};
   }else{
    // Exact native reads must not depend on the first page of a catalog.
    result=await this[engine].read(sessionId);
    if(this.nativeTasks?.listSessions&&engine==='dsh')metadata=(await this.nativeTasks.listSessions({includeDelegated:true})).find(x=>x.sessionId===sessionId)||{};
   }
   const value=item(engine,{...metadata,...result,sessionId,title:result.sessionName||result.title||metadata.title,status:result.status||metadata.status});
   return {...value,sessionName:value.title,...(engine==='workbuddy'?{workbuddyConfigDir:dirname(metadata.root)}:{}),messages:bounded(result.messages||[],cap(limit))};
  }catch(error){throw Error(clean(`读取原生会话失败：${error.message||error}`).slice(0,500));}
 }
 async close(){await Promise.all([this.owned.codex?this.codex.close?.():null,this.owned.dsh?this.dsh.close?.():null]);}
}
