import {existsSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';

export const DOMESTIC_WORKBUDDY='C:/Program Files/WorkBuddy/WorkBuddy.exe';
export const DOMESTIC_WORKBUDDY_CLI='C:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy';

/** Resolve the explicitly chosen edition; never fall back to a similarly named app. */
export function workbuddyInstallation(config={}, {exists=existsSync,read=readFileSync}={}){
  const executable=config.workbuddyDesktopPath||DOMESTIC_WORKBUDDY;
  const cli=config.workbuddyCli||DOMESTIC_WORKBUDDY_CLI;
  const edition=config.workbuddyEdition||'domestic';
  let verifiedDomestic=false;
  try{const product=JSON.parse(read(join(dirname(cli),'../product.json'),'utf8'));
    const endpoint=new URL(product.endpoint);verifiedDomestic=endpoint.hostname==='copilot.tencent.com'&&product.authentication?.attributes?.internalDomain?.includes('www.workbuddy.cn')===true;
  }catch{}
  const installed=exists(executable),cliAvailable=exists(cli);
  return {executable,cli,edition,verifiedDomestic,status:{edition,name:edition==='domestic'?'WorkBuddy（国内版）':'WorkBuddy（指定版本）',installed,cliAvailable,verifiedDomestic,openAvailable:installed&&edition==='domestic'&&verifiedDomestic}};
}

export async function openDomesticWorkbuddy(installation,{spawnImpl=spawn}={}){
  if(!installation.status.openAvailable)throw Error('尚未核验国内版WorkBuddy安装，未改用国外版');
  const child=spawnImpl(installation.executable,[],{windowsHide:true,detached:true,stdio:'ignore',shell:false});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref?.();
  return {edition:'domestic',name:'WorkBuddy（国内版）',stage:'launched',message:'已向国内版WorkBuddy发送打开请求；这不代表已经登录或执行任务。'};
}
