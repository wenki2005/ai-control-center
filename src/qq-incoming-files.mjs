import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {isIP} from 'node:net';

export const QQ_INCOMING_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const QQ_INCOMING_FILE_TOTAL_BYTES = 64 * 1024 * 1024;
export const QQ_INCOMING_FILE_TIMEOUT_MS = 30_000;
export const QQ_INCOMING_FILE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.rtf',
  '.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus'
]);

const QQ_HOSTS = new Set(['multimedia.nt.qq.com.cn', 'qpic.cn']);
const QQ_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;

export function safeIncomingFileName(value, fallback='attachment.bin') {
  const raw=basename(String(value || '').replaceAll('\\','/')).replace(QQ_FILE_NAME,'_').replace(/\s+/g,' ').trim();
  const name=raw.replace(/^\.+/,'').slice(0,180);
  return name || fallback;
}

export function incomingFileMime(name, bytes) {
  const ext=extname(name).toLowerCase();
  if(bytes?.length>=5 && bytes.subarray(0,5).toString('ascii')==='%PDF-')return 'application/pdf';
  if(bytes?.length>=8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes?.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff)return 'image/jpeg';
  if(bytes?.length>=12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  if(bytes?.length>=6 && /^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes?.length>=4 && bytes.subarray(0,4).equals(Buffer.from([0xd0,0xcf,0x11,0xe0])))return 'application/vnd.ms-office';
  if(bytes?.length>=4 && bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) {
    if(ext==='.docx')return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if(ext==='.xlsx')return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if(ext==='.pptx')return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return 'application/zip';
  }
  return ({'.doc':'application/msword','.xls':'application/vnd.ms-excel','.ppt':'application/vnd.ms-powerpoint',
    '.txt':'text/plain','.md':'text/markdown','.markdown':'text/markdown','.csv':'text/csv','.tsv':'text/tab-separated-values',
    '.rtf':'application/rtf','.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
    '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.avif':'image/avif'})[ext] || 'application/octet-stream';
}

function isLocalPath(value) { return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/'); }
function isAllowedRemote(value) {
  try { const url=new URL(value); return /^https?:$/.test(url.protocol) && (QQ_HOSTS.has(url.hostname) || url.hostname.endsWith('.qpic.cn') || ['127.0.0.1','localhost','[::1]'].includes(url.hostname)); }
  catch { return false; }
}
function imageSignatureMatches(ext,bytes) {
  if(ext==='.png')return bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(['.jpg','.jpeg'].includes(ext))return bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  if(ext==='.webp')return bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(ext==='.gif')return bytes.length>=6&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6));
  if(ext==='.bmp')return bytes.length>=2&&bytes.toString('ascii',0,2)==='BM';
  if(['.tif','.tiff'].includes(ext))return bytes.length>=4&&((bytes[0]===0x49&&bytes[1]===0x49&&bytes[2]===0x2a&&bytes[3]===0x00)||(bytes[0]===0x4d&&bytes[1]===0x4d&&bytes[2]===0x00&&bytes[3]===0x2a));
  if(ext==='.avif')return bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp'&&bytes.toString('ascii',8,12)==='avif';
  return true;
}
function candidatesFrom(value) {
  return [value?.file,value?.path,value?.url,value?.data?.file,value?.data?.path,value?.data?.url]
    .map(item=>String(item || '').trim()).filter(Boolean);
}
async function readResponse(response,maxBytes,label) {
  if(!response?.ok || response.status>=300)throw Error(`${label}下载失败（HTTP ${response?.status || 'unknown'}）`);
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared) && declared>maxBytes)throw Error(`${label}超过 ${maxBytes} 字节限制`);
  if(!response.body?.getReader) {
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>maxBytes)throw Error(`${label}超过 ${maxBytes} 字节限制`);
    return bytes;
  }
  const reader=response.body.getReader(),chunks=[];let size=0;
  try { while(true) { const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error(`${label}超过 ${maxBytes} 字节限制`);}chunks.push(Buffer.from(value)); } }
  finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks,size);
}
function authenticatedPublicFileUrl(candidate,trustedSources) {
  if(!trustedSources?.has(candidate))return false;
  try{const u=new URL(candidate);if(!/^https?:$/.test(u.protocol)||u.username||u.password)return false;
    if(isIP(u.hostname)!==4)return u.hostname==='qq.com'||u.hostname.endsWith('.qq.com')||u.hostname.endsWith('.qpic.cn');
    const [a,b]=u.hostname.split('.').map(Number);
    return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168);
  }catch{return false;}
}
async function readCandidate(candidate,{fetchImpl,maxBytes,timeoutMs,trustedSources}) {
  if(isLocalPath(candidate) && existsSync(candidate)) {
    const info=statSync(candidate);if(!info.isFile())throw Error('QQ 文件源不是普通文件');if(info.size>maxBytes)throw Error(`QQ 文件超过 ${maxBytes} 字节限制`);
    return readFile(candidate);
  }
  if(!isAllowedRemote(candidate)&&!authenticatedPublicFileUrl(candidate,trustedSources))throw Error('QQ 文件地址不是允许的本机或 QQ 媒体地址');
  const response=await fetchImpl(candidate,{signal:AbortSignal.timeout(timeoutMs),redirect:'manual'});
  if(response.status>=300 && response.status<400)throw Error('QQ 文件下载跳转被拒绝');
  return readResponse(response,maxBytes,'QQ 文件');
}

