import {ensureDeliveryLedger,beginDelivery,finishDelivery,requireSendReceipt,eligibleNotifications,reconcileDeliveryLeases,predecessorReady} from './qq-delivery-ledger.mjs';
import {qqRequestPolicy,qqRequestFailure} from './qq-request-policy.mjs';
import {retryAfterMs} from './error-strategy.mjs';
import {deliveryRetryReady,rejectedDelivery} from './qq-error-recovery.mjs';
import {routineDispatchKey,dispatchConversationText} from './dispatch-notice-policy.mjs';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {pathToFileURL} from 'node:url';
import WebSocket from 'ws';
import { QQ_SHAREABLE_EXTENSIONS } from './knowledge/share-policy.mjs';
import { conversationDeliveryGate } from './companion-conversation.mjs';
import { sharedCardText } from './qq-link-cards.mjs';
import { QqIncomingBatches, isImmediateQqInput } from './qq-incoming-batches.mjs';
import { isMenuCommand, quickMenu, voiceModeCommand } from './quick-menu.mjs';
import { downloadQqFile, QQ_INCOMING_FILE_MAX_BYTES, QQ_INCOMING_FILE_TOTAL_BYTES, QQ_INCOMING_FILE_TIMEOUT_MS } from './qq-incoming-files.mjs';

