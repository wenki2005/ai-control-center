import {createHash} from 'node:crypto';
import {containsCredential} from '../redact.mjs';

export const memoryVersion=text=>createHash('sha256').update(text).digest('hex');
export function semanticRecords(db,{now=Date.now()}={}){
 const has=name=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name),records=[];
 if(has('companion_facts'))for(const r of db.prepare("SELECT rowid sourceRowid,* FROM companion_facts WHERE status='active'").all())records.push({key:`fact:${r.id||r.sourceRowid}`,kind:'fact',layer:'semantic',text:`${r.key}：${r.value}`,source:r.source||'用户确认事实',savedAt:r.updatedAt,validFrom:r.validFrom});
 if(has('companion_memories'))for(const r of db.prepare("SELECT rowid sourceRowid,* FROM companion_memories WHERE status='active'").all())records.push({key:`memory:${r.id||r.sourceRowid}`,kind:'memory',layer:'semantic',text:r.text,source:r.source||'共用记忆',savedAt:r.updatedAt});
 if(has('companion_chat'))for(const r of db.prepare("SELECT id,text,createdAt FROM companion_chat WHERE role='user' AND retractedAt IS NULL").all())records.push({key:`chat:${r.id}`,kind:'episode',layer:'episodic',text:r.text,source:`真实聊天 #${r.id}`,savedAt:r.createdAt,validFrom:r.createdAt});
 if(has('timeline_entries'))for(const r of db.prepare("SELECT * FROM timeline_entries WHERE active=1 AND (sourceKind IN ('note','note-file') OR (sourceKind='fact' AND sourceLabel LIKE '历史事实%'))").all())records.push({key:`timeline:${r.id}`,kind:'timeline',layer:'episodic',text:`${r.title}；${r.text}`,source:r.sourceLabel,savedAt:r.recordedAt,validFrom:r.occurredAt});
 return records.filter(r=>r.text?.trim()&&!containsCredential(r.text)&&(!r.savedAt||Date.parse(r.savedAt)<=now)&&(!r.validFrom||Date.parse(r.validFrom)<=now)).flatMap(r=>{
  const version=memoryVersion(JSON.stringify([r.text,r.source,r.savedAt,r.validFrom]));const chunks=[];
  for(let offset=0;offset<r.text.length;offset+=800)chunks.push({...r,key:`${r.key}@${offset}`,recordKey:r.key,version,text:r.text.slice(offset,offset+900)});
  return chunks;
 });
}
