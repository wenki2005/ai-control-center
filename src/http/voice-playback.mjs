import {realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {relative,isAbsolute,sep,extname} from 'node:path';

// Only previously recorded voice files are addressable; the client never supplies a path.
export class VoicePlayback {
  constructor({store,root}) { Object.assign(this,{store,root}); }
  available() { return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_voice_parts'").get(); }
  list() {
    const rows=this.available()?this.store.db.prepare(`SELECT p.outboxId,p.partIndex,p.text,p.status,p.updatedAt,b.profile,o.text AS messageText,o.createdAt
      FROM qq_voice_parts p JOIN qq_voice_batches b ON b.outboxId=p.outboxId JOIN outbox o ON o.id=p.outboxId
      WHERE p.file IS NOT NULL AND p.outboxId IN (SELECT p2.outboxId FROM qq_voice_parts p2 JOIN outbox o2 ON o2.id=p2.outboxId
        WHERE p2.file IS NOT NULL GROUP BY p2.outboxId ORDER BY max(o2.createdAt) DESC LIMIT 30)
      ORDER BY o.createdAt DESC,p.outboxId,p.partIndex`).all():[];
    const records=new Map();
    for(const r of rows){
      let profile;try{profile=JSON.parse(r.profile);}catch{profile={};}
      if(!records.has(r.outboxId))records.set(r.outboxId,{id:r.outboxId,text:r.messageText,createdAt:r.createdAt,voice:profile.label||'语音',parts:[]});
      records.get(r.outboxId).parts.push({index:r.partIndex,text:r.text,status:r.status,url:`/api/voice/recordings/${encodeURIComponent(r.outboxId)}/${r.partIndex}/audio`});
    }
    if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='companion_singing_jobs'").get()){
      for(const job of this.store.db.prepare("SELECT * FROM companion_singing_jobs WHERE status='completed' ORDER BY createdAt DESC LIMIT 30").all()){
        const delivery=this.store.db.prepare('SELECT status FROM outbox WHERE dedupe=?').get('singing-audio:'+job.id)?.status||'prepared';
        records.set('singing:'+job.id,{id:'singing:'+job.id,text:job.title,createdAt:job.createdAt,voice:job.mode==='original'?'原创演唱':'歌曲翻唱',parts:[{index:0,text:job.title,status:delivery,url:`/api/companion/singing/${encodeURIComponent(job.id)}/audio`}]});
      }
    }
    return [...records.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30);
  }
  async file(id,index) {
    if(!this.available())return null;
    const row=this.store.db.prepare('SELECT file FROM qq_voice_parts WHERE outboxId=? AND partIndex=?').get(id,index);
    if(!row?.file)return null;
    try{
      const [root,file]=await Promise.all([realpath(this.root),realpath(row.file)]),rel=relative(root,file);
      if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||extname(file).toLowerCase()!=='.wav')return null;
      const info=await stat(file);return info.isFile()&&info.size>44?{file,size:info.size}:null;
    }catch{return null;}
  }
}

export async function serveVoiceRecording(req,res,playback,id,index) {
  const found=await playback.file(id,index);
  if(!found){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'这段语音文件暂不可用'}));return;}
  const headers={'content-type':'audio/wav','accept-ranges':'bytes','cache-control':'private, no-store','x-content-type-options':'nosniff'};
  let start=0,end=found.size-1,status=200;
  if(req.headers.range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(match&&(match[1]||match[2])){
      if(!match[1])start=Math.max(0,found.size-Number(match[2]));
      else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    }
    if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=found.size){res.writeHead(416,{...headers,'content-range':`bytes */${found.size}`});res.end();return;}
    status=206;headers['content-range']=`bytes ${start}-${end}/${found.size}`;
  }
  headers['content-length']=end-start+1;res.writeHead(status,headers);
  if(req.method==='HEAD'){res.end();return;}
  const stream=createReadStream(found.file,{start,end});res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
}
