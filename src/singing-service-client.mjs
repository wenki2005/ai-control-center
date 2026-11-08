import { spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const HOST='http://127.0.0.1:9894';
let starting=null;

function refused(error){return error?.cause?.code==='ECONNREFUSED'||error?.code==='ECONNREFUSED';}
async function fetchJson(url,options={},timeoutMs=5000){
  let response;
  try{response=await fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});}catch(error){if(options.method==='POST')throw Object.assign(Error('演唱请求的回执尚未取得，请先查询进度，不要重复提交。'),{uncertain:true,cause:error});throw error;}
  let data;try{data=await response.json();}catch{throw Error('歌声服务返回了无法识别的响应');}
  if(!response.ok)throw Error(data?.error||`歌声服务请求失败（${response.status}）`);
  return data;
}
async function health(){const result=await fetchJson(`${HOST}/health`);if(result?.service!=='ai-center-singing'||result.status!=='ready')throw Error('9894端口响应的不是本地歌声服务');return result;}
async function start(root){
  if(!starting)starting=(async()=>{
    const runtime=join(root,'runtime'),entry=join(root,'src','singing-service.mjs');mkdirSync(runtime,{recursive:true});
    const node=join(process.env.ProgramFiles||'C:\\Program Files','nodejs','node.exe');
    const executable=existsSync(node)?node:'node';
    const log=join(runtime,'singing-service.log');
    const child=spawn(executable,[entry],{cwd:root,windowsHide:true,detached:true,stdio:'ignore',env:{...process.env}});
    let startupError;child.on('error',error=>{startupError=error;});child.unref();
    appendFileSync(log,`${new Date().toISOString()} requested local singing service startup (pid ${child.pid||'unknown'})\n`);
    let last;
    for(let i=0;i<40;i++){
      if(startupError)throw Error('无法启动本地歌声服务：已安装的 Node 不可用');
      try{return await health();}catch(error){last=error;if(!refused(error))throw error;await delay(250);}
    }
    throw Error(`本地歌声服务启动未就绪：${last?.message||'等待超时'}`);
  })().finally(()=>{starting=null;});
  return starting;
}

export async function singingServiceCall(root,path,value){
  root=resolve(root);const endpoint=String(path||'');if(!endpoint.startsWith('/')||endpoint.startsWith('//'))throw Error('歌声服务路径无效');
  try{await health();}catch(error){if(!refused(error))throw error;if(value===undefined)throw Object.assign(Error('歌声后台当前未启动，状态查询不会加载模型'),{code:'SINGING_STOPPED'});await start(root);}
  const options=value===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)};
  return fetchJson(`${HOST}${endpoint}`,options,value===undefined?5000:65000);
}

export async function singingServiceStatus(root){
  try{return await singingServiceCall(root,'/singing');}catch(error){if(error.code==='SINGING_STOPPED')return null;throw error;}
}
