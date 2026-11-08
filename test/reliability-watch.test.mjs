import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../src/store.mjs';import {ReliabilityWatch} from '../src/observability/reliability-watch.mjs';
test('observation window retains its baseline across reconstruction, counts tail gaps and never calls elapsed stable',()=>{
 const s=new Store(':memory:');let at='2026-11-06T10:00:00Z';s.now=()=>at;
 try{
  const w=new ReliabilityWatch({store:s,now:()=>at}),first=w.startWindow({id:'upgrade',hours:48});
  at='2026-11-06T11:00:00Z';const old=s.enqueue('unknown','unknown');s.notification(old.id,'uncertain');w.sample();
  const restored=new ReliabilityWatch({store:s,now:()=>at});assert.equal(restored.startWindow({id:'upgrade'}).startedAt,first.startedAt);
  at='2026-11-06T12:00:00Z';const current=restored.windowStatus();assert.equal(current.newUnknown,1);assert.equal(current.longestGapMinutes,60);assert.equal(current.missingMinutes,90);assert.equal(current.state,'observing');
  at='2026-11-08T11:00:00Z';assert.equal(restored.windowStatus().state,'elapsed');assert.ok(restored.windowStatus().estimatedCoveredHours<48);
  assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 }finally{s.close();}
});
test('watch establishes baseline without rediscovering old incidents and samples without model calls',()=>{const store=new Store(':memory:');let at='2026-11-02T01:00:00.000Z';const watch=new ReliabilityWatch({store,now:()=>at,getHealth:()=>({qq:'online'})});try{store.now=()=>at;const old=store.enqueue('old','old');store.notification(old.id,'uncertain');assert.equal(watch.sample().newUnknown,0);at='2026-11-02T02:00:00.000Z';store.now=()=>at;const fresh=store.enqueue('fresh','fresh');store.notification(fresh.id,'uncertain');assert.equal(watch.sample().newUnknown,1);assert.equal(watch.status().samples,2);assert.equal(watch.status().observedHours,1);assert.equal(store.db.prepare('SELECT count(*) n FROM tasks').get().n,0);}finally{watch.close();store.close();}});
