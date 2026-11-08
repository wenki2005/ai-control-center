import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,appendFileSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

// One resident model process, private stdio transport, no HTTP inference port.
// A lost result fails the current job; generation is never silently replayed.
export class SingingEngine {
  constructor({config,root,spawnImpl=spawn,startTimeoutMs=180000,renderTimeoutMs=180000}) {
    root=resolve(root);Object.assign(this,{config,root,spawnImpl,startTimeoutMs,renderTimeoutMs});
    this.child=null;this.starting=null;this.state='cold';this.pending=new Map();this.closed=false;this.error=null;
    mkdirSync(root,{recursive:true});this.log=join(root,'resident.log');
  }
  status(){return {state:this.state,error:this.error,busy:this.pending.size>0};}
  warm(){
    if(this.closed)return Promise.reject(Error('歌声引擎已关闭'));
    if(this.state==='ready')return Promise.resolve();
    if(this.starting)return this.starting;
    this.state='loading';this.error=null;
    this.starting=new Promise((resolve,reject)=>{
      const configuration=join(this.root,'resident-config.json');writeFileSync(configuration,JSON.stringify(this.config));
      const python=this.config.python.replace(/pythonw\.exe$/i,'python.exe');
      let child;try{child=this.spawnImpl(python,[this.config.script,'--resident-config',configuration],{cwd:dirname(this.config.script),windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}});}catch(e){this.state='failed';reject(e);return;}
      this.child=child;
      const timer=setTimeout(()=>{fail(Error('歌声引擎预热超时'));child.kill();},this.startTimeoutMs);timer.unref?.();
      let ready=false,failed=false;
      const fail=error=>{if(failed||this.child!==child)return;failed=true;clearTimeout(timer);this.state='failed';this.error=String(error.message||error).slice(0,300);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();if(!ready)reject(error);};
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        if(!line.startsWith('@@SINGING ')){appendFileSync(this.log,line+'\n');return;}
        let message;try{message=JSON.parse(line.slice(10));}catch{return;}
        if(message.type==='ready'){ready=true;clearTimeout(timer);this.state='ready';resolve();return;}
        const waiting=this.pending.get(message.id);if(!waiting)return;
        this.pending.delete(message.id);clearTimeout(waiting.timer);
        if(message.type==='completed')waiting.resolve(message.evidence);
        else waiting.reject(Error(String(message.error||'歌声生成失败').slice(0,300)));
      });
      child.stderr.on('data',data=>appendFileSync(this.log,data));
      child.stdin.on('error',error=>fail(error));
      child.once('error',fail);
      child.once('close',(code)=>{lines.close();if(this.child!==child)return;if(!this.closed)fail(Error(`常驻歌声引擎退出（${code}）`));this.child=null;});
    }).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async generate(request,output){
    output=resolve(output);
    await this.warm();if(this.pending.size)throw Error('常驻歌声引擎忙碌，需按既有队列执行');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);this.error='歌声生成超时；不自动重放';this.state='failed';reject(Error(this.error));this.child?.kill();},this.renderTimeoutMs);timer.unref?.();
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({type:'generate',id,request,output})+'\n',error=>{if(error){const item=this.pending.get(id);if(item){clearTimeout(timer);this.pending.delete(id);item.reject(error);}}});
    });
  }
  async close(){
    if(this.pending.size)throw Error('演唱仍在进行，不能关闭引擎');
    this.closed=true;const child=this.child;if(!child)return;
    await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();},5000);timer.unref?.();child.once('close',()=>{clearTimeout(timer);resolve();});child.stdin.end(JSON.stringify({type:'shutdown'})+'\n');});
  }
}
