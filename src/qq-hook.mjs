// Narrow ingress hook imported by QQ Agent only after independent validation.
import { readFileSync, existsSync } from 'node:fs';
import { isHubCommand, eventText, OWNER } from './qq.mjs';
const enabledFile=new URL('../runtime/qq-ingress-enabled',import.meta.url);
const tokenFile=new URL('../runtime/qq-hook-token',import.meta.url);
const modeFile=new URL('../runtime/qq-mode',import.meta.url);
export async function handleHubIngress({kind,id,event}) {
  const mode=existsSync(modeFile)?readFileSync(modeFile,'utf8').trim():'prefix';
  if(!existsSync(enabledFile) || kind!=='private' || String(id)!==OWNER || (mode!=='all' && !isHubCommand(eventText(event))))return false;
  const token=readFileSync(tokenFile,'utf8').trim();
  const response=await fetch('http://127.0.0.1:3188/api/qq/incoming',{method:'POST',headers:{'content-type':'application/json','x-hub-hook':token},
    body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('中枢入站服务 HTTP '+response.status);
  const result=await response.json();if(!result.accepted)throw Error('中枢入站未接受该消息');return true;
}