export const QQ_CONFIG = process.env.HUB_QQ_CONFIG || 'runtime/qq-config.json';
export const OWNER = process.env.HUB_QQ_OWNER || '';
function boundedIncomingLimit(value,fallback,maximum) { const number=Number(value);return Number.isFinite(number)&&number>0?Math.min(Math.floor(number),maximum):fallback; }
export function loadQqConfig(file=QQ_CONFIG) {
  const config=JSON.parse(readFileSync(file,'utf8'));
  const one=config.snowluma || {};
  const native=config.nativeSender?.enabled===true?config.nativeSender:null;
  if(native){const url=new URL(native.httpUrl);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw Error('QQ 原生发送组件只允许本机 HTTP 地址');}
  for(const endpoint of [one.httpUrl || 'http://127.0.0.1:3000',one.wsUrl || 'ws://127.0.0.1:3001']) {
    const url=new URL(endpoint);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('QQ 凭据只允许发送到本机 OneBot 服务');
  }
  return {httpUrl:one.httpUrl || 'http://127.0.0.1:3000',wsUrl:one.wsUrl || 'ws://127.0.0.1:3001',
    httpToken:one.httpAccessToken || one.accessToken || '',wsToken:one.accessToken || '',...(native?{nativeSender:{httpUrl:native.httpUrl,httpToken:native.accessToken||''}}:{})};
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
    case 'json': case 'xml': return sharedCardText(part.type,data);
    case 'share': return `[分享链接]${String(data.title||'').slice(0,300)}\n${String(data.url||'').slice(0,2048)}`;
    case 'forward': return '[合并转发消息]';
    default: return '';
  }
}
function rawMessageText(value) {
  return String(value || '').replace(/\[CQ:([^,\]]+)([^\]]*)\]/g,(_,type,attrs)=>{
    const data={};for(const pair of String(attrs).split(',')){const index=pair.indexOf('=');if(index>0)data[pair.slice(0,index)]=pair.slice(index+1).replaceAll('&#44;',',').replaceAll('&#91;','[').replaceAll('&#93;',']').replaceAll('&amp;','&');}
    return segmentText({type,data});
  });
}
function rawMessageSegments(value) {
  const raw=String(value || ''),segments=[];let cursor=0,matched=false;
  const pattern=/\[CQ:([^\]]+)\]/g;
  for(const match of raw.matchAll(pattern)) {
    matched=true;const before=raw.slice(cursor,match.index);if(before)segments.push({type:'text',data:{text:before}});
    const fields=String(match[1]).split(',');const type=fields.shift();const data={};
    for(const field of fields){const index=field.indexOf('=');if(index>0)data[field.slice(0,index)]=field.slice(index+1).replaceAll('&#44;',',').replaceAll('&#91;','[').replaceAll('&#93;',']').replaceAll('&amp;','&');}
    segments.push({type,data});cursor=match.index+match[0].length;
  }
  if(cursor<raw.length)segments.push({type:'text',data:{text:raw.slice(cursor)}});
  return matched?segments:null;
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
async function enrichEventText(event,call,mediaRoot,messageId,mediaFetch=globalThis.fetch,fileOptions={}) {
  const message=Array.isArray(event.message)?event.message:rawMessageSegments(event.raw_message || (typeof event.message==='string'?event.message:''));
  if(!message)return {text:eventText(event),attachments:[],attachmentErrors:[]};
  const current=message.filter(part=>part?.type!=='reply').map(segmentText).join('').trim();
  const replies=message.filter(part=>part?.type==='reply');
  let text=current;const saved=[];
  const attachmentErrors=[];
  // OneBot merged forwards have to be expanded before links can be read.
  for(const part of message.filter(p=>p?.type==='forward').slice(0,2)){
    try{const result=await call('get_forward_msg',{message_id:part.data?.id,id:part.data?.id});
      const nodes=result?.messages||result?.message||[];
      if(Array.isArray(nodes)){const excerpts=nodes.slice(0,20).map(n=>eventText({message:n.content||n.message||n.data?.content,raw_message:n.raw_message})).filter(Boolean);
        if(excerpts.length)text+=`\n[转发内容，仅供参考]\n${excerpts.join('\n').slice(0,12000)}`;}
    }catch{text+='\n[转发内容暂未读取成功]';}
  }
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
    const images=message.filter(part=>part?.type==='image');
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
  if(mediaRoot) {
    const files=message.filter(part=>part?.type==='file');
    let totalBytes=0;
    for(let index=0;index<files.length;index++) {
      if(index>=4){attachmentErrors.push('QQ 文件数量超过每条消息最多 4 个的限制');continue;}
      const name=String(files[index]?.data?.name || files[index]?.data?.file || '未命名文件');
      try {
        const attachment=await downloadQqFile({part:files[index],peerId:event.user_id,call,root:mediaRoot,messageId,index:saved.length+index,fetchImpl:mediaFetch,totalBytes,maxBytes:fileOptions.maxBytes||QQ_INCOMING_FILE_MAX_BYTES,totalLimit:fileOptions.totalLimit||QQ_INCOMING_FILE_TOTAL_BYTES,timeoutMs:fileOptions.timeoutMs||QQ_INCOMING_FILE_TIMEOUT_MS});
        totalBytes+=attachment.size;saved.push(attachment);
        text += `${text?'\n':''}[文件已保存：${attachment.originalName}]`;
      } catch(error) {
        const messageText=`${name}：${String(error?.message || 'QQ 文件接收失败').slice(0,240)}`;
        attachmentErrors.push(messageText);text += `${text?'\n':''}[文件未能保存：${messageText}]`;
      }
    }
  }
  return {text:text.trim(),userText:message.filter(p=>!['reply','file','image'].includes(p?.type)).map(segmentText).join('').trim(),replyIds:replies.map(p=>String(p.data?.id||'')).filter(Boolean),attachments:saved,attachmentErrors};
}
export function isUserFacingNotification(row) {
  const key=String(row?.dedupe || ''),text=String(row?.text || '');
  if(routineDispatchKey(key))return false;
  if(/^(?:director-delegated|frontdesk):/u.test(key)&&!dispatchConversationText(text))return false;
  if(/^accepted:|^task-session:/.test(key))return false;
  if(/^guardian:heartbeat:recovered/.test(key))return false;
  if(/^guardian:event:/.test(key) && /^(?:AI 中枢|助手中枢)恢复：/.test(text))return false;
  if(/^(?:看门狗超过 90 秒未更新，请检查后台守护进程。|看门狗心跳已恢复。|服务恢复：|中枢服务已启动|中枢服务已恢复|任务已标记中断)/.test(text))return false;
  if(/^交给(?: DSH| Codex| WorkBuddy) 了，完成或需要你选择时会送回来。$/.test(text))return false;
  return true;
}
export class QqBridge {
  constructor({store,onMessage,onChange=()=>{},configFile=QQ_CONFIG,enabled=false,notificationEnabled=true,notificationFilter=()=>true,getMode=()=> 'prefix',intervalMs=900,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),mediaRoot=null,mediaFetch=globalThis.fetch,incomingFileMaxBytes=QQ_INCOMING_FILE_MAX_BYTES,incomingFileTotalBytes=QQ_INCOMING_FILE_TOTAL_BYTES,incomingFileTimeoutMs=QQ_INCOMING_FILE_TIMEOUT_MS,incomingBatchMs=0,canBatchIncoming=()=>true,voice=null,preparedAudio=()=>null}) {
    this.voice=voice;this.preparedAudio=preparedAudio;
    Object.assign(this,{store,onMessage,onChange,configFile,enabled,notificationEnabled,notificationFilter,getMode,intervalMs,delay,mediaRoot,mediaFetch,incomingFileMaxBytes:boundedIncomingLimit(incomingFileMaxBytes,QQ_INCOMING_FILE_MAX_BYTES,256*1024*1024),incomingFileTotalBytes:boundedIncomingLimit(incomingFileTotalBytes,QQ_INCOMING_FILE_TOTAL_BYTES,512*1024*1024),incomingFileTimeoutMs:boundedIncomingLimit(incomingFileTimeoutMs,QQ_INCOMING_FILE_TIMEOUT_MS,120_000)});
    if(mediaRoot)mkdirSync(mediaRoot,{recursive:true});
    ensureDeliveryLedger(store);
    store.db.exec('CREATE TABLE IF NOT EXISTS qq_transport_receipts(messageId TEXT PRIMARY KEY,transport TEXT NOT NULL,createdAt TEXT NOT NULL)');
    this.connected=false; this.stopping=false; this.flushing=false;
    this.canBatchIncoming=canBatchIncoming;
    if(incomingBatchMs>0)this.inputBatches=new QqIncomingBatches({store,windowMs:incomingBatchMs,deliver:record=>this.deliverIncoming(record),onError:error=>store.error(null,'QQ 连续消息处理失败：'+error.message)});
  }
  async call(action,params,delivery={}) {
    const cfg=loadQqConfig(this.configFile);
    const nativeReceipt=action==='get_msg'&&cfg.nativeSender&&this.store.db.prepare("SELECT 1 FROM qq_transport_receipts WHERE messageId=? AND transport='qq-native'").get(String(params.message_id));
    const useNative=!!cfg.nativeSender&&(action==='send_private_msg'||!!nativeReceipt);
    const transport=useNative?cfg.nativeSender:cfg;
    const policy=qqRequestPolicy(action,params),started=Date.now();
    // Uploads and multipart voice can outlive the stale-send lease. Keep only
    // this owned in-flight row fresh; a lost process still expires normally.
    const lease=policy.sending&&delivery.outboxId&&this.store?.db?setInterval(()=>{
      try{this.store.db.prepare("UPDATE outbox SET updatedAt=? WHERE id=? AND status='sending'").run(this.store.now(),delivery.outboxId);}catch{}
    },15000):null;
    lease?.unref?.();
    let response,result,stage='request';
    const trace=(outcome,extra={})=>this.store?.event?.(null,'qq.transport-request',{action,kind:policy.kind,transport:useNative?'qq-native':'snowluma',timeoutMs:policy.timeoutMs,elapsedMs:Date.now()-started,outcome,...(delivery.outboxId?{outboxId:delivery.outboxId}:{}),...extra});
    try {
      response=await fetch(transport.httpUrl.replace(/\/$/,'')+'/'+action,{method:'POST',
        headers:{'content-type':'application/json',...(transport.httpToken?{Authorization:'Bearer '+transport.httpToken}:{})},
        body:JSON.stringify(params),signal:AbortSignal.timeout(policy.timeoutMs)});
      stage='response-body';
      if(response.ok)result=await response.json();
    } catch(cause) {
      const error=qqRequestFailure(cause,{...policy,stage});
      trace('failed',{category:error.category,stage,uncertain:error.uncertain});throw error;
    } finally {clearInterval(lease);}
    if(!response.ok) {const error=Error('QQ HTTP '+response.status);error.httpStatus=response.status;error.retryAfterMs=retryAfterMs(response.headers?.get?.('retry-after'));error.uncertain=policy.sending&&(response.status>=500||response.status===408);trace('failed',{category:'http',httpStatus:response.status,uncertain:error.uncertain});throw error;}
    if(!result||!['ok','failed'].includes(result.status)||!Number.isFinite(Number(result.retcode))){
      const error=qqRequestFailure(null,{...policy,stage:'response-body'});
      trace('failed',{category:error.category,stage:error.stage,uncertain:error.uncertain});throw error;
    }
    if(!result||result.status!=='ok' || Number(result.retcode)!==0) {
      const error=Error('QQ '+String(result?.message || result?.wording || result?.retcode || '回执为空'));
      // OneBot can return HTTP 200 with a downstream QQ reply timeout. That
      // means the acknowledgement is missing, not that QQ rejected the send.
      error.uncertain=policy.sending&&(!result||/timed?\s*out|timeout|gotResponse\s*[=:]\s*false|回包.*超时|等待.*超时/i.test(error.message));
      trace('failed',{category:'platform',uncertain:error.uncertain});
      throw error;
    }
    if(policy.sending)trace('acknowledged',{hasMessageId:result.data?.message_id!=null});
    if(action==='send_private_msg'&&result.data?.message_id!=null){this.store.db.prepare('INSERT OR REPLACE INTO qq_transport_receipts VALUES(?,?,?)').run(String(result.data.message_id),useNative?'qq-native':'snowluma',this.store.now());}
    return result.data;
  }
  async send(text,{messageId,outboxId}={}) {
    // OneBot currently has no client supplied idempotency parameter. The
    // stable id is therefore carried in our durable outbox and audit event;
    // the request itself remains schema compatible with all OneBot versions.
    void messageId;
    return this.call('send_private_msg',{user_id:Number(OWNER),message:String(text)},{outboxId});
  }
  async sendFile(file,{image=false}={}) {
    const value=String(file || '').replace(/\\/g,'/');
    if(!value || !/^(?:[A-Za-z]:\/|\/)/.test(value))throw Error('附件路径必须是本机绝对路径');
    const name=basename(value);
    if(!QQ_SHAREABLE_EXTENSIONS.has(extname(name).toLowerCase()) || /^[a-f0-9-]{24,}(?:\.[^.]+)?$/i.test(name))throw Error('QQ 附件必须使用可读文件名和常见文档或图片后缀');
    return this.call('send_private_msg',{user_id:Number(OWNER),message:[{type:image?'image':'file',data:{file:value,...(!image?{name}:{})}}]});
  }
  async sendRecord(file,delivery={}) {
    if(!/^(?:[A-Za-z]:[\\/]|\/)/.test(file)||extname(file).toLowerCase()!=='.wav'||!existsSync(file))throw Object.assign(Error('语音文件不存在'),{uncertain:false});
    return this.call('send_private_msg',{user_id:Number(OWNER),message:[{type:'record',data:{file:pathToFileURL(file).href}}]},delivery);
  }
  async sendPrepared(row,file) {
    if(file) {
      try{const receipt=requireSendReceipt(await this.sendRecord(file,{outboxId:row.id}));this.store.event(null,'qq.voice-sent',{outboxId:row.id,messageId:receipt.message_id});return receipt;}
      catch(error){if(error.uncertain!==false||row.preparedAudioRequired)throw error;this.store.event(null,'qq.voice-fallback',{outboxId:row.id,reason:'QQ明确拒绝语音，改发文字'});}
    }
    return this.send(row.text,{messageId:row.messageId,outboxId:row.id});
  }
  async probe() { const data=await this.call('get_login_info',{}); this.selfId=String(data.user_id); return {online:true,nickname:data.nickname}; }
  handle(event) {
    const work=()=>this.handleOrdered(event);
    const operation=(this.eventQueue||Promise.resolve()).then(work,work);
    this.eventQueue=operation.catch(()=>{});return operation;
  }
  async handleOrdered(event) {
    if(event.post_type!=='message' || event.message_type!=='private' || String(event.user_id)!==OWNER || String(event.sender?.user_id || event.user_id)!==OWNER) return false;
    if(!event.message_id) return false;
    const quickText=eventText(event);
    if(this.getMode()!=='all' && !isHubCommand(quickText)) return false;
    // A disabled bridge is a true no-op: do not fetch quoted messages or media
    // while the original QQ channel still owns this conversation.
    if(!this.enabled) return false;
    const messageId='qq:'+event.message_id;
    if(this.store.db.prepare('SELECT status FROM inbox WHERE messageId=?').get(messageId))return true;
    const enriched=await enrichEventText(event,this.call.bind(this),this.mediaRoot,messageId,this.mediaFetch,{maxBytes:this.incomingFileMaxBytes,totalLimit:this.incomingFileTotalBytes,timeoutMs:this.incomingFileTimeoutMs});
    for(const error of enriched.attachmentErrors || [])this.store.error(null,`QQ 入站附件失败：${error}`);
    this.store.db.exec('CREATE TABLE IF NOT EXISTS qq_input_context(messageId TEXT PRIMARY KEY,userText TEXT NOT NULL,replyIds TEXT NOT NULL)');
    this.store.db.prepare('INSERT OR IGNORE INTO qq_input_context VALUES(?,?,?)').run(messageId,enriched.userText??enriched.text,JSON.stringify(enriched.replyIds||[]));
    const record=this.store.saveIncoming(messageId,enriched.text.replace(/^\/(?:中枢|hub)\s*/i,''),enriched.attachments);
    if(record.status==='done' || record.status==='failed' || this.handling?.has(messageId) || (record.nextAttemptAt && Date.parse(record.nextAttemptAt)>Date.now()))return true;
    await this.receiveIncoming(record);
    this.onChange(); await this.flush(); return true;
  }
  receiveIncoming(record) {
    // Keep boundaries in arrival order even while an earlier dispatch awaits I/O.
    const receive=()=>this.receiveIncomingOrdered(record);
    const queued=(this.receiveQueue||Promise.resolve()).then(receive,receive);
    this.receiveQueue=queued.catch(()=>{});return queued;
  }
  async receiveIncomingOrdered(record) {
    // Inbox polling can enqueue a pending snapshot while a slow direct send is
    // in flight. Once this receive slot runs, that first send may already be
    // done (or have scheduled a retry). The database, not the queued snapshot,
    // decides whether this message still needs delivery.
    const current=this.store.db.prepare('SELECT * FROM inbox WHERE messageId=?').get(record.messageId);
    if(!current || current.status!=='pending' || (current.nextAttemptAt && Date.parse(current.nextAttemptAt)>Date.now()))return;
    record={...record,...current};
    if(isMenuCommand(record.text)) {
      await this.inputBatches?.flush();
      this.store.transaction(()=>{this.store.say('user',record.text);this.store.incomingDone(record.messageId);this.store.enqueue(quickMenu(this.store),'quick-menu:'+record.messageId);});this.onChange();
      return;
    }
    const voiceMode=voiceModeCommand(record.text);
    if(voiceMode!==null) {
      await this.inputBatches?.flush();
      this.store.transaction(()=>{this.store.say('user',record.text);this.voice?.setEnabled(voiceMode);this.store.incomingDone(record.messageId);this.store.enqueue(!this.voice?'当前还没有配置本地语音。':voiceMode?'已开启语音，所有文字回复都会用当前音色分段读出来。':'已切回文字回复。','voice-mode:'+record.messageId);});this.onChange();
      return;
    }
    if(this.inputBatches?.contains(record.messageId)){this.inputBatches.schedule(record);return;}
    if(this.inputBatches && this.canBatchIncoming() && !isImmediateQqInput(record.text)) {
      this.inputBatches.schedule(record);return;
    }
    // A control phrase is a boundary, never part of a preceding sentence.
    await this.inputBatches?.flush();
    return this.deliverIncoming(record);
  }
  async deliverIncoming(record) {
    this.handling ??= new Set();if(this.handling.has(record.messageId))return;this.handling.add(record.messageId);
    const memberIds=record.memberIds||[record.messageId];
    try{let attachments=[];try{attachments=JSON.parse(record.attachments||'[]');}catch{}const files=Array.isArray(attachments)?attachments.filter(item=>item&&typeof item==='object'&&typeof item.path==='string'):[];const imagePaths=[...(Array.isArray(attachments)?attachments.filter(item=>typeof item==='string'):[]),...files.filter(item=>item.isImage===true||String(item.mimeType||'').startsWith('image/')).map(item=>item.path)];const meta={source:'qq',messageKey:record.messageId,...(record.originalMessages?{originalMessages:record.originalMessages}:{}),...(imagePaths.length?{imagePaths}:{}),...(files.length?{fileAttachments:files}: {})};let contexts=[];
      if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_input_context'").get())contexts=memberIds.map(id=>this.store.db.prepare('SELECT * FROM qq_input_context WHERE messageId=?').get(id)).filter(Boolean);
      if(contexts.length){meta.originalUserText=contexts.map(c=>c.userText).join('\n');meta.replyIds=contexts.flatMap(c=>JSON.parse(c.replyIds));}
      await this.onMessage(record.text,meta);this.store.transaction(()=>{for(const id of memberIds)this.store.incomingDone(id);});}
    catch(error){
      if(error?.code==='HUB_SECRET_INPUT_REQUIRED') {
        this.store.transaction(()=>{for(const id of memberIds)this.store.failIncoming(id,'此请求需要在引擎本机界面处理');});
        this.store.enqueue('这个请求需要敏感信息，请在引擎的本机配置或界面中处理，不要通过 QQ 发送密钥。','inbound-secret-input:'+record.messageId);
      } else if(error?.code==='HUB_CAPACITY') {
        const attempts=Number(record.attempts||0)+1;
        const delayMs=Math.min(5000*2**Math.min(attempts-1,6),300000);
        let retry;this.store.transaction(()=>{for(const id of memberIds)retry=this.store.retryIncoming(id,error.message,{maxAttempts:12,delayMs});});
        if(retry?.status==='failed') {
          const message='执行席位持续繁忙，这条任务暂时没有派出去。你把同一任务再发我一次，我会重新排队。';
          this.store.error(null,'QQ 入站任务因执行席位持续繁忙达到重试上限：'+error.message);
          this.store.enqueue(message,'inbound-capacity-exhausted:'+record.messageId);
        } else {
          this.store.enqueue('执行席位暂时排满了，我已经留住这条任务，空出位置后会自动继续处理。','inbound-capacity:'+record.messageId);
        }
      } else {
        this.store.transaction(()=>{for(const id of memberIds)this.store.failIncoming(id,error.message);});
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
      for(const record of this.store.pendingIncoming())void this.receiveIncoming(record).catch(error=>this.store.error(null,error.message));
      this.inboxTimer=setInterval(()=>{for(const record of this.store.pendingIncoming())void this.receiveIncoming(record).catch(error=>this.store.error(null,error.message));},5000);
      this.inboxTimer.unref?.();
    }
    this.timer=setInterval(()=>void this.flush(),10000);this.timer.unref();
  }
  async waitBetweenSends(milliseconds=this.intervalMs) {
    if(this.stopping || this.intervalMs<=0)return;
    let wake;
    const stopped=new Promise(resolve=>{wake=resolve;this.stopDelay=wake;});
    try { await Promise.race([Promise.resolve().then(()=>this.delay(milliseconds)),stopped]); }
    finally { if(this.stopDelay===wake)this.stopDelay=null; }
  }
  async flush() {
    if(!this.notificationEnabled || this.flushing || this.stopping || this.deliveryPaused() || (this.live && !this.connected) || Date.now()<(this.nextFlushAt || 0))return;
    this.flushing=true;this.flushFinished=new Promise(resolve=>{this.flushResolve=resolve;});
    try {
      // A `sending` row is a short lease. Reclaim only leases old enough that
      // a process crash could have left the request unresolved; fresh rows are
      // deliberately withheld across reconnects to avoid duplicate delivery.
      this.store.reclaimStaleNotifications?.();
      this.store.reclaimStaleAttachments?.();
      reconcileDeliveryLeases(this.store);
      const rows=eligibleNotifications(this.store);
      for(let index=0;index<rows.length;index++) {
        const row=rows[index];
        if(!deliveryRetryReady(this.store,row.id))continue;
        if(this.stopping||this.deliveryPaused())break;
        if(!this.notificationFilter(row)) {
          this.store.notification(row.id,'suppressed','QQ 用户视图已隐藏内部任务流消息');
          this.store.event(null,'qq.suppressed',{outboxId:row.id,dedupe:row.dedupe});
          continue;
        }
        const conversationGate=conversationDeliveryGate(this.store,row);
        if(!conversationGate.allowed)continue;
        if(!predecessorReady(this.store,row))continue;
        const preparedVoice=await this.preparedAudio(row);
        let voiceFile=preparedVoice,voicePlan=null,sendRow=row;
        if(!preparedVoice && this.voice?.shouldSpeak(row,conversationGate)) {
          const voiceStarted=Date.now();
          this.store.event(null,'qq.voice-preparation-started',{outboxId:row.id});
          try {
            if(this.voice.prepareDelivery){voicePlan=await this.voice.prepareDelivery(row);voiceFile=voicePlan.file;}
            else voiceFile=await this.voice.synthesize(row.text);
            this.store.event(null,'qq.voice-prepared',{outboxId:row.id,elapsedMs:Date.now()-voiceStarted});
          } catch(error) {
            this.store.event(null,'qq.voice-preparation-failed',{outboxId:row.id,elapsedMs:Date.now()-voiceStarted});
            if(error.uncertain===true){finishDelivery(this.store,row,'uncertain',{error:error.message});continue;}
            if(error.voicePending){this.store.event(null,'qq.voice-retry',{outboxId:row.id,reason:error.message});this.nextFlushAt=Date.now()+2000;continue;}
            sendRow={...row,text:'这次语音没能发出来，我先把尚未发送的内容留给你。\n'+(this.voice.delivery?.remaining(row)||row.text)};this.voice.delivery?.fallback(row);
            this.store.event(null,'qq.voice-fallback',{outboxId:row.id,reason:'语音合成失败，原文保留：'+String(error.message).slice(0,200)});
          }
        }
        if(this.stopping || this.deliveryPaused() || !conversationDeliveryGate(this.store,row).allowed)continue;
        if((voiceFile||voicePlan) && !preparedVoice && !this.voice?.shouldSpeak(row,conversationGate)) {
          sendRow={...row,text:this.voice.delivery?.remaining(row)||row.text};this.voice.delivery?.fallback(row);voiceFile=null;voicePlan=null;
        }
        if(!this.store.claimNotification(row.id))continue;
        beginDelivery(this.store,row);
        try {
          let sent;
          if(voicePlan) {
            try {
              sent=await this.voice.deliverPrepared(voicePlan,{
                sendRecord:file=>this.sendRecord(file,{outboxId:row.id}),receipt:requireSendReceipt,
                allowed:()=>!this.stopping&&!this.deliveryPaused()&&this.voice.enabled()&&conversationDeliveryGate(this.store,row).allowed,
                touch:()=>this.store.db.prepare("UPDATE outbox SET updatedAt=? WHERE id=? AND status='sending'").run(this.store.now(),row.id),
                wait:()=>this.waitBetweenSends(this.intervalMs),
              });
            } catch(error) {
              if(error.suppressed&&this.deliveryPaused()){finishDelivery(this.store,row,'pending',{error:'QQ维护暂停，等待原分段接续'});break;}
              if(this.stopping){finishDelivery(this.store,row,'pending',{error:'语音投递等待下次连接接续'});continue;}
              if(error.suppressed&&!conversationDeliveryGate(this.store,row).allowed){finishDelivery(this.store,row,'suppressed',{error:error.message});continue;}
              if(error.voiceFallback||(error.suppressed&&!this.voice.enabled())) {
                const remaining=this.voice.delivery.remaining(row);
                sent=requireSendReceipt(await this.send((error.voiceFallback?'这次语音没能发出来，我先把尚未发送的内容留给你。\n':'')+remaining,{messageId:row.messageId}));this.voice.delivery.fallback(row);
                this.store.event(null,'qq.voice-fallback',{outboxId:row.id,reason:error.message});
              } else throw error;
            }
          } else sent=requireSendReceipt(await this.sendPrepared({...sendRow,preparedAudioRequired:!!preparedVoice},voiceFile));
          finishDelivery(this.store,row,'sent',{receipt:sent});this.store.event(null,'qq.sent',{outboxId:row.id,dedupe:row.dedupe,deliveryId:row.messageId,messageId:sent?.message_id});if(conversationGate.kind==='proactive'){this.store.say('assistant',row.text);this.onChange();}this.flushDelay=10000;this.nextFlushAt=0;this.failureReported=false;
        }
        catch(error) {
          const uncertain=error?.uncertain!==false;
          if(error.voicePending&&!uncertain){finishDelivery(this.store,row,'pending',{error:error.message});this.store.event(null,'qq.voice-retry',{outboxId:row.id,reason:error.message});this.nextFlushAt=Date.now()+2000;continue;}
          const recovery=rejectedDelivery(this.store,row,error);finishDelivery(this.store,row,recovery.status,{error:error.message});
          if(!this.failureReported&&recovery.status!=='pending'){this.store.error(null,uncertain?'QQ 消息发送结果不确定，已停止自动重发以避免重复；请在 QQ 和中枢错误记录中核对。':'QQ 通知发送失败，已停止原样重试并转交故障排查：'+error.message);this.failureReported=true;}
          if(recovery.status==='pending')this.nextFlushAt=recovery.nextAt;
          break;
        }
        if(index<rows.length-1)await this.waitBetweenSends(conversationGate.kind ? Math.min(3200,1200+row.text.length*18) : this.intervalMs);
      }
      const attachments=this.store.pendingAttachments?.() || [];
      for(let index=0;index<attachments.length;index++) {
        const row=attachments[index];
        if(!deliveryRetryReady(this.store,row.id))continue;
        if(this.stopping||this.deliveryPaused())break;
        if(!this.store.claimAttachment(row.id))continue;
        try {
          const sent=requireSendReceipt(await this.sendFile(row.filePath,{image:Number(row.image)===1}));
          this.store.attachment(row.id,'sent');
          this.store.event(null,'qq.attachment-sent',{attachmentId:row.id,artifactId:row.artifactId,dedupe:row.dedupe,messageId:sent?.message_id});
          this.flushDelay=10000;this.nextFlushAt=0;this.failureReported=false;
        } catch(error) {
          const uncertain=error?.uncertain!==false;
          const recovery=rejectedDelivery(this.store,row,error);this.store.attachment(row.id,recovery.status,error.message);
          if(!this.failureReported&&recovery.status!=='pending'){this.store.error(null,uncertain?'QQ 附件发送结果不确定，已停止自动重发以避免重复；请在 QQ 和中枢错误记录中核对。':'QQ 附件发送失败，已停止原样重试并转交故障排查：'+error.message);this.failureReported=true;}
          if(recovery.status==='pending')this.nextFlushAt=recovery.nextAt;
          break;
        }
        if(index<attachments.length-1)await this.waitBetweenSends();
      }
    } finally { this.flushing=false;this.flushResolve?.();this.onChange(); }
  }
  deliveryPaused(){const until=Number(this.store.meta?.('qq:delivery-pause-until'));return Number.isFinite(until)&&until>Date.now();}
  async close() {this.stopping=true;this.inputBatches?.close();this.stopDelay?.();clearInterval(this.timer);clearInterval(this.inboxTimer);clearTimeout(this.retry);this.socket?.close();await this.receiveQueue;await this.inputBatches?.settled();await this.flushFinished;}
}
