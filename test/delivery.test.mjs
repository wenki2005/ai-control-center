import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationalParts } from '../src/delivery.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { QqBridge } from '../src/qq.mjs';

test('conversationalParts removes markdown styling and separates natural Chinese sentences',()=>{
  assert.deepEqual(conversationalParts('# **你好**，这是第一句。\n这是第二句！'),['你好，这是第一句。','这是第二句！']);
  assert.deepEqual(conversationalParts('`snake_case` 和 **重点**'),['snake_case 和 重点']);
  assert.deepEqual(conversationalParts('```js\nconst a = 1;\n```'),['const a = 1;']);
});

test('conversationalParts preserves URLs, commands, numbered choices and content',()=>{
  assert.deepEqual(conversationalParts('链接 https://example.com/a.b?x=1。后面一句。'),['链接 https://example.com/a.b?x=1。后面一句。']);
  assert.deepEqual(conversationalParts('/中枢 选择 2 蓝色'),['/中枢 选择 2 蓝色']);
  assert.deepEqual(conversationalParts('1. 选蓝色\n2) 选绿色\n共 2 个选项。'),['1. 选蓝色','2) 选绿色','共 2 个选项。']);
});

test('short multi-sentence reports are sent as one readable QQ message',()=>{
  const report='那条验收回来了，原话就是“中枢完整链路验收成功”。从派单到执行再回到这儿，整条链路是通的。没有文件，也不用你再管。';
  assert.deepEqual(conversationalParts(report),[report]);
});

test('long prose is split at clauses without dropping words',()=>{
  const source='甲'.repeat(54)+'，'+'乙'.repeat(54)+'，'+'丙'.repeat(30)+'。';
  const parts=conversationalParts(source,{maxLength:60});
  assert.ok(parts.length>1);
  assert.equal(parts.join(''),source);
  assert.ok(parts.every(part=>part.length<=60));
});

test('ASCII periods inside filenames, paths, versions and email addresses do not split messages',()=>{
  const parts=conversationalParts('请打开 codex-acceptance.md、D:\\reports\\final.v2.txt、版本 1.2.3 和 user@example.invalid。然后继续。');
  assert.deepEqual(parts,['请打开 codex-acceptance.md、D:\\reports\\final.v2.txt、版本 1.2.3 和 user@example.invalid。然后继续。']);
  assert.deepEqual(conversationalParts('第一句. 第二句.'),['第一句. 第二句.']);
});

test('a long URL remains whole when it exceeds the message length limit',()=>{
  const url='https://example.com/'+('segment/'.repeat(24));
  const parts=conversationalParts(url,{maxLength:40});
  assert.deepEqual(parts,[url]);
  assert.equal(parts[0],url);
  assert.deepEqual(conversationalParts(`${url} 后续说明。`,{maxLength:40}),[url,'后续说明。']);
});

test('QQ outbox sends in order with an injectable interval and stops on a send failure',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'qq-delivery-'));
  const store=new Store(join(runtime,'control.sqlite'));
  const sent=[];const delays=[];
  const bridge=new QqBridge({store,onMessage:async()=>{},intervalMs:17,delay:async ms=>{delays.push(ms);}});
  bridge.send=async text=>{sent.push(text);if(text==='second'){const error=Error('QQ HTTP 429');error.httpStatus=429;error.uncertain=false;throw error;}return {message_id:sent.length};};
  store.enqueue('first','delivery-1');store.enqueue('second','delivery-2');store.enqueue('third','delivery-3');
  try {
    await bridge.flush();
    assert.deepEqual(sent,['first','second']);
    assert.deepEqual(delays,[17]);
    assert.deepEqual(store.pendingNotifications().map(row=>row.text),['second','third']);
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='delivery-1'").get().status,'sent');
    assert.equal(store.db.prepare("SELECT status FROM outbox WHERE dedupe='delivery-2'").get().status,'pending');
  } finally { await bridge.close();store.close();rmSync(runtime,{recursive:true,force:true}); }
});

test('QQ close interrupts an active inter-message delay',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'qq-close-'));
  const store=new Store(join(runtime,'control.sqlite'));
  let releaseDelay;
  const bridge=new QqBridge({store,onMessage:async()=>{},intervalMs:900,delay:()=>new Promise(resolve=>{releaseDelay=resolve;})});
  bridge.send=async text=>({message_id:text});
  store.enqueue('one','close-1');store.enqueue('two','close-2');
  try {
    const flushing=bridge.flush();
    while(!releaseDelay)await new Promise(resolve=>setImmediate(resolve));
    await bridge.close();
    await flushing;
    assert.deepEqual(store.pendingNotifications().map(row=>row.text),['two']);
  } finally { releaseDelay?.();store.close();rmSync(runtime,{recursive:true,force:true}); }
});
