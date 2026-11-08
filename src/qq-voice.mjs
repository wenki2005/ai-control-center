import {mkdir,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {VoiceDelivery} from './qq-voice-delivery.mjs';

const META_PROFILE='qq:voice-profile';
function loopback(endpoint) {
  const url=new URL(endpoint);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('语音服务只允许本机地址');
  return url.toString().replace(/\/$/,'');
}
function validId(id){return typeof id==='string' && /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(id);}

export class QqVoice {
  constructor({store,root,endpoint='http://127.0.0.1:9892',python,script,configuration='same-source-SoVITS8+GPT2-configured-LR',voiceProfile='gentle',profiles,defaultProfile,fetchImpl=globalThis.fetch,coordinator=null,resourceEstimate=null}) {
    const legacy={id:'mornye',label:'助手·已确认音色',endpoint,python,script,configuration,voiceProfile};
    this.profiles=(profiles?.length?profiles:[legacy]).map(p=>{
      if(!validId(p.id)||typeof p.label!=='string'||!p.label.trim()||typeof p.configuration!=='string'||!p.configuration.trim())throw Error('音色配置无效');
      return {...p,endpoint:loopback(p.endpoint)};
    });
    if(new Set(this.profiles.map(p=>p.id)).size!==this.profiles.length)throw Error('音色ID重复');
    this.defaultProfileId=defaultProfile||this.profiles[0].id;
    if(!this.profiles.some(p=>p.id===this.defaultProfileId))throw Error('默认音色不存在');
    Object.assign(this,{store,root,fetchImpl,coordinator,resourceEstimate});
    this.profileSelectionRevision=0;
    this.delivery=store?.db?new VoiceDelivery({store,voice:this}):null;
  }
  getProfile(id){return this.profiles.find(p=>p.id===id)||null;}
  profileId(){const stored=this.store.meta(META_PROFILE);return this.getProfile(stored)?stored:this.defaultProfileId;}
  currentProfile(){return this.getProfile(this.profileId());}
  status(){const p=this.currentProfile();return {configured:true,enabled:this.enabled(),profileId:p.id,profiles:this.profiles.map(({id,label})=>({id,label})),engine:p.label,maxCharacters:180,scope:'all-text',chunkCharacters:120};}
  async selectProfile(id,{isCurrent=()=>true}={}){
    const profile=this.getProfile(id);if(!profile)throw Error('未知音色');
    const revision=++this.profileSelectionRevision;
    await this.ready(profile);
    if(revision!==this.profileSelectionRevision||!isCurrent())throw Error('音色选择已被更新请求取代');
    this.store.meta(META_PROFILE,id);
    return this.status();
  }
  enabled(){return this.store.meta('qq:voice-enabled')==='true';}
  setEnabled(value){const wasEnabled=this.enabled();this.store.meta('qq:voice-enabled',value?'true':'false');if(value&&(!wasEnabled||!this.store.meta('qq:voice-enabled-at')))this.store.meta('qq:voice-enabled-at',new Date().toISOString());}
  shouldSpeak(row,{kind}={}) {
    if(!this.enabled() || !this.getProfile(this.profileId()))return false;
    const since=Date.parse(this.store.meta('qq:voice-enabled-at')||'');
    if(Number.isFinite(since) && Date.parse(row.createdAt)<since)return false;
    const text=String(row.text||'');
    return text.trim().length>0;
  }
  async ready(profile=this.currentProfile()) {
    const probe=async()=>{
      const response=await this.fetchImpl(profile.endpoint+'/health',{signal:AbortSignal.timeout(2000)});
      const h=await response.json();
      if(!response.ok || h.service!=='mornye-local-tts' || h.status!=='ready' || h.configuration!==profile.configuration)throw Error('所选音色尚未就绪');
    };
    try{await probe();return;}catch(error){if(!profile.python||!profile.script||!error.cause?.code?.includes('ECONNREFUSED'))throw error;}
    if(!this.starting)this.starting=new Map();
    if(!this.starting.has(profile.id))this.starting.set(profile.id,(async()=>{
      const child=spawn(profile.python,['-u',profile.script],{windowsHide:true,detached:true,stdio:'ignore'});
      let launchError;child.on('error',error=>{launchError=error;});child.unref();
      for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,1000));if(launchError)throw launchError;try{await probe();return;}catch{}}
      throw Error('本地音色加载超时');
    })().finally(()=>this.starting.delete(profile.id)));
    await this.starting.get(profile.id);
  }
  prepareDelivery(row){return this.delivery.prepare(row);}
  deliverPrepared(plan,options){return this.delivery.send(plan,options);}
  async synthesize(text,options={}) {
    if(!this.coordinator)return this.synthesizeUncoordinated(text,options);
    const estimate=this.resourceEstimate||{};
    return this.coordinator.run({owner:'qq-voice-synthesis',kind:'light',priority:100,...estimate},()=>this.synthesizeUncoordinated(text,options));
  }
  async synthesizeUncoordinated(text,{profile=this.currentProfile()}={}) {
    if(typeof text!=='string'||!text.trim()||text.length>180)throw Error('语音正文需在180字以内');
    const key=createHash('sha256').update(JSON.stringify([profile.id,profile.configuration,profile.voiceProfile,text])).digest('hex').slice(0,24);
    const file=join(this.root,'助手语音-'+key+'.wav');
    try{if((await stat(file)).size>44)return file;}catch{}
    const cooldown='qq:voice-timeout:'+profile.id;
    if(Number(this.store.meta(cooldown))>Date.now())throw Object.assign(Error('本地语音刚发生合成超时，本条先保留文字'),{voiceFallback:true,uncertain:false});
    try{
    await this.ready(profile);
    const response=await this.fetchImpl(profile.endpoint+'/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice:profile.voiceProfile}),signal:AbortSignal.timeout(60000)});
    if(!response.ok||response.headers.get('x-sample-rate')!=='32000')throw Error('本地语音合成未返回正确音频');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw Error('合成音频超过限制');chunks.push(chunk);}
    const pcm=Buffer.concat(chunks);if(pcm.length<6400 || pcm.length%2)throw Error('合成音频为空或损坏');
    const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(32000,24);header.writeUInt32LE(64000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
    await mkdir(this.root,{recursive:true});await writeFile(file,Buffer.concat([header,pcm]));return file;
    }catch(error){
      if(['TimeoutError','AbortError'].includes(error.name)||/timed?\s*out|due to timeout/i.test(error.message)){
        this.store.meta(cooldown,String(Date.now()+60000));
        error.voiceFallback=true;error.uncertain=false;
      }
      throw error;
    }
  }
}
