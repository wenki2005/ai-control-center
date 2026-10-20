import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import WebSocket from 'ws';
import { QQ_SHAREABLE_EXTENSIONS } from './knowledge/share-policy.mjs';

export const QQ_CONFIG = process.env.HUB_QQ_CONFIG || 'runtime/qq-config.json';
export const OWNER = process.env.HUB_QQ_OWNER || '';
export function loadQqConfig(file=QQ_CONFIG) {
  const config=JSON.parse(readFileSync(file,'utf8'));
  const one=config.snowluma || {};
  for(const endpoint of [one.httpUrl || 'http://127.0.0.1:3000',one.wsUrl || 'ws://127.0.0.1:3001']) {
    const url=new URL(endpoint);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('QQ 凭据只允许发送到本机 OneBot 服务');
  }
  return {httpUrl:one.httpUrl || 'http://127.0.0.1:3000',wsUrl:one.wsUrl || 'ws://127.0.0.1:3001',
    httpToken:one.httpAccessToken || one.accessToken || '',wsToken:one.accessToken || ''};
}
export function isHubCommand(text) { return /^\/(?:中枢|hub)(?:\s|$)/i.test(String(text).trim()); }
function imageName(data) {
  const value=String(data?.file || data?.name || data?.url || '').trim();
  return basename(value.split(/[?#]/,1)[0]) || '';
}
function segmentText(part) {
  const data=part?.data || {};
  switch(String(part?.type || '')) {
    case 'text': return String(data.text || '');
    case 'image': return `[图片${imageName(data)?`：${imageName(data)}`:''}]`;
    case 'face': case 'mface': case 'marketface': {
      const label=String(data.text || data.summary || data.name || data.id || '').trim();
      return `[表情${label?`：${label}`:''}]`;
    }
    case 'reply': return `[引用消息${data.id?`：${data.id}`:''}]`;
    case 'at': return `[提及：${data.name || data.qq || ''}]`;
    case 'file': return `[文件${data.name?`：${data.name}`:''}]`;
    case 'record': return '[语音消息]';
    case 'video': return '[视频消息]';
    case 'json': case 'xml': return `[${part.type}消息]`;
    default: return '';
  }
}
function rawMessageText(value) {
  return String(value || '').replace(/\[CQ:([^,\]]+)([^\]]*)\]/g,(_,type,attrs)=>{
    const data={};for(const pair of String(attrs).split(',')){const index=pair.indexOf('=');if(index>0)data[pair.slice(0,index)]=pair.slice(index+1);}
    return segmentText({type,data});
  });
}
export function eventText(event) {
  if(Array.isArray(event.message)) return event.message.map(segmentText).join('').trim();
  return rawMessageText(event.raw_message || event.message).trim();
}
const MAX_QQ_IMAGE_BYTES=8*1024*1024;
const MAX_QQ_IMAGES=4;
function imageType(bytes) {
  if(bytes.length>=8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:'.png',mediaType:'image/png'};
  if(bytes.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff)return {ext:'.jpg',mediaType:'image/jpeg'};
  if(bytes.length>=12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP')return {ext:'.webp',mediaType:'image/webp'};
  if(bytes.length>=6 && /^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return {ext:'.gif',mediaType:'image/gif'};
  return null;
}
function isAllowedImageUrl(value) {
  try {
    const url=new URL(value);
    return url.protocol==='https:' && (url.hostname==='multimedia.nt.qq.com.cn' || url.hostname==='qpic.cn' || url.hostname.endsWith('.qpic.cn'));
  } catch { return false; }
}
function isAllowedMediaUrl(value) {
  if(isAllowedImageUrl(value))return true;
  try { const url=new URL(value);return /^https?:$/.test(url.protocol) && ['127.0.0.1','localhost','[::1]'].includes(url.hostname); }
  catch { return false; }
}
async function readLimitedResponse(response) {
  if(!response.ok || response.status>=300)throw Error('图片下载失败');
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared) && declared>MAX_QQ_IMAGE_BYTES)throw Error('图片超过大小限制');
  if(!response.body?.getReader) {
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>MAX_QQ_IMAGE_BYTES)throw Error('图片超过大小限制');
    return bytes;
  }
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>MAX_QQ_IMAGE_BYTES){await reader.cancel();throw Error('图片超过大小限制');}
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks,size);
}
async function enrichEventText(event,call,mediaRoot,messageId,mediaFetch=globalThis.fetch) {
  if(!Array.isArray(event.message))return {text:eventText(event),attachments:[]};
  const current=event.message.filter(part=>part?.type!=='reply').map(segmentText).join('').trim();
  const replies=event.message.filter(part=>part?.type==='reply');
  let text=current;const saved=[];
  for(const part of replies) {
    const id=part?.data?.id;
    let quoted='';
    if(id) {
      try { const result=await call('get_msg',{message_id:Number(id) || id});quoted=eventText(result || {}); }
      catch { quoted=''; }
    }
    text += `${text?'\n':''}[引用消息${id?`：${id}`:''}]${quoted?`\n${quoted}`:''}`;
  }
  if(mediaRoot) {
    const images=event.message.filter(part=>part?.type==='image');
    let failed=0,totalBytes=0;
    for(let index=0;index<images.length;index++) {
      if(index>=MAX_QQ_IMAGES){failed++;continue;}
      const data=images[index]?.data || {}; let source='';
      let result;
      try { result=await call('get_image',{file:data.file || data.url}); }
      catch { /* use the original segment URL below when OneBot is unavailable */ }
      // A OneBot `file` may be an opaque identifier or stale local path. Try
      // each usable candidate so it cannot mask a valid CDN URL.
      const candidates=[result?.file,result?.url,data.url].map(value=>String(value || '').trim()).filter(Boolean);
      for(const candidate of candidates) {
        if(/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(candidate) && existsSync(candidate)) { source=candidate;break; }
        if(isAllowedMediaUrl(candidate)) { source=candidate;break; }
      }
      if(!source){failed++;continue;}
      const targetPrefix=join(mediaRoot,`${String(messageId || 'qq').replace(/[^a-z0-9_-]/gi,'_')}-${index+1}`);
      try {
        let bytes;
        if(/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(source) && existsSync(source)) {
          const info=statSync(source);if(!info.isFile() || info.size>MAX_QQ_IMAGE_BYTES)throw Error('图片超过大小限制');
          bytes=readFileSync(source);
        }
        else if(isAllowedMediaUrl(source)) {
          const response=await mediaFetch(source,{signal:AbortSignal.timeout(15000),redirect:'manual'});
          if(response.status>=300 && response.status<400)throw Error('图片下载跳转被拒绝');
          bytes=await readLimitedResponse(response);
        } else continue;
        const type=imageType(bytes);if(!type)throw Error('图片格式不支持');
        if(totalBytes+bytes.length>16*1024*1024)throw Error('本条消息图片总量超过限制');
        totalBytes+=bytes.length;
        const target=targetPrefix+type.ext;await writeFile(target,bytes,{flag:'wx'});saved.push(target);
      } catch { failed++; /* do not fail an otherwise valid QQ message */ }
    }
    if(saved.length)text += `${text?'\n':''}[附图：${saved.length} 张]`;
    if(failed)text += `${text?'\n':''}[${failed} 张图片未能接入视觉会话，请重新发送或减少图片数量]`;
  }
  return {text:text.trim(),attachments:saved};
}
export function isUserFacingNotification(row) {
  const key=String(row?.dedupe || ''),text=String(row?.text || '');
  if(/^accepted:|^task-session:/.test(key))return false;
  if(/^guardian:heartbeat:recovered/.test(key))return false;
  if(/^guardian:event:/.test(key) && /^助手中枢恢复：/.test(text))return false;
  if(/^(?:看门狗超过 90 秒未更新，请检查后台守护进程。|看门狗心跳已恢复。|服务恢复：|中枢服务已启动|中枢服务已恢复|任务已标记中断)/.test(text))return false;
  if(/^交给(?: DSH| Codex| WorkBuddy) 了，完成或需要你选择时会送回来。$/.test(text))return false;
  return true;
}
export class QqBridge {
  constructor({store,onMessage,onChange=()=>{},configFile=QQ_CONFIG,enabled=false,notificationEnabled=true,notificationFilter=()=>true,getMode=()=> 'prefix',intervalMs=900,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),mediaRoot=null,mediaFetch=globalThis.fetch}) {
    Object.assign(this,{store,onMessage,onChange,configFile,enabled,notificationEnabled,notificationFilter,getMode,intervalMs,delay,mediaRoot,mediaFetch});
    if(mediaRoot)mkdirSync(mediaRoot,{recursive:true});
    this.connected=false; this.stopping=false; this.flushing=false;
  }
  async call(action,params) {
    const cfg=loadQqConfig(this.configFile);
    let response;
    try {
      response=await fetch(cfg.httpUrl.replace(/\/$/,'')+'/'+action,{method:'POST',
        headers:{'content-type':'application/json',...(cfg.httpToken?{Authorization:'Bearer '+cfg.httpToken}:{})},
        body:JSON.stringify(params),signal:AbortSignal.timeout(15000)});
    } catch {
      const error=Error('QQ 连接中断，消息是否已送达无法确认');error.uncertain=true;throw error;
    }
    if(!response.ok) {const error=Error('QQ HTTP '+response.status);error.uncertain=response.status>=500;throw error;}
    const result=await response.json();
    if(result.status!=='ok' || Number(result.retcode)!==0) {const error=Error('QQ '+String(result.message || result.wording || result.retcode));error.uncertain=false;throw error;}
    return result.data;
  }
  async send(text,{messageId}={}) {
    // OneBot currently has no client supplied idempotency parameter. The
    // stable id is therefore carried in our durable outbox and audit event;
    // the request itself remains schema compatible with all OneBot versions.
    void messageId;
    return this.call('send_private_msg',{user_id:Number(OWNER),message:String(text)});
  }
  async sendFile(file,{image=false}={}) {
    const value=String(file || '').replace(/\\/g,'/');
    if(!value || !/^(?:[A-Za-z]:\/|\/)/.test(value))throw Error('附件路径必须是本机绝对路径');
    const name=basename(value);
    if(!QQ_SHAREABLE_EXTENSIONS.has(extname(name).toLowerCase()) || /^[a-f0-9-]{24,}(?:\.[^.]+)?$/i.test(name))throw Error('QQ 附件必须使用可读文件名和常见文档或图片后缀');
    return this.call('send_private_msg',{user_id:Number(OWNER),message:[{type:image?'image':'file',data:{file:value,...(!image?{name}:{})}}]});
  }
  async probe() { const data=await this.call('get_login_info',{}); this.selfId=String(data.user_id); return {online:true,nickname:data.nickname}; }
  async handle(event) {
    if(event.post_type!=='message' || event.message_type!=='private' || String(event.user_id)!==OWNER || String(event.sender?.user_id || event.user_id)!==OWNER) return false;
    if(!event.message_id) return false;
    const quickText=eventText(event);
    if(this.getMode()!=='all' && !isHubCommand(quickText)) return false;
    // A disabled bridge is a true no-op: do not fetch quoted messages or media
    // while the original QQ channel still owns this conversation.
    if(!this.enabled) return false;
    const messageId='qq:'+event.message_id;
    const enriched=await enrichEventText(event,this.call.bind(this),this.mediaRoot,messageId,this.mediaFetch);
    const record=this.store.saveIncoming(messageId,enriched.text.replace(/^\/(?:中枢|hub)\s*/i,''),enriched.attachments);
    if(record.status==='done' || record.status==='failed' || this.handling?.has(messageId) || (record.nextAttemptAt && Date.parse(record.nextAttemptAt)>Date.now()))return true;
    await this.deliverIncoming(record);
    this.onChange(); await this.flush(); return true;
  }
  async deliverIncoming(record) {
    this.handling ??= new Set();if(this.handling.has(record.messageId))return;this.handling.add(record.messageId);
    try{let attachments=[];try{attachments=JSON.parse(record.attachments||'[]');}catch{}const meta={source:'qq',messageKey:record.messageId,...(Array.isArray(attachments)&&attachments.length?{imagePaths:attachments}: {})};await this.onMessage(record.text,meta);this.store.incomingDone(record.messageId);}
    catch(error){
      if(error?.code==='HUB_CAPACITY') {
        const attempts=Number(record.attempts||0)+1;
        const delayMs=Math.min(5000*2**Math.min(attempts-1,6),300000);
        const retry=this.store.retryIncoming(record.messageId,error.message,{maxAttempts:12,delayMs});
        if(retry?.status==='failed') {
          const message='执行席位持续繁忙，这条任务暂时没有派出去。你把同一任务再发我一次，我会重新排队。';
          this.store.error(null,'QQ 入站任务因执行席位持续繁忙达到重试上限：'+error.message);
          this.store.enqueue(message,'inbound-capacity-exhausted:'+record.messageId);
        } else {
          this.store.enqueue('执行席位暂时排满了，我已经留住这条任务，空出位置后会自动继续处理。','inbound-capacity:'+record.messageId);
        }
      } else {
        this.store.failIncoming(record.messageId,error.message);
        this.store.error(null,error.message);
        this.store.enqueue('嗯，这条消息暂时没能处理好。错误已经记在系统里了，请把任务再发我一次。','inbound-error:'+record.messageId);
      }
    }
    finally{this.handling.delete(record.messageId);}
  }
  connect() {
    if(this.stopping) return;
    try {
      const cfg=loadQqConfig(this.configFile);
      this.socket=new WebSocket(cfg.wsUrl,{headers:cfg.wsToken?{Authorization:'Bearer '+cfg.wsToken}:{}});
      this.socket.on('open',()=>{this.connected=true;this.nextFlushAt=0;this.onChange();void this.flush();});
      this.socket.on('message',data=>{try { const event=JSON.parse(String(data));void this.handle(event).catch(error=>this.store.error(null,'QQ 入站处理失败：'+error.message)); }catch{/* ignore non-events */}});
      this.socket.on('error',()=>{});
      this.socket.on('close',()=>{this.connected=false;this.onChange();if(!this.stopping)this.retry=setTimeout(()=>this.connect(),5000);});
    }catch(error) {this.store.error(null,'QQ 配置读取失败：'+error.message);if(!this.stopping)this.retry=setTimeout(()=>this.connect(),10000);}
  }
  start() {
    this.live=true;this.connect();
    if(this.enabled) {
      for(const record of this.store.pendingIncoming())void this.deliverIncoming(record);
      this.inboxTimer=setInterval(()=>{for(const record of this.store.pendingIncoming())void this.deliverIncoming(record);},5000);
      this.inboxTimer.unref?.();
    }
    this.timer=setInterval(()=>void this.flush(),10000);this.timer.unref();
  }
  async waitBetweenSends() {
    if(this.stopping || this.intervalMs<=0)return;
    let wake;
    const stopped=new Promise(resolve=>{wake=resolve;this.stopDelay=wake;});
    try { await Promise.race([Promise.resolve().then(()=>this.delay(this.intervalMs)),stopped]); }
    finally { if(this.stopDelay===wake)this.stopDelay=null; }
  }
  async flush() {
    if(!this.notificationEnabled || this.flushing || this.stopping || (this.live && !this.connected) || Date.now()<(this.nextFlushAt || 0))return;
    this.flushing=true;this.flushFinished=new Promise(resolve=>{this.flushResolve=resolve;});
    try {
      // A `sending` row is a short lease. Reclaim only leases old enough that
      // a process crash could have left the request unresolved; fresh rows are
      // deliberately withheld across reconnects to avoid duplicate delivery.
      this.store.reclaimStaleNotifications?.();
      this.store.reclaimStaleAttachments?.();
      const rows=this.store.pendingNotifications();
      for(let index=0;index<rows.length;index++) {
        const row=rows[index];
        if(this.stopping)break;
        if(!this.notificationFilter(row)) {
          this.store.notification(row.id,'suppressed','QQ 用户视图已隐藏内部任务流消息');
          this.store.event(null,'qq.suppressed',{outboxId:row.id,dedupe:row.dedupe});
          continue;
        }
        if(!this.store.claimNotification(row.id))continue;
        try { const sent=await this.send(row.text,{messageId:row.messageId});this.store.notification(row.id,'sent');this.store.event(null,'qq.sent',{outboxId:row.id,dedupe:row.dedupe,deliveryId:row.messageId,messageId:sent?.message_id});this.flushDelay=10000;this.nextFlushAt=0;this.failureReported=false; }
        catch(error) {
          const uncertain=error?.uncertain!==false;
          this.store.notification(row.id,uncertain?'uncertain':'pending',error.message);
          if(!this.failureReported){this.store.error(null,uncertain?'QQ 消息发送结果不确定，已停止自动重发以避免重复；请在 QQ 和中枢错误记录中核对。':'QQ 通知被明确拒绝，已保留并将重试：'+error.message);this.failureReported=true;}
          if(!uncertain){this.flushDelay=Math.min((this.flushDelay || 5000)*2,300000);this.nextFlushAt=Date.now()+this.flushDelay;}
          break;
        }
        if(index<rows.length-1)await this.waitBetweenSends();
      }
      const attachments=this.store.pendingAttachments?.() || [];
      for(let index=0;index<attachments.length;index++) {
        const row=attachments[index];
        if(this.stopping)break;
        if(!this.store.claimAttachment(row.id))continue;
        try {
          const sent=await this.sendFile(row.filePath,{image:Number(row.image)===1});
          this.store.attachment(row.id,'sent');
          this.store.event(null,'qq.attachment-sent',{attachmentId:row.id,artifactId:row.artifactId,dedupe:row.dedupe,messageId:sent?.message_id});
          this.flushDelay=10000;this.nextFlushAt=0;this.failureReported=false;
        } catch(error) {
          const uncertain=error?.uncertain!==false;
          this.store.attachment(row.id,uncertain?'uncertain':'pending',error.message);
          if(!this.failureReported){this.store.error(null,uncertain?'QQ 附件发送结果不确定，已停止自动重发以避免重复；请在 QQ 和中枢错误记录中核对。':'QQ 附件被明确拒绝，已保留并将重试：'+error.message);this.failureReported=true;}
          if(!uncertain){this.flushDelay=Math.min((this.flushDelay || 5000)*2,300000);this.nextFlushAt=Date.now()+this.flushDelay;}
          break;
        }
        if(index<attachments.length-1)await this.waitBetweenSends();
      }
    } finally { this.flushing=false;this.flushResolve?.();this.onChange(); }
  }
  async close() {this.stopping=true;this.stopDelay?.();clearInterval(this.timer);clearInterval(this.inboxTimer);clearTimeout(this.retry);this.socket?.close();await this.flushFinished;}
}
