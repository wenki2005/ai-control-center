import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {QqBridge,OWNER} from '../src/qq.mjs';

test('QQ rate limiting stops after bounded retries and preserves the message for explicit recovery without flooding errors',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'qq-recovery-'));const store=new Store(join(runtime,'control.sqlite'));
  const bridge=new QqBridge({store,onMessage:async()=>{}});let failures=6;
  bridge.send=async()=>{if(failures-->0){const error=Error('QQ HTTP 429');error.httpStatus=429;error.uncertain=false;throw error;}return {message_id:123};};
  try{
    const row=store.enqueue('异常已落盘，恢复后补发','durable-outage');
    for(let i=0;i<4;i++){const key='qq-delivery-retry:'+row.id,state=JSON.parse(store.meta(key)||'{}');store.meta(key,JSON.stringify({...state,nextAt:0}));bridge.nextFlushAt=0;await bridge.flush();}
    assert.equal(store.pendingNotifications().length,0);assert.equal(store.errors().length,1);assert.equal(store.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id).status,'failed');
    failures=0;store.notification(row.id,'pending'); // Explicit operator recovery, never automatic historical replay.
    bridge.nextFlushAt=0;await bridge.flush();assert.equal(store.pendingNotifications().length,0);
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='durable-outage'").get().status,'sent');
    store.enqueue('WS尚未重连','waiting-ws');bridge.live=true;bridge.connected=false;await bridge.flush();
    assert.equal(store.pendingNotifications()[0].attempts,0);
  }finally{await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true});}
});

test('QQ reconnect does not create duplicate outbox messages for the same message id', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'qq-dedupe-'));const store=new Store(join(runtime,'control.sqlite'));
  const bridge=new QqBridge({store,onMessage:async()=>{}});const sent=[];
  bridge.send=async text=>{sent.push(text);return {message_id:9001};};
  try {
    // Repeated enqueue calls can happen when a reconnect replays the notification queue.
    // The stable message id/dedupe key must leave one durable row.
    store.enqueue('只发送一次','qq-msg:20261015:abc');
    store.enqueue('只发送一次','qq-msg:20261015:abc');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE dedupe='qq-msg:20261015:abc'").get().n,1);
    bridge.live=true;bridge.connected=false;await bridge.flush();
    assert.deepEqual(sent,[]);
    bridge.connected=true;bridge.nextFlushAt=0;await bridge.flush();
    assert.deepEqual(sent,['只发送一次']);
    bridge.nextFlushAt=0;await bridge.flush();
    assert.deepEqual(sent,['只发送一次']);
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='qq-msg:20261015:abc'").get().status,'sent');
  } finally { await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true}); }
});

test('sensitive approval rejection gives local guidance without logging an internal failure',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'qq-sensitive-'));const store=new Store(join(runtime,'control.sqlite'));
  const bridge=new QqBridge({store,enabled:true,notificationEnabled:false,getMode:()=>'all',onMessage:async()=>{const error=Error('sensitive');error.code='HUB_SECRET_INPUT_REQUIRED';throw error;}});
  try{
    const record=store.saveIncoming('qq:secret-guidance','模拟审批回复');
    await bridge.deliverIncoming(record);
    assert.equal(store.db.prepare('SELECT status FROM inbox WHERE messageId=?').get(record.messageId).status,'failed');
    assert.equal(store.errors().length,0);
    const notice=store.db.prepare("SELECT text FROM outbox WHERE dedupe=?").get('inbound-secret-input:'+record.messageId);
    assert.match(notice.text,/本机/);assert.doesNotMatch(notice.text,/再发我一次/);
  }finally{await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true});}
});

test('QQ inbound task is retained and retried after temporary execution capacity exhaustion',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'qq-inbound-capacity-'));const store=new Store(join(runtime,'control.sqlite'));
  let calls=0;const bridge=new QqBridge({store,enabled:true,notificationEnabled:false,getMode:()=>'all',onMessage:async()=>{if(calls++===0){const error=Error('execution capacity full');error.code='HUB_CAPACITY';throw error;}}});
  try {
    const event={post_type:'message',message_type:'private',user_id:Number(OWNER),message_id:7001,message:[{type:'text',data:{text:'请执行一个任务'}}]};
    await bridge.handle(event);
    const first=store.db.prepare('SELECT * FROM inbox WHERE messageId=?').get('qq:7001');
    const parked=store.db.prepare('SELECT status,attempts,lastError,nextAttemptAt FROM inbox WHERE messageId=?').get(first.messageId);
    assert.equal(parked.status,'pending');assert.equal(parked.attempts,1);assert.match(parked.lastError,/capacity full/);assert.ok(parked.nextAttemptAt);
    assert.equal(store.pendingIncoming().length,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE dedupe='inbound-capacity:qq:7001'").get().n,1);
    await bridge.handle(event);assert.equal(calls,1,'a replayed QQ event must respect the persisted backoff');
    store.db.prepare('UPDATE inbox SET nextAttemptAt=? WHERE messageId=?').run(new Date(Date.now()-1000).toISOString(),first.messageId);
    const retry=store.pendingIncoming();assert.equal(retry.length,1);
    await bridge.deliverIncoming(retry[0]);
    const done=store.db.prepare('SELECT status,attempts,lastError,nextAttemptAt FROM inbox WHERE messageId=?').get(first.messageId);
    assert.equal(done.status,'done');assert.equal(done.attempts,1);assert.equal(done.lastError,null);assert.equal(done.nextAttemptAt,null);assert.equal(calls,2);
  }finally{await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true});}
});

