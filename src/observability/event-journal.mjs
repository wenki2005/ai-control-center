/** Bound new explicit stream snapshots; unknown/usage/effect events remain append-only. */
export class EventJournal {
  constructor(db,{windowMs=1000,maxHeads=64,now=Date.now}={}) {
    Object.assign(this,{db,windowMs,maxHeads,now});this.heads=new Map();
    this.insert=db.prepare('INSERT INTO events(taskId,type,data,createdAt) VALUES(?,?,?,?)');
    this.update=db.prepare('UPDATE events SET data=? WHERE id=?');
    this.stats={receivedSnapshots:0,insertedSnapshots:0,coalescedSnapshots:0,updates:0};
  }
  identity(data) {
    const s=data?.stream;
    if(s?.kind!=='snapshot'||!s.requestId||!s.sessionId||!Number.isSafeInteger(s.runVersion)
      ||typeof data.text!=='string'||data.usage||data.progress||JSON.stringify(data).length>262144)return null;
    return JSON.stringify([s.sessionId,s.requestId,s.runVersion]);
  }
  write(taskId,type,data,createdAt) {
    const key=type==='message'&&taskId?this.identity(data):null,head=this.heads.get(taskId);
    if(!key||head&&head.key!==key){this.flush(taskId,true);}
    if(!key){this.insert.run(taskId,type,JSON.stringify(data),createdAt);return;}
    this.stats.receivedSnapshots++;
    const current=this.heads.get(taskId);
    if(current){
      current.data=data;current.lastSeenAt=createdAt;current.samples++;current.dirty=true;this.stats.coalescedSnapshots++;
      if(this.now()-current.lastFlush>=this.windowMs)this.flush(taskId);
    }else{
      if(this.heads.size>=this.maxHeads)this.flush(this.heads.keys().next().value,true);
      const next={key,data,firstSeenAt:createdAt,lastSeenAt:createdAt,samples:1,lastFlush:this.now(),dirty:false};
      next.id=this.insert.run(taskId,type,JSON.stringify(this.value(next)),createdAt).lastInsertRowid;this.heads.set(taskId,next);this.stats.insertedSnapshots++;
    }
    if(!this.timer){this.timer=setTimeout(()=>{this.timer=null;for(const id of this.heads.keys())this.flush(id);},this.windowMs);this.timer.unref?.();}
  }
  value(head){return {...head.data,coalesced:{firstSeenAt:head.firstSeenAt,lastSeenAt:head.lastSeenAt,samples:head.samples}};}
  flush(taskId,remove=false){
    const head=this.heads.get(taskId);if(!head)return;
    if(head.dirty){this.update.run(JSON.stringify(this.value(head)),head.id);head.dirty=false;head.lastFlush=this.now();this.stats.updates++;}
    if(remove)this.heads.delete(taskId);
  }
  lastActivity(taskId){return this.heads.get(taskId)?.lastSeenAt||null;}
  close(){clearTimeout(this.timer);for(const id of this.heads.keys())this.flush(id,true);}
}
