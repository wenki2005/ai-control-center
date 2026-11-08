export class ReliabilityWatch {
 constructor({store,getHealth=()=>({}),getProfile=()=>null,now=()=>new Date().toISOString()}){Object.assign(this,{store,getHealth,getProfile,now});store.db.exec('CREATE TABLE IF NOT EXISTS reliability_samples(at TEXT PRIMARY KEY,metrics TEXT NOT NULL)');}
 sample(){const {store}=this,at=this.now(),previous=store.db.prepare('SELECT at,metrics FROM reliability_samples ORDER BY at DESC LIMIT 1').get();
 const counts=sql=>store.db.prepare(sql).get().n;
 const metrics={uncertain:counts("SELECT count(*) n FROM outbox WHERE status='uncertain'"),pending:counts("SELECT count(*) n FROM outbox WHERE status IN ('pending','sending')"),errors:counts('SELECT count(*) n FROM errors'),failedTasks:counts("SELECT count(*) n FROM tasks WHERE status='failed'"),newFailures:previous?store.db.prepare("SELECT count(*) n FROM tasks WHERE status='failed' AND updatedAt>?").get(previous.at).n:0,newUnknown:previous?store.db.prepare("SELECT count(*) n FROM outbox WHERE status='uncertain' AND updatedAt>?").get(previous.at).n:0,health:Object.fromEntries(['dsh','qq','codex'].map(k=>[k,this.getHealth()[k]])),state:this.getProfile()};
 store.db.prepare('INSERT OR IGNORE INTO reliability_samples VALUES(?,?)').run(at,JSON.stringify(metrics));store.db.prepare('DELETE FROM reliability_samples WHERE at<?').run(new Date(Date.parse(at)-7*86400000).toISOString());return {at,...metrics};}
 start(){this.sample();this.timer=setInterval(()=>{try{this.sample();}catch{this.lastError='本地运行采样失败';}},15*60*1000);this.timer.unref?.();}
 close(){clearInterval(this.timer);}
 startWindow({id,hours=48}={}){
  if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(id)||!Number.isFinite(hours)||hours<1||hours>144)throw Error('观察窗口参数无效');
  const key='reliability:window:'+id,saved=this.store.meta(key);
  if(!saved){const baseline=this.sample(),startedAt=baseline.at;this.store.meta(key,JSON.stringify({id,startedAt,endsAt:new Date(Date.parse(startedAt)+hours*3600000).toISOString(),baseline}));}
  this.store.meta('reliability:active-window',id);return this.windowStatus(id);
 }
 windowStatus(id=this.store.meta('reliability:active-window')){
  if(!id)return null;const saved=this.store.meta('reliability:window:'+id);if(!saved)return null;
  const window=JSON.parse(saved),end=Math.min(Date.parse(this.now()),Date.parse(window.endsAt)),start=Date.parse(window.startedAt);
  const rows=this.store.db.prepare('SELECT at,metrics FROM reliability_samples WHERE at>=? AND at<=? ORDER BY at').all(window.startedAt,new Date(end).toISOString());
  const points=[start,...rows.map(r=>Date.parse(r.at)),end],gaps=points.slice(1).map((at,i)=>Math.max(0,at-points[i]));
  const missingMs=gaps.reduce((sum,gap)=>sum+(gap>22.5*60000?gap-15*60000:0),0);
  return {...window,state:Date.parse(this.now())>=Date.parse(window.endsAt)?'elapsed':'observing',samples:rows.length,
   observedSpanHours:Math.max(0,end-start)/3600000,estimatedCoveredHours:Math.max(0,end-start-missingMs)/3600000,
   longestGapMinutes:Math.max(0,...gaps)/60000,missingMinutes:missingMs/60000,
   newUnknown:this.store.db.prepare("SELECT count(*) n FROM outbox WHERE status='uncertain' AND updatedAt>? AND updatedAt<=?").get(window.startedAt,new Date(end).toISOString()).n,
   newFailures:this.store.db.prepare("SELECT count(*) n FROM tasks WHERE status='failed' AND updatedAt>? AND updatedAt<=?").get(window.startedAt,new Date(end).toISOString()).n,
   latest:rows.at(-1)?{at:rows.at(-1).at,...JSON.parse(rows.at(-1).metrics)}:null,
   evidence:'采样间隙计入缺口；窗口到期不表示连续稳定，新增失败包含内部任务。'};
 }
 status(){const rows=this.store.db.prepare('SELECT at,metrics FROM reliability_samples ORDER BY at').all();const gaps=rows.slice(1).map((r,i)=>Date.parse(r.at)-Date.parse(rows[i].at));return {longestGapMinutes:gaps.length?Math.max(...gaps)/60000:0,lastError:this.lastError||null,intervalMinutes:15,samples:rows.length,startedAt:rows[0]?.at||null,latest:rows.at(-1)?{at:rows.at(-1).at,...JSON.parse(rows.at(-1).metrics)}:null,observedHours:rows.length>1?(Date.parse(rows.at(-1).at)-Date.parse(rows[0].at))/3600000:0};}
}
