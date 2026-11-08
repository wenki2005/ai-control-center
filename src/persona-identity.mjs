import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENABLED='persona:qq-sync-enabled';
const safeId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value);

export class PersonaIdentity {
  constructor({store,qq=null,voice=null,publicRoot,onChange=()=>{}}) {
    Object.assign(this,{store,qq,voice,publicRoot:resolve(publicRoot),onChange});
    this.queue=Promise.resolve();this.generation=0;this.state={status:'disabled',source:{qq:qq?'configured':'unavailable',voice:voice?'configured':'unavailable'},nickname:{status:'idle'},avatar:{status:'idle'},voice:{status:'idle'},error:null,updatedAt:null};
  }
  status(){return {enabled:this.store.meta(ENABLED)==='true',status:this.state.status,source:{...this.state.source},nickname:{...this.state.nickname},avatar:{...this.state.avatar},voice:{...this.state.voice},error:this.state.error,updatedAt:this.state.updatedAt};}
  async freshProfile(account){
    const profile=await this.qq.call('get_stranger_info',{user_id:account.user_id,no_cache:true});
    if(profile&&typeof profile.nickname==='string'){
      if(profile.user_id!==undefined&&String(profile.user_id)!==String(account.user_id))throw Error('QQ资料身份不匹配');
      return {...account,...profile};
    }
    // Compatibility with bridges that return an empty optional profile response.
    return this.qq.call('get_login_info',{});
  }
  async configure({enabled}){if(typeof enabled!=='boolean')throw new TypeError('enabled必须是布尔值');this.store.meta(ENABLED,enabled?'true':'false');this.generation++;if(!enabled)this.state.status='disabled';this.state.updatedAt=new Date().toISOString();this.onChange(this.status());return this.status();}
  async #avatarPath(avatar){
    if(typeof avatar!=='string'||!avatar||/^(?:https?:|data:|file:)/i.test(avatar)||isAbsolute(avatar)||avatar.includes('..')||avatar.includes('\\'))throw Error('头像必须是public目录中的受支持文件');
    const allowed=avatar==='mornye-avatar.png'||/^persona-avatars\/[A-Za-z0-9_-]+\.(?:png|webp|jpe?g)$/i.test(avatar);
    if(!allowed)throw Error('头像文件名不受支持');
    const root=await realpath(this.publicRoot),file=await realpath(resolve(root,avatar));
    const rel=relative(root,file);if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw Error('头像路径越界');
    const data=await readFile(file);if(data.length>8*1024*1024)throw Error('头像文件超过8MB');return {file,data};
  }
  async sync({persona,personaId}){
    const generation=++this.generation;
    const operation=async()=>{
      if(generation!==this.generation)return this.status();
      const result={personaId:String(personaId||''),nickname:{status:'skipped'},avatar:{status:'skipped'},voice:{status:'skipped'},error:null,updatedAt:new Date().toISOString()};
      this.state={...this.state,...result,status:'syncing'};this.onChange(this.status());
      if(this.voice&&persona?.voiceProfileId){try{await this.voice.selectProfile(persona.voiceProfileId,{isCurrent:()=>generation===this.generation});result.voice={status:'confirmed',profileId:persona.voiceProfileId};}catch{result.voice={status:'failed'};result.error='音色切换失败';}}
      if(generation!==this.generation)return this.status();
      if(this.store.meta(ENABLED)!=='true'||!this.qq){result.nickname={status:this.qq?'disabled':'unavailable'};result.avatar={status:this.qq?'disabled':'unavailable'};this.state={...this.state,...result,status:result.voice.status==='failed'?'partial':'disabled'};this.onChange(this.status());return this.status();}
      const nickname=String(persona?.qqNickname||persona?.name||'').trim().slice(0,40);
      const avatar=persona?.avatar;
      const hash=value=>createHash('sha256').update(value).digest('hex');
      const confirmed=JSON.parse(this.store.meta('persona:qq-confirmed')||'{}');
      let account;try{account=await this.qq.call('get_login_info',{});}catch{result.nickname={status:'unknown'};result.avatar={status:'unknown'};result.error='本机QQ身份无法确认';this.state={...this.state,...result,status:'unknown'};this.onChange(this.status());return this.status();}
      if(generation!==this.generation)return this.status();
      const accountId=String(account?.user_id||'');if(!accountId){result.error='本机QQ身份无法确认';this.state={...this.state,...result,status:'unknown'};this.onChange(this.status());return this.status();}
      if(confirmed.account!==accountId){for(const k of Object.keys(confirmed))delete confirmed[k];confirmed.account=accountId;this.store.meta('persona:qq-confirmed',JSON.stringify(confirmed));}
      try{
        if(nickname){const fp=hash(Buffer.from(nickname)),profile=await this.freshProfile(account);if(generation!==this.generation)return this.status();if(profile.nickname===nickname){confirmed.nickname=fp;delete confirmed.nicknameUnknown;this.store.meta('persona:qq-confirmed',JSON.stringify(confirmed));result.nickname={status:'confirmed',verification:'profile-readback'};}else if(confirmed.nicknameUnknown===fp){result.nickname={status:'unknown'};}else{
          try{await this.qq.call('set_qq_profile',{nickname});}catch(error){if(error?.uncertain){confirmed.nicknameUnknown=fp;this.store.meta('persona:qq-confirmed',JSON.stringify(confirmed));}result.nickname={status:error?.uncertain?'unknown':'failed'};result.error=error?.uncertain?'QQ昵称修改结果未知':'QQ昵称修改失败';}
          if(generation!==this.generation)return this.status();
          if(result.nickname.status!=='failed'&&result.nickname.status!=='unknown'){const info=await this.freshProfile(account);if(generation!==this.generation)return this.status();if(String(info?.user_id)!==String(account.user_id)||info?.nickname!==nickname){result.nickname={status:'failed'};result.error??='QQ昵称回读不匹配';}else{confirmed.nickname=fp;delete confirmed.nicknameUnknown;this.store.meta('persona:qq-confirmed',JSON.stringify(confirmed));result.nickname={status:'confirmed',verification:'profile-readback'};}}
        }}
      }catch{result.nickname={status:'unknown'};result.error??='QQ昵称核验结果未知';}
      try{
        const checked=await this.#avatarPath(avatar),fp=hash(checked.data);
        if(generation!==this.generation)return this.status();
        if(confirmed.avatar===fp)result.avatar={status:'confirmed'};else if(confirmed.avatarUnknown===fp)result.avatar={status:'unknown'};else{
          try{await this.qq.call('set_qq_avatar',{file:pathToFileURL(checked.file).href});if(generation!==this.generation)return this.status();confirmed.avatar=fp;delete confirmed.avatarUnknown;this.store.meta('persona:qq-confirmed',JSON.stringify(confirmed));result.avatar={status:'confirmed'};}
          catch(error){if(error?.uncertain){confirmed.avatarUnknown=fp;this.store.meta('persona:qq-confirmed',JSON.stringify(confirmed));result.avatar={status:'unknown'};result.error??='QQ头像设置结果未知';}else{result.avatar={status:'failed'};result.error??='QQ头像设置失败';}}
        }
      }catch{result.avatar={status:'failed'};result.error??='头像文件无效或不可用';}
      if(generation!==this.generation)return this.status();
      const statuses=[result.nickname.status,result.avatar.status,result.voice.status];const status=statuses.some(s=>s==='unknown')?'unknown':statuses.some(s=>s==='failed')?'partial':statuses.every(s=>s==='confirmed'||s==='skipped'||s==='disabled')?'confirmed':'partial';
      this.state={...this.state,...result,status};this.onChange(this.status());return this.status();
    };
    const pending=this.queue.then(operation,operation);this.queue=pending.catch(()=>{});return pending;
  }
}
