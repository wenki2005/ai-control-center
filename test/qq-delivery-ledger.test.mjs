import {eligibleNotifications} from '../src/qq-delivery-ledger.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {QqBridge} from '../src/qq.mjs';
import {Hub} from '../src/hub.mjs';

test('a repeated report enqueue returns its original complete manifest',()=>{
 const store=new Store(':memory:');
 try{const hub={store,notify:async()=>{}};
  const a=Hub.prototype.notification.call(hub,'第一段\n第二段','stable',{deferNotify:true});
  const b=Hub.prototype.notification.call(hub,'第一段\n第二段','stable',{deferNotify:true});
  assert.equal(a.length,2);assert.deepEqual(b,a);assert.equal(store.db.prepare('SELECT count(*) n FROM outbox').get().n,2);
 }finally{store.close();}
});

test('unknown first segment holds its successors but not an independent reply',async()=>{
 const store=new Store(':memory:'),bridge=new QqBridge({store,onMessage:async()=>{},intervalMs:0});const sent=[];
 bridge.send=async text=>{sent.push(text);if(text==='first')throw Object.assign(Error('lost receipt'),{uncertain:true});return {message_id:42};};
 try{
  store.enqueue('first','reply:part:0');store.enqueue('second','reply:part:1');store.enqueue('other','other:part:0');
  await bridge.flush();await bridge.flush();await bridge.flush();
  assert.deepEqual(sent,['first','other']);
  assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='reply:part:1'").get().status,'pending');
  assert.deepEqual(store.db.prepare('SELECT status FROM qq_delivery_attempts ORDER BY rowid').all().map(x=>x.status),['uncertain','sent']);
 }finally{await bridge.close();store.close();}
});

test('all confirmed segments flow in order and persist each platform receipt',async()=>{
 const store=new Store(':memory:'),bridge=new QqBridge({store,onMessage:async()=>{},intervalMs:0});let n=0;
 bridge.send=async()=>({message_id:++n});
 try{
  for(let i=0;i<3;i++)store.enqueue(String(i),`reply:part:${i}`);
  await bridge.flush();await bridge.flush();assert.equal(n,3);
  assert.deepEqual(store.db.prepare('SELECT platformMessageId FROM qq_delivery_attempts ORDER BY rowid').all().map(x=>x.platformMessageId),['1','2','3']);
 }finally{await bridge.close();store.close();}
});

test('success without a platform receipt stays unknown and is never resent',async()=>{
 const store=new Store(':memory:'),bridge=new QqBridge({store,onMessage:async()=>{},intervalMs:0});let n=0;
 bridge.send=async()=>{n++;return {};};
 try{const row=store.enqueue('hello','missing-receipt');await bridge.flush();await bridge.flush();assert.equal(n,1);assert.equal(store.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id).status,'uncertain');}
 finally{await bridge.close();store.close();}
});

test('indexed groups remain independent with a large blocked backlog',()=>{
 const store=new Store(':memory:');try{
  store.transaction(()=>{for(let i=0;i<1000;i++){const r=store.enqueue('unknown','blocked'+i+':part:0');store.notification(r.id,'uncertain');store.enqueue('tail','blocked'+i+':part:1');}store.enqueue('ready','independent:part:0');});
  const rows=eligibleNotifications(store);assert.equal(rows.length,1);assert.equal(rows[0].text,'ready');
  store.enqueue('missing predecessor','gap:part:2');assert.equal(eligibleNotifications(store).length,1);
  assert.match(JSON.stringify(store.db.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM outbox WHERE deliveryGroup=? AND partIndex<?').all('a',2)),/outbox_group_parts/);
 }finally{store.close();}
});
