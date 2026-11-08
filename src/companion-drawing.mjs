import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {validIdleDrawingQueue,ResourceRecovery,drawingRecoveryVersion} from './lifecycle/resource-recovery.mjs';

// Jobs survive hub reloads. A lost submission acknowledgement is never retried:
// ComfyUI does not provide an idempotent POST /prompt contract.
export class CompanionDrawing {
  constructor({store,qq,root,codex=null,onChange=()=>{},coordinator=null,resourceEstimate=null,recovery=null,spawnProcess=spawn,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
    Object.assign(this,{store,qq,codex,onChange,coordinator,resourceEstimate,spawnProcess,wait});this.root=resolve(root);mkdirSync(this.root,{recursive:true});this.localLeases=new Map();this.backendOwner=null;
    this.base='http://127.0.0.1:8188';this.home='D:/QwenImage';this.busy=false;this.busyEngines=new Set();
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_drawings(id TEXT PRIMARY KEY,dedupe TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,remoteId TEXT,file TEXT,
      seed INTEGER NOT NULL,share INTEGER NOT NULL,caption TEXT NOT NULL,autonomous INTEGER NOT NULL,
      error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);`);
    if(!store.db.prepare('PRAGMA table_info(companion_drawings)').all().some(x=>x.name==='engine'))store.db.exec("ALTER TABLE companion_drawings ADD COLUMN engine TEXT NOT NULL DEFAULT 'local'");
    if(!store.db.prepare('PRAGMA table_info(companion_drawings)').all().some(x=>x.name==='backendBase'))store.db.exec('ALTER TABLE companion_drawings ADD COLUMN backendBase TEXT');
    this.recovery=recovery||new ResourceRecovery(store);this.resourceReady=this.restoreResourceLeases();
  }
  async restoreResourceLeases(){
    if(!this.coordinator)return;
    const rows=this.store.db.prepare("SELECT * FROM companion_drawings WHERE engine='local' AND status IN ('running','submitting','uncertain') ORDER BY createdAt").all();
    for(const row of rows)if(!this.localLeases.has(row.id)&&!this.recovery.abandonedDrawing(row)){
      const lease=await this.coordinator.acquire({owner:`drawing:${row.id}`,kind:'heavy',priority:0,recovery:true,...(this.resourceEstimate||{})});
      const current=this.store.db.prepare('SELECT * FROM companion_drawings WHERE id=?').get(row.id);
      if(this.recovery.abandonedDrawing(current))this.coordinator.release(lease);else this.localLeases.set(row.id,lease);
    }
  }
  settings(){return {engine:this.store.meta('drawing:engine')||'local',options:[{value:'local',label:'本机生图',available:true},{value:'codex',label:'Codex · 生图',available:!!this.codex}],sessionTitle:'生图'};}
  configure({engine}={}){if(!['local','codex'].includes(engine))throw Error('请选择本机生图或 Codex 生图');if(engine==='codex'&&!this.codex)throw Error('Codex 生图会话尚未接入');this.store.meta('drawing:engine',engine);return this.settings();}
  list(){return this.store.db.prepare('SELECT * FROM companion_drawings ORDER BY createdAt DESC LIMIT 30').all().map(x=>this.view(x));}
  view(row){if(!row)return null;const receipt=this.store.db.prepare('SELECT status FROM attachment_outbox WHERE dedupe=?').get(`drawing:${row.id}`);
    return {id:row.id,title:row.title,engine:row.engine||'local',sessionTitle:row.engine==='codex'?'生图':null,status:row.status,error:row.error,createdAt:row.createdAt,updatedAt:row.updatedAt,
      ...(row.engine==='codex'?this.codex?.progress?.(row.id):{}),
      ...(row.file?{image:`/api/companion/drawings/${row.id}/image`}:{}),delivery:receipt?.status||'not_sent'};}
  get(id){return this.view(this.store.db.prepare('SELECT * FROM companion_drawings WHERE id=?').get(String(id)));}
  file(id){const row=this.store.db.prepare("SELECT file FROM companion_drawings WHERE id=? AND status='completed'").get(String(id));
    if(!row?.file)throw Error('画作还没有完成');const path=join(this.root,row.file);if(!existsSync(path))throw Error('画作文件暂不可用');return path;}
  submit({title,prompt,engine=this.settings().engine,share=true,caption='',autonomous=false,key}={}) {
    if(!['local','codex'].includes(engine))throw Error('请选择本机生图或 Codex 生图');
    if(engine==='codex'&&!this.codex)throw Error('Codex 生图会话尚未接入');
    title=String(title||'助手的小画').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').trim().slice(0,45);
    prompt=String(prompt||'').trim();caption=String(caption||'').trim().slice(0,400);
    if(!title||!prompt||prompt.length>3000)throw Error('请提供画作标题和 1—3000 字的画面描述');
    const anchor=this.store.db.prepare("SELECT id FROM companion_chat WHERE role='user' ORDER BY id DESC LIMIT 1").get()?.id||0;
    const dedupe=createHash('sha256').update(`${key||anchor}:${engine}:${title}:${prompt}`).digest('hex');
    const prior=this.store.db.prepare('SELECT * FROM companion_drawings WHERE dedupe=?').get(dedupe);if(prior)return this.view(prior);
    if(this.store.db.prepare("SELECT count(*) n FROM companion_drawings WHERE status IN ('queued','submitting','running')").get().n>=3)throw Error('画图队列已满，等现有画作完成再画');
    if(autonomous&&this.store.db.prepare("SELECT id FROM companion_drawings WHERE autonomous=1 AND createdAt>? LIMIT 1").get(new Date(Date.now()-6*3600000).toISOString()))throw Error('最近已经自主画过一张，先留些时间聊天');
    const id=randomUUID(),now=this.store.now();
    this.store.db.prepare('INSERT INTO companion_drawings(id,dedupe,title,prompt,status,remoteId,file,seed,share,caption,autonomous,error,createdAt,updatedAt,engine) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,dedupe,title,prompt,'queued',null,null,randomInt(2147483647),share?1:0,caption,autonomous?1:0,null,now,now,engine);
    this.onChange();void this.tick();return this.get(id);
  }
  async call(path,value,timeout=15000){const r=await fetch(this.base+path,{...(value===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}),signal:AbortSignal.timeout(timeout)});
    if(!r.ok){const error=Error(`本地画图接口 HTTP ${r.status}`);error.httpStatus=r.status;throw error;}return r.json();}
  async ensureBackend(){try{await this.call('/system_stats',undefined,3000);return;}catch{}
    const py=join(this.home,'venv/Scripts/python.exe'),main=join(this.home,'ComfyUI/main.py');
    if(!existsSync(py)||!existsSync(main))throw Error('未找到本机 QwenImage 安装');
    const out=openSync(join(this.home,'_logs/hub-comfyui.out.log'),'a'),err=openSync(join(this.home,'_logs/hub-comfyui.err.log'),'a');
    try{const child=this.spawnProcess(py,['-s',main,'--listen','127.0.0.1','--port','8188','--lowvram','--reserve-vram','0.3','--disable-pinned-memory'],{cwd:join(this.home,'ComfyUI'),windowsHide:true,detached:true,stdio:['ignore',out,err]});const owner={child,pid:child.pid,startedAt:Date.now(),failed:false};this.backendOwner=owner;child.on('error',()=>{owner.failed=true;});child.unref();}finally{closeSync(out);closeSync(err);}
    for(let i=0;i<45;i++){if(this.closed)return;await this.wait(2000);try{await this.call('/system_stats',undefined,2000);return;}catch{}}
    throw Error('本地生图服务启动未就绪；请查看 QwenImage 日志');
  }
  workflow(row){const wf=JSON.parse(readFileSync(join(this.home,'workflows/qwen21_fusal_t2i_api.json'),'utf8'));
    // Use the installed 4-bit model rather than loading 14 GB bf16 weights.
    wf['1']={class_type:'UnetLoaderGGUF',inputs:{unet_name:'qwen-image-2.1-Q4_K_M.gguf'}};
    wf['5'].inputs.prompt=`fusal style. [TASK: TEXT_TO_IMAGE]\n${row.prompt}`;
    wf['5'].inputs.resolution=512;wf['6'].inputs={width:512,height:512,batch_size:1};
    wf['7'].inputs.seed=row.seed;wf['7'].inputs.steps=20;
    wf['9'].inputs.filename_prefix=`mornye/${row.id}`;return wf;}
  async send(id){const row=this.store.db.prepare("SELECT * FROM companion_drawings WHERE id=? AND status='completed'").get(String(id));if(!row)throw Error('画作还没有完成');
    this.store.enqueueAttachment({artifactId:`drawing:${id}`,filePath:this.file(id),image:true,dedupe:`drawing:${id}`});
    await this.qq.flush();return this.get(id);}
  update(id,status,extra={}){const row=this.store.db.prepare('SELECT * FROM companion_drawings WHERE id=?').get(id);if(!row)return;
    Object.assign(row,extra,{status,updatedAt:this.store.now()});this.store.db.prepare('UPDATE companion_drawings SET status=?,remoteId=?,file=?,error=?,updatedAt=? WHERE id=?').run(row.status,row.remoteId,row.file,row.error,row.updatedAt,id);this.onChange();}
  async tick(){if(this.closed)return;await this.resourceReady;await Promise.all(['codex','local'].map(engine=>this.tickEngine(engine)));}
  async tickEngine(engine){if(this.closed||this.busyEngines.has(engine))return;this.busyEngines.add(engine);this.busy=true;let row,renderFinished=false;
    try {
      const unsent=this.store.db.prepare("SELECT * FROM companion_drawings d WHERE engine=? AND status='completed' AND share=1 AND NOT EXISTS(SELECT 1 FROM attachment_outbox a WHERE a.dedupe='drawing:'||d.id) ORDER BY createdAt LIMIT 1").get(engine);
      if(unsent){if(unsent.caption)this.store.enqueue(unsent.caption,`drawing-caption:${unsent.id}`);await this.send(unsent.id);}
      row=this.store.db.prepare("SELECT * FROM companion_drawings WHERE engine=? AND status IN ('submitting','running') ORDER BY createdAt LIMIT 1").get(engine);
      if(!row)row=this.store.db.prepare("SELECT * FROM companion_drawings WHERE engine=? AND status='queued' ORDER BY createdAt LIMIT 1").get(engine);
      if(row?.engine==='codex'){
        if(!this.codex){this.update(row.id,'failed',{error:'Codex 生图会话尚未接入'});return;}
        if(row.status==='submitting'){this.update(row.id,'uncertain',{error:'Codex 派发回执中断，保留原任务，不自动重复生成'});return;}
        if(row.status==='queued'){
          this.update(row.id,'submitting');
          try{const remoteId=await this.codex.submit(row);this.update(row.id,'running',{remoteId});}
          catch(error){this.update(row.id,'uncertain',{error:'Codex 生图提交未确认：'+String(error.message).slice(0,500)});}
          return;
        }
        const result=await this.codex.poll(row);
        if(result.status==='completed'){
          if(!result.file||resolve(result.file)!==join(this.root,basename(result.file)))throw Error('Codex 图片没有归入画作目录');
          this.update(row.id,'completed',{file:basename(result.file)});
          if(row.share){if(row.caption)this.store.enqueue(row.caption,`drawing-caption:${row.id}`);await this.send(row.id);}
        }else if(['failed','uncertain'].includes(result.status))this.update(row.id,result.status,{error:result.error||'Codex 未返回可用图片'});
        return;
      }
      if(row&&this.coordinator&&!this.localLeases.has(row.id)){
        this.localLeases.set(row.id,await this.coordinator.acquire({owner:`drawing:${row.id}`,kind:'heavy',priority:0,...(this.resourceEstimate||{})}));
      }
      if(row?.status==='submitting'){this.update(row.id,'uncertain',{error:'提交回执中断，未自动重复画图。请核对 ComfyUI 队列。'});return;}
      if(!row)return;
      if(row.status==='queued'){
        await this.ensureBackend();if(this.closed)return;
        this.update(row.id,'submitting');let response;
        this.store.db.prepare('UPDATE companion_drawings SET backendBase=? WHERE id=?').run(this.base,row.id);
        try{response=await this.call('/prompt',{prompt:this.workflow(row),client_id:`hub-drawing:${row.id}`},30000);}
        catch(error){const failed=error.httpStatus>=400&&error.httpStatus<500;this.update(row.id,failed?'failed':'uncertain',{error:`提交结果：${error.message}；不自动重发`});if(failed)this.releaseLocalLease(row.id);return;}
        if(!response.prompt_id){this.update(row.id,'failed',{error:'ComfyUI 没有接受画图任务'});this.releaseLocalLease(row.id);return;}
        this.update(row.id,'running',{remoteId:response.prompt_id});return;
      }
      const history=await this.call(`/history/${encodeURIComponent(row.remoteId)}`),entry=history[row.remoteId];
      if(!entry){if(Date.now()-Date.parse(row.updatedAt)>2*3600000)this.update(row.id,'uncertain',{error:'超过两小时未取得完成事件，保留原任务不重复提交'});return;}
      if(entry.status?.status_str==='error'){const event=entry.status.messages?.find(x=>x[0]==='execution_error')?.[1];this.update(row.id,'failed',{error:String(event?.exception_message||'本地模型生成失败').slice(0,700)});this.releaseLocalLease(row.id);return;}
      if(!entry.status?.completed||entry.status?.status_str!=='success')return;
      renderFinished=true;
      const image=Object.values(entry.outputs||{}).flatMap(x=>x.images||[]).find(x=>x.type==='output');if(!image)throw Error('模型完成但没有输出图片');
      const query=new URLSearchParams({filename:image.filename,subfolder:image.subfolder||'',type:'output'});
      const response=await fetch(`${this.base}/view?${query}`,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('读取生成图片失败');
      if(Number(response.headers.get('content-length'))>8*1024*1024)throw Error('生成图片超过 QQ 图片大小限制');
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw Error('生成图片过大');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('生成结果不是 PNG 图片');
      let filename=`${row.title}.png`,n=2;while(existsSync(join(this.root,filename)))filename=`${row.title}（${n++}）.png`;
      writeFileSync(join(this.root,filename),bytes);this.update(row.id,'completed',{file:filename});renderFinished=false;
      if(row.share){if(row.caption)this.store.enqueue(row.caption,`drawing-caption:${row.id}`);await this.send(row.id);}
      // Release model RAM/VRAM after an idle queue; never interrupt another job.
      try{const queue=await this.call('/queue');if(this.canFreeBackend(queue))await this.call('/free',{unload_models:true,free_memory:true});}catch{}
      this.releaseLocalLease(row.id);
    }catch(error){if(row){if(row.status==='queued'||renderFinished)this.update(row.id,'failed',{error:error.message});else this.store.meta('drawing:last-poll-error',String(error.message).slice(0,500));if(row.status==='queued'||renderFinished)this.releaseLocalLease(row.id);}}
    finally{this.busyEngines.delete(engine);this.busy=this.busyEngines.size>0;}
  }
  ownedBackendAlive(){const owner=this.backendOwner;return !!owner&&Number.isSafeInteger(owner.pid)&&owner.pid>0&&!owner.failed&&owner.child?.exitCode===null&&!owner.child?.killed;}
  canFreeBackend(queue){return this.ownedBackendAlive()&&Array.isArray(queue?.queue_running)&&Array.isArray(queue?.queue_pending)&&queue.queue_running.length===0&&queue.queue_pending.length===0;}
  releaseLocalLease(id){const lease=this.localLeases.get(id);if(!lease)return;this.localLeases.delete(id);this.coordinator?.release(lease);}
  recoveryPreview(id){
    const row=this.store.db.prepare('SELECT * FROM companion_drawings WHERE id=?').get(String(id));
    if(!row)throw Error('绘图记录不存在');
    return {jobId:row.id,status:row.status,remoteId:row.remoteId,updatedAt:row.updatedAt,version:drawingRecoveryVersion(row),recoveryAbandoned:!!this.recovery.abandonedDrawing(row)};
  }
  async abandonResourceRecovery(request){
    await this.resourceReady;
    const generation=this.coordinator?.generation;
    const result=this.recovery.abandonDrawing({...request,assertInactive:()=>{
      const lease=this.localLeases.get(request.jobId);
      if(this.busy||this.busyEngines.size||this.coordinator?.state().queued||this.coordinator?.generation!==generation||lease&&lease.recovery!==true)
        throw Object.assign(Error('绘图活动或资源版本已变化，保留预算保护'),{statusCode:409});
    }});
    this.releaseLocalLease(request.jobId);this.onChange();return result;
  }
  async reconcileResourceLeases(recovery){
    await this.resourceReady;
    const results=[];
    // Explicit maintenance only. GET/status/startup never starts a backend or
    // discards an unknown reservation. A live, validated idle queue is required.
    for(const [id,lease] of this.localLeases){
      const row=this.store.db.prepare('SELECT id,status,remoteId,updatedAt,backendBase FROM companion_drawings WHERE id=?').get(id);
      if(this.busy||this.coordinator.state().queued||row?.status!=='uncertain'||!row.remoteId)continue;
      if(!row.backendBase||row.backendBase!==this.base){results.push({id,status:'pending',reason:row.backendBase?'backend-source-changed':'backend-source-missing'});continue;}
      const generation=this.coordinator.generation;
      let queue;
      try{queue=await this.call('/queue',undefined,3000);}catch{results.push({id,status:'pending',reason:'backend-unavailable'});continue;}
      const current=this.store.db.prepare('SELECT status,remoteId,updatedAt,backendBase FROM companion_drawings WHERE id=?').get(id);
      if(!validIdleDrawingQueue(queue)||this.busy||this.coordinator.generation!==generation||this.coordinator.state().queued
        ||current?.status!==row.status||current.remoteId!==row.remoteId||current.updatedAt!==row.updatedAt||current.backendBase!==row.backendBase||this.base!==row.backendBase){results.push({id,status:'pending',reason:'activity-or-source-changed'});continue;}
      // Only the budget is reconciled. The unknown image result and send state
      // remain untouched; a future restart must obtain fresh proof again.
      recovery.record({owner:lease.owner,jobId:id,sourceUpdatedAt:row.updatedAt,status:'budget-released',evidence:{source:'comfyui:/queue',backendBase:row.backendBase,queueRunning:0,queuePending:0,remoteId:row.remoteId,generation,businessOutcome:'unknown'}});
      this.releaseLocalLease(id);results.push({id,status:'budget-released',businessOutcome:'unknown'});
    }
    return {results};
  }
  start(){this.closed=false;this.timer=setInterval(()=>void this.tick(),4000);this.timer.unref();void this.tick();}
  async close(){this.closed=true;clearInterval(this.timer);while(this.busy)await new Promise(r=>setTimeout(r,100));}
}
