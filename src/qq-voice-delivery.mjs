import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {speechChunks} from './voice-text.mjs';

// The original outbox row remains the logical message. Acknowledgements for
// its audio bubbles are committed individually, before the parent is sent.
export class VoiceDelivery {
  constructor({store,voice}) {
    Object.assign(this,{store,voice});
    store.db.exec(`CREATE TABLE IF NOT EXISTS qq_voice_batches(
      outboxId TEXT PRIMARY KEY,sourceHash TEXT NOT NULL,profile TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qq_voice_parts(
        outboxId TEXT NOT NULL,partIndex INTEGER NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
        file TEXT,synthesisAttempts INTEGER NOT NULL DEFAULT 0,sendAttempts INTEGER NOT NULL DEFAULT 0,
        receipt TEXT,error TEXT,updatedAt TEXT NOT NULL,PRIMARY KEY(outboxId,partIndex));`);
  }
  parts(id){return this.store.db.prepare('SELECT * FROM qq_voice_parts WHERE outboxId=? ORDER BY partIndex').all(id);}
  async prepare(row) {
    const hash=createHash('sha256').update(row.text).digest('hex');
    let batch=this.store.db.prepare('SELECT * FROM qq_voice_batches WHERE outboxId=?').get(row.id);
    if(!batch) {
      const chunks=speechChunks(row.text,{maxCharacters:120});if(!chunks.length)throw Object.assign(Error('正文没有可朗读内容'),{uncertain:false});
      const profile=this.voice.currentProfile();
      this.store.transaction(()=>{
        this.store.db.prepare('INSERT OR IGNORE INTO qq_voice_batches VALUES(?,?,?,?)').run(row.id,hash,JSON.stringify(profile),this.store.now());
        const add=this.store.db.prepare('INSERT OR IGNORE INTO qq_voice_parts(outboxId,partIndex,text,updatedAt) VALUES(?,?,?,?)');
        chunks.forEach((text,index)=>add.run(row.id,index,text,this.store.now()));
      });
      batch=this.store.db.prepare('SELECT * FROM qq_voice_batches WHERE outboxId=?').get(row.id);
    }
    if(batch.sourceHash!==hash)throw Object.assign(Error('语音正文已变化，需要核对原投递记录'),{uncertain:true});
    const parts=this.parts(row.id),unknown=parts.find(p=>['sending','uncertain'].includes(p.status));
    if(unknown) {
      this.store.db.prepare("UPDATE qq_voice_parts SET status='uncertain',updatedAt=? WHERE outboxId=? AND partIndex=?").run(this.store.now(),row.id,unknown.partIndex);
      throw Object.assign(Error('其中一段语音发送结果未知，已保留回执，不能自动重发'),{uncertain:true});
    }
    const plan={id:row.id,profile:JSON.parse(batch.profile),parts};
    const next=parts.find(p=>p.status!=='sent');
    if(next)plan.file=await this.audio(plan,next);
    return plan;
  }
  async audio(plan,part) {
    if(part.file)try{if((await stat(part.file)).size>44)return part.file;}catch{}
    const attempts=Number(part.synthesisAttempts)||0;
    if(attempts>=3)throw Object.assign(Error('本段语音合成已连续失败三次'),{uncertain:false,voiceFallback:true});
    let error;
    for(let attempt=attempts;attempt<Math.min(3,attempts+2);attempt++) {
      this.store.db.prepare('UPDATE qq_voice_parts SET synthesisAttempts=synthesisAttempts+1,updatedAt=? WHERE outboxId=? AND partIndex=?').run(this.store.now(),plan.id,part.partIndex);
      const lease=setInterval(()=>{try{this.store.db.prepare("UPDATE outbox SET updatedAt=? WHERE id=? AND status='sending'").run(this.store.now(),plan.id);}catch{}},15000);lease.unref?.();
      try {
        const file=await this.voice.synthesize(part.text,{profile:plan.profile});
        this.store.db.prepare("UPDATE qq_voice_parts SET file=?,status='prepared',error=NULL,updatedAt=? WHERE outboxId=? AND partIndex=?").run(file,this.store.now(),plan.id,part.partIndex);
        return file;
      } catch(e) {
        error=e;this.store.db.prepare('UPDATE qq_voice_parts SET error=?,updatedAt=? WHERE outboxId=? AND partIndex=?').run(String(e.message).slice(0,500),this.store.now(),plan.id,part.partIndex);
        if(e.voiceFallback||['TimeoutError','AbortError'].includes(e.name))throw Object.assign(Error('本地语音合成等待超时，本条改发尚未发送的文字'),{uncertain:false,voiceFallback:true});
      } finally {clearInterval(lease);}
    }
    throw Object.assign(Error('本地语音合成暂时失败：'+String(error?.message||'unknown').slice(0,200)),{uncertain:false,voiceFallback:attempts+2>=3,voicePending:attempts+2<3});
  }
  async send(plan,{sendRecord,receipt,allowed=()=>true,touch=()=>{},wait=async()=>{}}) {
    let last;
    for(const part of this.parts(plan.id)) {
      if(part.status==='sent'){last=JSON.parse(part.receipt);continue;}
      if(!allowed())throw Object.assign(Error('消息已撤回、被更新或语音模式已关闭'),{uncertain:false,suppressed:true});
      const file=await this.audio(plan,part);
      if(!allowed())throw Object.assign(Error('消息已撤回、被更新或语音模式已关闭'),{uncertain:false,suppressed:true});
      this.store.db.prepare("UPDATE qq_voice_parts SET status='sending',sendAttempts=sendAttempts+1,updatedAt=? WHERE outboxId=? AND partIndex=?").run(this.store.now(),plan.id,part.partIndex);touch();
      try {
        last=receipt(await sendRecord(file));
        this.store.db.prepare("UPDATE qq_voice_parts SET status='sent',receipt=?,error=NULL,updatedAt=? WHERE outboxId=? AND partIndex=?").run(JSON.stringify({message_id:last.message_id}),this.store.now(),plan.id,part.partIndex);
        this.store.event(null,'qq.voice-part-sent',{outboxId:plan.id,partIndex:part.partIndex,messageId:last.message_id,profileId:plan.profile.id});
      } catch(e) {
        const unknown=e.uncertain!==false;
        this.store.db.prepare('UPDATE qq_voice_parts SET status=?,error=?,updatedAt=? WHERE outboxId=? AND partIndex=?').run(unknown?'uncertain':'prepared',String(e.message).slice(0,500),this.store.now(),plan.id,part.partIndex);
        if(!unknown&&Number(part.sendAttempts)+1>=3)e.voiceFallback=true;
        throw e;
      }
      touch();if(part.partIndex<plan.parts.length-1)await wait();
    }
    return last;
  }
  remaining(row) {
    const parts=this.parts(row.id);return parts.some(p=>p.status==='sent')?parts.filter(p=>p.status!=='sent').map(p=>p.text).join(''):row.text;
  }
  fallback(row) {
    this.store.db.prepare("UPDATE qq_voice_parts SET status='text-fallback',updatedAt=? WHERE outboxId=? AND status NOT IN ('sent','uncertain','sending')").run(this.store.now(),row.id);
  }
}