test('QQ inbound capacity retries eventually become an explicit failed record, never a false success',()=>{
  const runtime=mkdtempSync(join(tmpdir(),'qq-inbound-retry-limit-'));const store=new Store(join(runtime,'control.sqlite'));
  try {
    const record=store.saveIncoming('qq:capacity-limit','排队中的任务');
    store.db.prepare('UPDATE inbox SET attempts=11 WHERE messageId=?').run(record.messageId);
    const exhausted=store.retryIncoming(record.messageId,'capacity full',{maxAttempts:12,delayMs:5000});
    assert.equal(exhausted.status,'failed');assert.equal(exhausted.attempts,12);assert.equal(exhausted.nextAttemptAt,null);
    assert.equal(store.pendingIncoming().length,0);
    assert.equal(store.db.prepare('SELECT status FROM inbox WHERE messageId=?').get(record.messageId).status,'failed');
  }finally{store.close();rmSync(runtime,{recursive:true,force:true});}
});

test('two bridge instances cannot both claim the same notification or attachment',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'qq-atomic-claim-'));const store=new Store(join(runtime,'control.sqlite'));
  const first=new QqBridge({store,onMessage:async()=>{}}),second=new QqBridge({store,onMessage:async()=>{}});
  let messageCalls=0,fileCalls=0;
  first.send=second.send=async()=>{messageCalls++;return {message_id:1};};
  first.sendFile=second.sendFile=async()=>{fileCalls++;return {message_id:2};};
  try{
    store.enqueue('只送一次','parallel-notification');
    const messageSnapshot=store.pendingNotifications();store.pendingNotifications=()=>messageSnapshot;
    await Promise.all([first.flush(),second.flush()]);assert.equal(messageCalls,1);
    store.enqueueAttachment({artifactId:'artifact-1',filePath:'D:/资料/报告.png',image:true,dedupe:'parallel-attachment'});
    const attachmentSnapshot=store.pendingAttachments();store.pendingAttachments=()=>attachmentSnapshot;
    await Promise.all([first.flush(),second.flush()]);assert.equal(fileCalls,1);
    assert.equal(store.db.prepare("SELECT status FROM attachment_outbox WHERE dedupe='parallel-attachment'").get().status,'sent');
  }finally{await Promise.all([first.close(),second.close()]);store.close();rmSync(runtime,{recursive:true,force:true});}
});

test('a crash during sending is held as uncertain instead of being replayed', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'qq-sending-recovery-'));const store=new Store(join(runtime,'control.sqlite'));
  const bridge=new QqBridge({store,onMessage:async()=>{}});let calls=0;
  bridge.send=async text=>{calls++;return {message_id:7000};};
  try {
    store.enqueue('恢复后只补发一次','qq-msg:20261015:crash');
    const row=store.pendingNotifications()[0];store.notification(row.id,'sending');
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='qq-msg:20261015:crash'").get().status,'sending');
    store.recover();
    assert.equal(store.pendingNotifications().length,0);
    bridge.nextFlushAt=0;await bridge.flush();
    assert.equal(calls,0);
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='qq-msg:20261015:crash'").get().status,'uncertain');
  } finally { await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true}); }
});

test('accepted OneBot send followed by a lost response is not automatically duplicated', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'qq-ack-loss-'));const store=new Store(join(runtime,'control.sqlite'));
  const bridge=new QqBridge({store,onMessage:async()=>{}});let accepted=[];let first=true;
  bridge.send=async text=>{
    // OneBot accepts the first call, then the local process loses the response
    // before it can mark the outbox row sent.
    accepted.push(text);
    if(first){first=false;throw Error('socket closed after remote acceptance');}
    return {message_id:7001};
  };
  try {
    store.enqueue('关键通知','accept-then-crash');bridge.nextFlushAt=0;await bridge.flush();
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='accept-then-crash'").get().status,'uncertain');
    bridge.nextFlushAt=0;await bridge.flush();
    assert.deepEqual(accepted,['关键通知']);
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='accept-then-crash'").get().status,'uncertain');
    assert.match(store.errors()[0].message,/结果不确定/);
  } finally { await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true}); }
});

test('QQ can send a local image or file as an attachment message', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'qq-attachment-'));const store=new Store(join(runtime,'control.sqlite'));
  const bridge=new QqBridge({store,onMessage:async()=>{}});let call;
  bridge.call=async(action,params)=>{call={action,params};return {message_id:456};};
  try {
    await bridge.sendFile('D:\\资料\\现场图.png',{image:true});
    assert.equal(call.action,'send_private_msg');
    assert.equal(call.params.message[0].type,'image');
    assert.equal(call.params.message[0].data.file,'D:/资料/现场图.png');
    await assert.rejects(bridge.sendFile('relative.png'),/绝对路径/);
    await assert.rejects(bridge.sendFile('D:/archive/'+ 'a'.repeat(64)),/可读文件名/);
    await assert.rejects(bridge.sendFile('D:/archive/catalog.json'),/可读文件名/);
    await bridge.sendFile('D:/交付/中文报告.md');
    assert.equal(call.params.message[0].data.name,'中文报告.md');
  } finally { await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true}); }
});
