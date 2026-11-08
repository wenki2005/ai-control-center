import { existsSync, readFileSync, appendFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { redact } from './redact.mjs';

const HEARTBEAT_GRACE_MS = 120000;
const DSH_ALERT_GRACE_MS = 180000;
const DSH_PENDING_ALERT = 'guardian:dsh:pending-alert';

export class GuardianMonitor {
  constructor({runtime,store,notify=()=>{},onChange=()=>{},ensureGuardian=()=>{},now=()=>Date.now()}) {
    Object.assign(this,{runtime,store,notify,onChange,ensureGuardian,now});this.startedAt=now();this.lastGuardianWake=0;
  }
  state() {
    try {
      const raw=readFileSync(join(this.runtime,'guardian-state.json'),'utf8');
      if(raw.length>100000)throw Error('oversized state');
      const state=JSON.parse(raw),updated=Date.parse(state.updatedAt);
      return {...redact(state),stale:!Number.isFinite(updated) || this.now()-updated>90000};
    }catch{return {guardian:{status:'unknown'},services:{},stale:true};}
  }
  wake() {
    writeFileSync(join(this.runtime,'guardian-wake'),new Date(this.now()).toISOString());
    return {accepted:true,message:'已请求看门狗检查并恢复服务'};
  }
  async poll() {
    const events=join(this.runtime,'guardian-events.jsonl');
    const ackFile=join(this.runtime,'guardian-events.ack.jsonl'),knownAcks=new Set();
    if(existsSync(ackFile))for(const line of readFileSync(ackFile,'utf8').split(/\r?\n/)) {
      try{knownAcks.add(JSON.parse(line).id);}catch{/* tolerate an interrupted final line */}
    }
    const ack=[];
    const stream=existsSync(events)?createReadStream(events,{encoding:'utf8'}):null;
    const reader=stream?createInterface({input:stream,crlfDelay:Infinity}):null;
    try{if(reader)for await(const line of reader) {
      if(line.length>100000)continue;
      let event;try{event=JSON.parse(line);}catch{continue;}
      if(typeof event.id!=='string' || event.id.length>128 || !['warning','recovered'].includes(event.severity))continue;
      const key='guardian:event:'+event.id;
      if(knownAcks.has(event.id))continue;
      // Only suppress a recovered readiness blip inside a bounded planned reload.
      let planned=false;
      try {const raw=readFileSync(join(this.runtime,'planned-reload.json'),'utf8').replace(/^\uFEFF/,'');const window=JSON.parse(raw);
        const at=Date.parse(event.createdAt);
        planned=window.service==='hub' && event.service==='hub' && event.message?.includes('Readiness failed before recovery attempt') && at>=Date.parse(window.startedAt) && at<=Date.parse(window.expiresAt) && this.state().services?.hub?.status==='healthy';
      }catch{}
      if(planned){this.store.event(null,'guardian.planned-reload',event);ack.push(JSON.stringify({id:event.id,ackedAt:new Date(this.now()).toISOString()}));knownAcks.add(event.id);continue;}
      if(!this.store.meta(key))this.store.transaction(()=>{
        const message=redact(String(event.message || '服务状态变化')).slice(0,1500);
        this.store.event(null,'guardian.'+event.severity,{...event,message});
        if(event.severity==='warning')this.store.error(null,'看门狗：'+message);
        if(event.service==='dsh') {
          if(event.severity==='recovered') {
            const raw=this.store.meta(DSH_PENDING_ALERT);let notified=false;try{notified=!!JSON.parse(raw||'null')?.notified;}catch{}
            if(raw)this.store.event(null,notified?'guardian.alert-recovered':'guardian.alert-recovered-before-notification',{service:'dsh',eventId:event.id});
            this.store.meta(DSH_PENDING_ALERT,'');
          }else if(!this.store.meta(DSH_PENDING_ALERT))this.store.meta(DSH_PENDING_ALERT,JSON.stringify({key,firstSeen:this.now(),eventId:event.id}));
        }else this.store.enqueue((event.severity==='warning'?'AI 中枢异常：':'AI 中枢恢复：')+message,key);
        this.store.meta(key,new Date(this.now()).toISOString());
      });
      ack.push(JSON.stringify({id:event.id,ackedAt:new Date(this.now()).toISOString()}));
      knownAcks.add(event.id);
      if(ack.length>=1000)break;
    }}finally{reader?.close();stream?.destroy();}
    if(ack.length)appendFileSync(ackFile,ack.join('\n')+'\n');
    const state=this.state();
    const pendingDsh=this.store.meta(DSH_PENDING_ALERT);
    if(pendingDsh&&!state.stale){
      let pending;try{pending=JSON.parse(pendingDsh);}catch{}
      const dsh=state.services?.dsh;
      if(pending&&dsh?.status==='healthy'&&(dsh.consecutiveFailures??0)===0){
        this.store.event(null,pending.notified?'guardian.alert-recovered':'guardian.alert-recovered-before-notification',{service:'dsh',eventId:pending.eventId});
        this.store.meta(DSH_PENDING_ALERT,'');
      }else if(pending&&!pending.notified&&dsh?.status==='degraded'&&this.now()-pending.firstSeen>=DSH_ALERT_GRACE_MS){
        this.store.enqueue('DSH 连接探测连续异常已超过3分钟，中枢正在保留原工作并继续检查；这项探测尚不能判断模型任务是否失败。',pending.key);
        this.store.meta(DSH_PENDING_ALERT,JSON.stringify({...pending,notified:true}));
      }
    }
    if(this.now()-this.startedAt>90000) {
      const now=this.now();
      const previous=this.store.meta('guardian:heartbeat') || 'healthy';
      const current=state.stale?'stale':'healthy';
      const staleSinceRaw=this.store.meta('guardian:heartbeat:stale-since');
      const notified=this.store.meta('guardian:heartbeat:notified') || 'healthy';
      const staleSince=Number(staleSinceRaw);
      this.store.transaction(()=>{
        this.store.meta('guardian:heartbeat',current);
        if(current==='stale') {
          const firstStale=Number.isFinite(staleSince) && staleSince>0 ? staleSince : now;
          if(!staleSinceRaw)this.store.meta('guardian:heartbeat:stale-since',String(firstStale));
          // A brief read/update pause is not an outage. Require two minutes of
          // continuous staleness before sending one warning, then stay quiet
          // until a real recovery is observed.
          if(notified!=='stale' && now-firstStale>=HEARTBEAT_GRACE_MS) {
            const text='看门狗超过 90 秒未更新，请检查后台守护进程。';
            this.store.error(null,text);
            this.store.enqueue(text,`guardian:heartbeat:stale:${Math.floor(now/HEARTBEAT_GRACE_MS)}`);
            this.store.meta('guardian:heartbeat:notified','stale');
            this.store.meta('guardian:heartbeat:last-notified-at',String(now));
          }
        } else {
          if(staleSinceRaw)this.store.meta('guardian:heartbeat:stale-since','');
          // Only announce recovery if a stale warning was actually sent. This
          // prevents a one-poll stale blip from producing a warning/recovery pair.
          if(previous==='stale' && notified==='stale') {
            this.store.enqueue('看门狗心跳已恢复。',`guardian:heartbeat:recovered:${Math.floor(now/HEARTBEAT_GRACE_MS)}`);
            this.store.meta('guardian:heartbeat:notified','healthy');
            this.store.meta('guardian:heartbeat:last-notified-at',String(now));
          }
        }
      });
      if(state.stale && this.now()-this.lastGuardianWake>120000) {
        this.lastGuardianWake=this.now();await this.ensureGuardian();
      }
    }
    this.onChange();await this.notify();return state;
  }
}
