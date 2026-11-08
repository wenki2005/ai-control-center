import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
export function writeStableDocument(file,text,encoding='utf8') {
  const next=Buffer.from(text,typeof encoding==='string'?encoding:'utf8');
  try{const old=readFileSync(file);if(old.length===next.length&&hash(old)===hash(next))return false;}catch(error){if(error.code!=='ENOENT')throw error;}
  writeFileSync(file,next);return true;
}
