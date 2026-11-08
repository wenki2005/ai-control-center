import { mkdirSync, realpathSync, existsSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs';
import {SingingLibrary} from './singing-library.mjs';
import { resolve, join, extname, relative, isAbsolute, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const AUDIO = new Set(['.wav','.mp3','.flac','.m4a','.ogg','.aac','.wma','.opus']);
const now = () => new Date().toISOString();

export class CompanionSinging {
  constructor({store,root,runtimeRoot,python,script,profiles=[],allowedRoots=[],libraryRoots=[],generator=null,originalEngine=null,owner='control-center',recoverInterrupted=true,spawnImpl=spawn}) {
    Object.assign(this,{store,python,script,profiles,spawnImpl,generator,originalEngine,owner});
    this.library=new SingingLibrary({roots:libraryRoots});
    this.root=resolve(root); this.runtimeRoot=resolve(runtimeRoot); this.allowedRoots=allowedRoots.map(x=>realpathSync(resolve(x)));
    mkdirSync(this.root,{recursive:true}); mkdirSync(this.runtimeRoot,{recursive:true}); this.active=false; this.closed=false;this.queue=Promise.resolve();this.pending=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_singing_jobs(id TEXT PRIMARY KEY,dedupe TEXT UNIQUE,title TEXT NOT NULL,profileId TEXT NOT NULL,sourcePath TEXT NOT NULL,resultPath TEXT,status TEXT NOT NULL,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,sourceType TEXT NOT NULL DEFAULT 'mixed')`);
    if(!store.db.prepare('PRAGMA table_info(companion_singing_jobs)').all().some(c=>c.name==='sourceType'))store.db.exec("ALTER TABLE companion_singing_jobs ADD COLUMN sourceType TEXT NOT NULL DEFAULT 'mixed'");
    for(const [column,definition]of [['mode',"TEXT NOT NULL DEFAULT 'cover'"],['options',"TEXT NOT NULL DEFAULT '{}' "]])if(!store.db.prepare('PRAGMA table_info(companion_singing_jobs)').all().some(c=>c.name===column))store.db.exec(`ALTER TABLE companion_singing_jobs ADD COLUMN ${column} ${definition}`);
    if(recoverInterrupted){const own="COALESCE(json_extract(options,'$.owner'),'control-center')=?";store.db.prepare(`UPDATE companion_singing_jobs SET status='interrupted',error='歌声服务重启时任务仍在运行；不会自动重试',updatedAt=? WHERE status='running' AND ${own}`).run(now(),owner);store.db.prepare(`UPDATE companion_singing_jobs SET status='failed',error='歌声服务重启后无法恢复排队参数；不会自动重试',updatedAt=? WHERE status='queued' AND ${own}`).run(now(),owner);}
    this.queue=Promise.resolve();
  }
  view(r){if(!r)return null;let options={};try{options=JSON.parse(r.options||'{}');}catch{}return {id:r.id,title:r.title,profileId:r.profileId,mode:r.mode||'cover',performance:options.performance||'song',durationSeconds:options.durationSeconds||null,requestedSong:options.requestedSong||null,sourceSelection:options.sourceSelection||'user-file',sourcePath:r.sourcePath,resultPath:r.resultPath,status:r.status,error:r.error,createdAt:r.createdAt,updatedAt:r.updatedAt};}
  list(){return this.store.db.prepare('SELECT * FROM companion_singing_jobs ORDER BY createdAt DESC LIMIT 30').all().map(r=>this.view(r))}
  get(id){return this.view(this.store.db.prepare('SELECT * FROM companion_singing_jobs WHERE id=?').get(String(id)))}
  status(){return {busy:this.active,closed:this.closed,ready:existsSync(this.python)&&existsSync(this.script),originalReady:!!this.generator&&existsSync(this.generator.python)&&existsSync(this.generator.script)&&(!this.generator.readyFile||existsSync(this.generator.readyFile)),originalEngine:this.originalEngine?.status()||{state:'on-demand'},defaultDurationSeconds:this.generator?.defaultDurationSeconds||6,sourceRequired:false,profiles:this.profiles.map(({id,label})=>({id,label})),jobs:this.list()}}
  profile(id){const p=this.profiles.find(x=>x.id===id);if(!p)throw Error('未知音色配置');return p}
  source(path){const candidate=resolve(String(path||'')); if(!existsSync(candidate))throw Error('音频文件不存在'); const real=realpathSync(candidate); if(!statSync(real).isFile()||statSync(real).size===0||!AUDIO.has(extname(real).toLowerCase()))throw Error('请选择真实存在的音频文件');
    if(!this.allowedRoots.some(root=>{const rel=relative(root,real);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel))}))throw Error('音频文件不在允许目录内'); return real; }
  reference(profile){const candidate=resolve(profile.reference||'');if(!existsSync(candidate))throw Error('参考音频不存在');const real=realpathSync(candidate);if(!statSync(real).isFile()||!AUDIO.has(extname(real).toLowerCase())||statSync(real).size===0)throw Error('参考音频不是有效音频文件');return real;}
  async request({mode='auto',song='',...value}={}) {
    if(!['auto','cover','original'].includes(mode))throw Error('未知演唱方式');
    if(value.sourcePath)return this.create(value);
    if((song||mode==='cover')&&mode!=='original'){
      const selected=await this.library.find(song);
      if(selected)return this.create({...value,sourcePath:selected.path,title:value.title||selected.title,sourceSelection:'local-library',requestedSong:song});
      if(mode==='cover')throw Error('本地曲库尚未找到这首歌；可以改唱原创小调，不需要你提供音频。');
    }
    return this.compose({...value,requestedSong:song,title:song?'原创小调（不是所点歌曲原曲）':value.title});
  }
  create({sourcePath,profileId=this.store.meta?.('qq:voice-profile'),title='音色翻唱',semitones=0,key,sourceType='mixed',durationSeconds=15,startSeconds=null,fullSong=false,performance='song',sourceSelection='user-file',requestedSong=''}={}) {
    if(this.closed)throw Error('翻唱服务已关闭'); const profile=this.profile(profileId),source=this.source(sourcePath),reference=this.reference(profile);
    semitones=Number(semitones);if(!Number.isInteger(semitones)||semitones < -24||semitones > 24)throw Error('移调范围为 -24 至 24');
    if(!['mixed','vocal'].includes(sourceType))throw Error('sourceType 必须是 mixed 或 vocal');
    durationSeconds=fullSong?300:Number(durationSeconds);if(!Number.isFinite(durationSeconds)||durationSeconds<5||durationSeconds>300)throw Error('演唱片段需在5至300秒之间');
    if(startSeconds!==null&&(!Number.isFinite(Number(startSeconds))||Number(startSeconds)<0))throw Error('片段起点无效');
    if(!['a_cappella','song'].includes(performance))throw Error('未知演唱形式');
    const options={owner:this.owner,durationSeconds,performance,startSeconds:startSeconds===null?null:Number(startSeconds),sourceSelection,requestedSong};
    const dedupe=createHash('sha256').update(`${key||''}:${source}:${statSync(source).mtimeMs}:${statSync(source).size}:${profile.id}:${title}:${semitones}:${sourceType}:${JSON.stringify(options)}`).digest('hex');
    const prior=this.store.db.prepare('SELECT * FROM companion_singing_jobs WHERE dedupe=?').get(dedupe);if(prior)return this.view(prior);
    const id=randomUUID(),createdAt=now(),safeTitle=String(title).trim().slice(0,100)||'音色翻唱',dir=join(this.runtimeRoot,id);mkdirSync(dir,{recursive:true});
    const resultPath=join(dir,'singing.wav');this.store.db.prepare('INSERT INTO companion_singing_jobs(id,dedupe,title,profileId,sourcePath,resultPath,status,error,createdAt,updatedAt,sourceType) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,dedupe,safeTitle,profile.id,source,resultPath,'queued',null,createdAt,createdAt,sourceType);
    this.store.db.prepare('UPDATE companion_singing_jobs SET options=? WHERE id=?').run(JSON.stringify(options),id);
    this.schedule(id,()=>this.run(id,reference,source,resultPath,dir,semitones,sourceType,options));return this.get(id);
  }
  compose({profileId=this.store.meta?.('qq:voice-profile'),title='即兴原创小调',style='',lyrics='',durationSeconds=this.generator?.defaultDurationSeconds||6,quality,performance='a_cappella',key,requestedSong=''}={}) {
    if(this.closed)throw Error('演唱服务已关闭');
    if(!this.status().originalReady)throw Error('原创歌声引擎尚未安装就绪；这不需要你提供音乐，安装完成后即可直接唱。');
    const profile=this.profile(profileId),reference=this.reference(profile);
    durationSeconds=Number(durationSeconds);if(!Number.isFinite(durationSeconds)||durationSeconds<5||durationSeconds>30)throw Error('即兴原创片段需在5至30秒之间');
    quality=quality||(durationSeconds<=10?'fast':'balanced');if(!['fast','balanced'].includes(quality))throw Error('未知歌声质量档位');
    if(!['a_cappella','song'].includes(performance))throw Error('未知演唱形式');
    if(String(lyrics).length>1000||String(style).length>512)throw Error('请用简短歌词和风格描述');
    const singingStyle=profile.singingStyle||'expressive clear Mandarin female singing, intimate warm tone';
    const form=performance==='a_cappella'?'dry solo a cappella, voice only, relaxed unaccompanied humming, immediate vocal onset':'short intimate song';
    const options={owner:this.owner,durationSeconds,quality,performance,bpm:profile.singingBpm||82,requestedSong,sourceSelection:'generated',style:[form,singingStyle,String(style)].filter(Boolean).join(', '),lyrics:String(lyrics||'[Verse]\n啦啦啦，啦啦啦'),reference,modelRoot:this.generator.modelRoot,vocalCheckpoint:this.generator.vocalCheckpoint,device:this.generator.device||'auto'};
    const dedupe=createHash('sha256').update(JSON.stringify(['original',key||'',profile.id,title,options])).digest('hex');const previous=this.store.db.prepare('SELECT * FROM companion_singing_jobs WHERE dedupe=?').get(dedupe);if(previous)return this.view(previous);
    const id=randomUUID(),createdAt=now(),dir=join(this.runtimeRoot,id),resultPath=join(dir,'singing.wav');mkdirSync(dir,{recursive:true});
    this.store.db.prepare("INSERT INTO companion_singing_jobs(id,dedupe,title,profileId,sourcePath,resultPath,status,error,createdAt,updatedAt,sourceType,mode,options) VALUES(?,?,?,?,?,?,'queued',NULL,?,?,'vocal','original',?)").run(id,dedupe,String(title||'即兴原创小调').slice(0,100),profile.id,'',resultPath,createdAt,createdAt,JSON.stringify(options));
    const request=join(dir,'music-request.json');writeFileSync(request,JSON.stringify(options),'utf8');this.schedule(id,()=>this.run(id,reference,'',resultPath,dir,0,'vocal',options,{python:this.generator.python,args:[this.generator.script,'--request',request,'--output',dir]}));return this.get(id);
  }
  schedule(id,run){const completion=this.queue.then(run);this.queue=completion.catch(()=>{});this.pending.set(id,completion);completion.finally(()=>this.pending.delete(id));}
  async run(id,reference,source,result,dir,semitones,sourceType,options={},runner=null){
    if(this.closed){this.store.db.prepare("UPDATE companion_singing_jobs SET status='failed',error='服务关闭前任务未启动',updatedAt=? WHERE id=?").run(now(),id);return;}
    this.active=true; const update=(status,error=null)=>this.store.db.prepare('UPDATE companion_singing_jobs SET status=?,error=?,updatedAt=? WHERE id=?').run(status,error,now(),id);
    update('running'); let out,err;
    try {out=openSync(join(dir,'stdout.log'),'a');err=openSync(join(dir,'stderr.log'),'a');
      const args=runner?.args||[this.script,'--source',source,'--target',reference,'--output',dir,'--source-mode',sourceType,'--clip-duration',String(options.durationSeconds||15),'--clip-start',options.startSeconds===null?'auto':String(options.startSeconds||0),'--diffusion-steps','30','--length-adjust','1','--inference-cfg-rate','.7','--f0-condition','True','--auto-f0-adjust','False','--semi-tone-shift',String(semitones),'--fp16','False',...(options.performance==='a_cappella'?['--vocal-only']:[])];
      if(runner&&this.originalEngine)await this.originalEngine.generate(options,dir);
      else await new Promise((resolvePromise,reject)=>{let child;try{child=this.spawnImpl(runner?.python||this.python,args,{cwd:resolve(runner?this.generator.script:this.script,'..'),windowsHide:true,stdio:['ignore',out,err],env:{...process.env,...(!runner?{CUDA_VISIBLE_DEVICES:process.env.CUDA_VISIBLE_DEVICES||'-1'}:{})}})}catch(e){reject(e);return} child.once('error',reject);child.once('close',(code,signal)=>code===0?resolvePromise():reject(Error(`歌声引擎进程失败 (code=${code}, signal=${signal||'none'})`)));});
      if(!existsSync(result))throw Error('进程成功退出但未生成有效音频');const output=realpathSync(result),base=realpathSync(dir),rel=relative(base,output);if(!statSync(output).isFile()||!AUDIO.has(extname(output).toLowerCase())||statSync(output).size===0||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('进程成功退出但未生成有效音频'); update('completed');
    } catch(e){update('failed',String(e?.message||e).slice(0,1000));}
    finally{if(out!==undefined)closeSync(out);if(err!==undefined)closeSync(err);this.active=false;}
  }
  async close(){this.closed=true;await this.queue;await Promise.allSettled([...this.pending.values()]);}
}
