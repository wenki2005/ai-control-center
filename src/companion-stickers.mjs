import { StickerLibrary } from './sticker-library.mjs';
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES=2*1024*1024;
/** Persona-level sticker ban list. Rows live in companion_sticker_blocks and are enforced before search/send. */
const DEFAULT_BLOCKS=[
  {kind:'file',value:'05b1daff3e950b0d57628d008c2ae9ea.png',label:'脸红害羞的卡通人物、蜡笔小新风格表情',reason:'你明确禁止：引用消息 -624455671 指出这张不许再发',personaId:'mornye'},
  {kind:'style',value:'蜡笔小新',label:'蜡笔小新风格的卡通表情（同风格一律禁用）',reason:'与被禁表情高度同风格，禁止搜索、选择或发送',personaId:'mornye'},
  {kind:'message',value:'-624455671',label:'引用消息记录',reason:'用户引用该消息指出禁止发送的表情',personaId:'mornye'}
];
function publicIp(ip) {
  if(isIP(ip)===4) {
    const [a,b]=ip.split('.').map(Number);
    return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)
      &&!(a===192&&(b===168||b===0))&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19));
  }
  return isIP(ip)===6&&/^[23]/i.test(ip)&&!/^2001:db8:/i.test(ip);
}
export async function fetchStickerRemote(value,maxBytes=MAX_BYTES,redirects=3) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw Error('表情来源需要公开 HTTPS 地址');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length||addresses.some(x=>!publicIp(x.address)))throw Error('表情来源不能指向本机或内网');
  const address=addresses[0];
  return new Promise((done,fail)=>{
    const req=request(url,{headers:{'user-agent':'Mozilla/5.0','accept':'*/*'},lookup:(_host,options,callback)=>{
      if(options?.all)callback(null,[address]);else callback(null,address.address,address.family);
    }},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();if(!redirects)return fail(Error('表情来源跳转过多'));return fetchStickerRemote(new URL(res.headers.location,url).href,maxBytes,redirects-1).then(done,fail);}
      if(res.statusCode!==200){res.resume();return fail(Error('图片来源暂时不可用'));}
      if(Number(res.headers['content-length'])>maxBytes){res.destroy();return fail(Error('表情图片过大'));}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy();fail(Error('表情图片过大'));}else chunks.push(chunk);});
      res.on('end',()=>done({bytes:Buffer.concat(chunks),type:String(res.headers['content-type']||'')}));res.on('error',fail);
    });
    req.setTimeout(10000,()=>req.destroy(Error('表情来源连接超时')));req.on('error',fail);req.end();
  });
}
function format(b) {
  if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return ['png','image/png'];
  if(b.length>=6&&/^GIF8[79]a$/.test(b.toString('ascii',0,6)))return ['gif','image/gif'];
  if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return ['jpg','image/jpeg'];
  if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return ['webp','image/webp'];
  throw Error('搜索结果不是支持的图片');
}
const suitable=row=>!/(?:素材下载|正版素材|摄影图库|摄影图|设计图库|设计图|模板|包图网|摄图网)/u.test(row.title||row.t||'')
  &&!/(?:nipic\.com|nximg\.cn|699pic\.com|ibaotu\.com|588ku\.com|pngtree\.com)/i.test(row.pageUrl||row.purl||'');
export class CompanionStickers extends StickerLibrary {
  constructor(options) { super({...options, fetchRemote:options.fetchRemote||options.remoteImpl||fetchStickerRemote, detectFormat:format, defaultBlocks:DEFAULT_BLOCKS, suitable}); }
}