export async function downloadQqFile({part,call,root,messageId,index,peerId,fetchImpl=globalThis.fetch,maxBytes=QQ_INCOMING_FILE_MAX_BYTES,totalBytes=0,totalLimit=QQ_INCOMING_FILE_TOTAL_BYTES,timeoutMs=QQ_INCOMING_FILE_TIMEOUT_MS,receivedAt=new Date()}={}) {
  if(!part || typeof call!=='function')throw Error('QQ 文件接收参数不完整');
  const data=part.data || {}, originalName=safeIncomingFileName(data.name || data.file_name || data.filename || data.file || 'attachment.bin');
  const ext=extname(originalName).toLowerCase();
  if(!QQ_INCOMING_FILE_EXTENSIONS.has(ext))throw Error(`QQ 文件类型不支持：${ext || '无扩展名'}`);
  let sources=[];
  const fileId=data.file_id || data.id || data.file;
  if(fileId) { try { const result=await call('get_file',{file_id:String(fileId)});sources.push(...candidatesFrom(result?.data || result)); } catch {/* fallback to direct URL/path below */} }
  sources.push(...candidatesFrom(data));
  const trustedSources=new Set();
  // SnowLuma get_file resolves image/voice cache IDs, not ordinary private
  // documents. Its authenticated file API may return a public CDN IP URL.
  if(fileId&&!sources.some(p=>(isLocalPath(p)&&existsSync(p))||isAllowedRemote(p))){
    try{const response=await call('get_private_file_url',{file_id:String(fileId),file_hash:String(data.file_hash||''),...(peerId?{user_id:Number(peerId)}:{})});
      for(const url of candidatesFrom(response?.data||response)){trustedSources.add(url);sources.push(url);}
    }catch{/* report the concrete download failure below */}
  }
  let bytes,lastError;
  for(const candidate of [...new Set(sources)]) { try { bytes=await readCandidate(candidate,{fetchImpl,maxBytes,timeoutMs,trustedSources});break; } catch(error) { if(isLocalPath(candidate)||isAllowedRemote(candidate)||trustedSources.has(candidate))lastError=error; } }
  if(!bytes)throw Error(lastError?.message || 'QQ 文件下载失败：没有可用文件源');
  if(totalBytes+bytes.length>totalLimit)throw Error(`本条 QQ 消息文件总量超过 ${totalLimit} 字节限制`);
  const mimeType=incomingFileMime(originalName,bytes);
  const isImage=mimeType.startsWith('image/');
  if(ext==='.pdf' && mimeType!=='application/pdf')throw Error('QQ PDF 文件头校验失败');
  if(['.docx','.xlsx','.pptx','.zip'].includes(ext) && !['application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(mimeType))throw Error('QQ 压缩文档文件头校验失败');
  if(isImage && (!mimeType.startsWith('image/') || !imageSignatureMatches(ext,bytes)))throw Error('QQ 图片文件头校验失败');
  const day=new Date(receivedAt).toISOString().slice(0,10),safeMessage=String(messageId || 'qq').replace(/[^a-z0-9_-]/gi,'_').slice(0,100) || 'qq';
  const directory=resolve(root,day,safeMessage);await mkdir(directory,{recursive:true});
  const target=resolve(directory,`${String(index+1).padStart(2,'0')}-${originalName}`);
  if(!target.startsWith(directory+'\\') && !target.startsWith(directory+'/'))throw Error('QQ 文件路径校验失败');
  await writeFile(target,bytes,{flag:'wx'});
  return {path:target,originalName,size:bytes.length,mimeType,extension:ext,isImage,source:'qq',messageId:String(messageId || ''),receivedAt:new Date(receivedAt).toISOString()};
}
