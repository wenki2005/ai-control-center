import { spawn as nodeSpawn } from 'node:child_process';
import { isIP } from 'node:net';
import { redact } from '../redact.mjs';

const bili = (process.env.HUB_BILI_COMMAND || 'bili');
const mcporterCli = (process.env.HUB_MCPORTER_CLI || 'mcporter');
const MAX_OUTPUT = 18000;
const BVID = /^BV[0-9A-Za-z]{10}$/;

function privateHost(host) {
  const value=host.toLowerCase().replace(/^\[|\]$/g,'');
  if(value==='localhost'||value.endsWith('.localhost')||value.endsWith('.local')||value.endsWith('.internal'))return true;
  if(isIP(value)===4) {
    const [a,b]=value.split('.').map(Number);
    return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
  }
  if(isIP(value)===6)return value==='::1'||value==='::'||value.startsWith('fc')||value.startsWith('fd')||value.startsWith('fe80:');
  return false;
}

export function publicWebUrl(raw) {
  if(typeof raw!=='string'||raw.length>2048)throw Error('网页地址无效或过长');
  let url;
  try{url=new URL(raw);}catch{throw Error('请提供完整的网页地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||privateHost(url.hostname))throw Error('只允许读取公开 HTTP/HTTPS 网页');
  return url.href;
}

export function publicSearchResults(raw) {
  const results = [];
  const seen = new Set();
  for (const block of String(raw ?? '').split(/\r?\n\s*---\s*\r?\n/u)) {
    const title = block.match(/^Title:[ \t]*(.+)$/imu)?.[1]?.trim();
    const target = block.match(/^URL:[ \t]*(\S+)$/imu)?.[1];
    if (!title || !target) continue;
    let url;
    try { url = publicWebUrl(target); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const excerpt = block.match(/^Highlights:[ \t]*([\s\S]*)$/imu)?.[1]?.trim() || '';
    results.push({ title: redact(title).slice(0, 180), url: redact(url), excerpt: redact(excerpt).slice(0, 850) });
  }
  return results;
}

function execute(command,args,{spawn=nodeSpawn,timeoutMs=30000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const capture=(target,chunk)=>{target.value+=chunk.toString('utf8');if(target.value.length>MAX_OUTPUT)child.kill();};
    const out={value:''},err={value:''};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>capture(out,chunk));child.stderr.on('data',chunk=>capture(err,chunk));
    child.once('error',error=>finish(Error(`联网工具启动失败：${error.message}`)));
    child.once('close',(code,signal)=>{
      stdout=out.value;stderr=err.value;
      if(stdout.length>MAX_OUTPUT)return finish(Error('联网结果过长，已停止读取'));
      if(code!==0)return finish(Error((stderr.trim()||`联网工具退出码 ${code??signal}`).slice(-1500)));
      finish(null,stdout.trim()||'没有返回可读内容。');
    });
    const timer=setTimeout(()=>{child.kill();finish(Error('联网读取超时，请稍后再试。'));},timeoutMs);
    timer.unref?.();
  });
}

export function createResearchRunner({spawn=nodeSpawn,fetchImpl=fetch}={}) {
  return async ({action,query,url,bvid})=>{
    if(action==='web-search') {
      const q=String(query||'').trim();if(!q||q.length>500)throw Error('搜索词需要为 1–500 个字符');
      return execute(mcporterCli,['call','exa.web_search_exa',`query=${q}`,'numResults=5'],{spawn});
    }
    if(action==='bili-search') {
      const q=String(query||'').trim();if(!q||q.length>200)throw Error('B站搜索词需要为 1–200 个字符');
      return execute(bili,['search',q,'--type','video','-n','5'],{spawn});
    }
    if(action==='bili-hot')return execute(bili,['hot','-n','8'],{spawn});
    if(action==='bili-video') {
      if(!BVID.test(String(bvid||'')))throw Error('请提供有效的 B 站 BV 号');
      return execute(bili,['video',bvid],{spawn});
    }
    if(action==='bili-subtitle') {
      if(!BVID.test(String(bvid||'')))throw Error('请提供有效的 B 站 BV 号');
      return execute(process.env.HUB_OPENCLI_COMMAND || 'opencli',['bilibili','subtitle',bvid,'-f','yaml'],{spawn,timeoutMs:45000});
    }
    if(action==='read-webpage') {
      const target=publicWebUrl(url);
      const response=await fetchImpl(`https://r.jina.ai/${target}`,{headers:{'accept':'text/plain'},signal:AbortSignal.timeout(25000),redirect:'error'});
      if(!response.ok)throw Error(`网页读取失败（HTTP ${response.status}）`);
      const text=(await response.text()).slice(0,MAX_OUTPUT);
      return text||'页面没有返回可读正文。';
    }
    throw Error('不支持的联网读取类型');
  };
}

export const researchInternals={mcporterCli,bili,BVID};
