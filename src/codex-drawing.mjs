import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCodexExecutable } from './adapters/codex.mjs';
const execFileAsync=promisify(execFile),MAX_READ=1024*1024,MAX_AGE=12*3600000;
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const body=p=>(p.content||[]).map(x=>x.text||'').join('');
const safe=s=>String(s||'画作').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').trim().slice(0,45)||'画作';
/** Desktop queue preserves the dedicated chat's native image-generation tool. */
export class CodexDrawing {
  constructor({store,threadId,sessionRoot,command,root,send,execute=execFileAsync,now=Date.now}) {
    Object.assign(this,{threadId,sessionRoot,command,root:resolve(root),send,execute,now});this.db=store.db||store;
    if(!/^[a-zA-Z0-9-]+$/.test(threadId))throw Error('Codex 生图会话绑定无效');
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_drawing_requests(id TEXT PRIMARY KEY,status TEXT NOT NULL,state TEXT NOT NULL,createdAt INTEGER NOT NULL,error TEXT,file TEXT)`);
  }
  async files(){const found=[];for await(const file of fs.glob(`${String(this.sessionRoot).replaceAll('\\','/')}/**/*${this.threadId}*.jsonl`)){const st=await fs.stat(file);found.push({file,size:st.size,mtime:st.mtimeMs});}return found.sort((a,b)=>b.mtime-a.mtime);}
  put(id,status,state,extra={}){this.db.prepare('UPDATE codex_drawing_requests SET status=?,state=?,error=COALESCE(?,error),file=COALESCE(?,file) WHERE id=?').run(status,JSON.stringify(state),extra.error||null,extra.file||null,id);}
  progress(id){
    const job=this.db.prepare('SELECT status,state,createdAt FROM codex_drawing_requests WHERE id=?').get(id);if(!job)return {};
    let s;try{s=JSON.parse(job.state);}catch{return {};}
    const phase=job.status!=='running'?job.status:s.image?'image_ready':s.imageStarted?'generating':s.turn?'preparing':'awaiting_session';
    const labels={submitting:'正在提交到专用会话',awaiting_session:'等待专用生图会话接收',preparing:'会话正在处理，尚未确认生图工具启动',generating:'生图工具已启动',image_ready:'图片已生成，等待回合完成',completed:'图片已完成',failed:'生成失败',uncertain:'结果待核对'};
    return {phase,phaseLabel:labels[phase]||phase,elapsedSeconds:Math.max(0,Math.floor((this.now()-job.createdAt)/1000))};
  }
  async submit(row){
    if(this.db.prepare('SELECT 1 FROM codex_drawing_requests WHERE id=?').get(row.id))return row.id;
    const files=await this.files();if(!files.length)throw Error('未找到专用生图会话历史，未派发');
    const state={file:files[0].file,offset:files[0].size,partial:'',baseline:Object.fromEntries(files.map(x=>[x.file,x.size])),marker:`[中枢画图:${row.id}]`,turn:null,startedTurn:null,image:null,lastDiscovery:this.now()};
    this.db.prepare("INSERT INTO codex_drawing_requests(id,status,state,createdAt) VALUES(?,'submitting',?,?)").run(row.id,JSON.stringify(state),this.now());
    const prompt=`${state.marker}\n请用本会话的生图工具画图，完成后展示图片。画作：${row.title}。\n${row.prompt}`;
    try{if(this.send)await this.send(this.threadId,prompt);else await this.execute(resolveCodexExecutable({command:this.command}),['queue','--resume','--thread',this.threadId,'--message',prompt],{windowsHide:true,timeout:20000,maxBuffer:100000});this.put(row.id,'running',state);}
    catch{this.put(row.id,'uncertain',state,{error:'Codex 派发回执未确认，保留原请求，不自动重复生成'});}
    return row.id;
  }
  async poll(row){
    const job=this.db.prepare('SELECT * FROM codex_drawing_requests WHERE id=?').get(row.id);if(!job)return {status:'uncertain',error:'未找到生图派发记录'};
    if(['completed','failed','uncertain'].includes(job.status))return {status:job.status,...(job.file?{file:job.file}:{}),...(job.error?{error:job.error}:{})};
    const s=JSON.parse(job.state);
    if(this.now()-job.createdAt>MAX_AGE){this.put(row.id,'uncertain',s,{error:'十二小时内未确认生图终态，不自动重派'});return {status:'uncertain',error:'生图结果待核对'};}
    try{
      if(this.now()-s.lastDiscovery>30000){const files=await this.files();s.lastDiscovery=this.now();if(files[0]&&files[0].file!==s.file){s.file=files[0].file;s.offset=s.baseline[s.file]||0;s.partial='';}}
      const st=await fs.stat(s.file);if(st.size<s.offset){this.put(row.id,'uncertain',s,{error:'生图会话记录被截断，需核对原会话'});return {status:'uncertain',error:'生图会话记录被截断'};}
      const n=Math.min(st.size-s.offset,MAX_READ);if(!n){this.put(row.id,'running',s);return {status:'running'};}
      const h=await fs.open(s.file,'r');let chunk;try{const b=Buffer.alloc(n);const r=await h.read(b,0,n,s.offset);chunk=b.subarray(0,r.bytesRead);s.offset+=r.bytesRead;}finally{await h.close();}
      const all=Buffer.concat([Buffer.from(s.partial,'base64'),chunk]);let start=0,done=false;
      for(let i=0;i<all.length;i++){if(all[i]!==10)continue;let r;try{r=JSON.parse(all.subarray(start,i).toString('utf8'));}catch{start=i+1;continue;}start=i+1;const p=r.payload||{};
        if(r.type==='event_msg'&&p.type==='task_started')s.startedTurn=p.turn_id||null;
        if(r.type==='response_item'&&p.type==='message'&&p.role==='user'&&body(p).includes(s.marker))s.turn=p.internal_chat_message_metadata_passthrough?.turn_id||p.turn_id||s.startedTurn;
        if(r.type==='event_msg'&&p.type==='user_message'&&String(p.message||'').includes(s.marker))s.turn=p.turn_id||s.startedTurn;
        if(!s.turn||r.type!=='event_msg'||p.turn_id!==s.turn)continue;
        if(p.type==='item_started'&&p.item?.kind==='image_gen.generation')s.imageStarted=true;
        if(p.type==='item_completed'&&p.item?.kind==='image_gen.generation'&&['completed','succeeded'].includes(p.item.status)&&typeof p.item.savedPath==='string')s.image=p.item.savedPath;
        if(p.type==='task_complete')done=true;
      }
      s.partial=all.subarray(start).toString('base64');
      if(done){
        if(!s.image){const error='专用生图会话已结束，但没有成功生成可用图片，请查看原会话说明';this.put(row.id,'failed',s,{error});return {status:'failed',error};}
        const st=await fs.stat(s.image);if(!st.isFile()||st.size>8*1024*1024)throw Error('生成图片过大或不是本地文件');
        const bytes=await fs.readFile(s.image);if(!bytes.subarray(0,8).equals(signature))throw Error('生成结果不是 PNG 图片');
        await fs.mkdir(this.root,{recursive:true});let file=join(this.root,`${safe(row.title)}.png`);let seq=2;
        while(true){try{await fs.writeFile(file,bytes,{flag:'wx'});break;}catch(e){if(e.code!=='EEXIST')throw e;file=join(this.root,`${safe(row.title)}（${seq++}）.png`);}}
        this.put(row.id,'completed',s,{file});return {status:'completed',file};
      }
      this.put(row.id,'running',s);return {status:'running'};
    }catch(error){this.put(row.id,'failed',s,{error:String(error.message).slice(0,400)});return {status:'failed',error:'读取 Codex 生图结果失败：'+String(error.message).slice(0,300)};}
  }
}
