import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const secrets=new Set();
function gather(value,key='') {
  if(typeof value==='string' && /token|password|secret|api.?key|authorization/i.test(key) && value.length>=6)secrets.add(value);
  else if(value && typeof value==='object')for(const [k,v] of Object.entries(value))gather(v,k);
}
for(const file of [new URL('../runtime/qq-config.json',import.meta.url),join(homedir(),'.codex/auth.json')]) {
  try{gather(JSON.parse(readFileSync(file,'utf8')));}catch{/* optional local config */}
}
for(const [key,value] of Object.entries(process.env))gather(value,key);
// Credentials YAML values are used only for in-memory redaction, never exposed.
try {
  const text=readFileSync(join(homedir(),'.dsh/.credentials.yaml'),'utf8');
  for(const line of text.split(/\r?\n/)) {
    const match=/^\s*[\w.-]+:\s*["']?([^\s"'#]{6,})["']?\s*$/.exec(line);if(match)secrets.add(match[1]);
  }
}catch{/* optional credentials */}
export function redact(value) {
  if(typeof value==='string') {
    let text=value;
    for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
    return text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/ig,'$1[REDACTED]')
      .replace(/([?&](?:access_token|token|api_key)=)[^&#\s]+/ig,'$1[REDACTED]')
      .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd)\s*[:=]\s*)["']?[^\s,"'&}]+/ig,'$1[REDACTED]');
  }
  if(Array.isArray(value))return value.map(redact);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='isSecret'&&typeof item==='boolean'?item:/^(?:inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens|toolsTokens|totalTokens)$/.test(key)&&Number.isFinite(item)&&item>=0?item:/token|password|secret|api.?key|authorization/i.test(key)?'[REDACTED]':redact(item)]));
  return value;
}
export function containsKnownCredential(value) {
  const text=String(value);
  return [...secrets].some(secret=>secret.length>=6 && text.includes(secret));
}
export function containsCredential(value) {
  const text=String(value);
  return [...secrets].some(secret=>secret.length>=16 && text.includes(secret)) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{32,}/.test(text);
}
