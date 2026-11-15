import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough,Writable} from 'node:stream';
import {createCodexAdapter} from '../src/adapters/codex.mjs';

for(const auto of [false,true,'writer','external'])test('repair runner preserves queued identity and handles native auto-start: '+auto,async()=>{
 const requests=[],events=[],retired='b'.repeat(24),prompt='[中控内部修复 '+ 'a'.repeat(24)+'] [修复轮次 1] 修复';
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;child.emit('exit',0);};
 child.stdin=new Writable({write(chunk,enc,done){for(const line of String(chunk).trim().split('\n')){const r=JSON.parse(line);if(r.id===undefined)continue;requests.push(r);if((auto==='writer'||auto==='external')&&r.method==='thread/resume'){setImmediate(()=>child.stdout.write(JSON.stringify({id:r.id,error:{code:-32000,message:'thread already has an active writer'}})+'\n'));continue;}let result={};if(r.method==='thread/queue/list')result={data:[{id:'old-recovered',input:[{type:'text',text:`[中控内部修复 ${retired}] 旧错误`}],clientUserMessageId:'old'},{id:'original-item',input:[{type:'text',text:prompt}],clientUserMessageId:'old-cli-id'},{id:'personal',input:[{type:'text',text:'个人消息'}]}],nextCursor:null};if(r.method==='thread/queue/start'){result={turn:{id:'real-turn'}};if(auto){setImmediate(()=>child.stdout.write(JSON.stringify({id:r.id,error:{code:-32000,message:auto==='external'?'resume the thread before starting a queued message':'thread already has an active or pending turn'}})+'\n'));setTimeout(()=>{for(const message of [{method:'item/started',params:{threadId:'original-thread',turnId:'real-turn',item:{type:'userMessage',clientId:'old-cli-id',content:[{type:'text',text:prompt}]}}},{method:'turn/completed',params:{threadId:'original-thread',turn:{id:'real-turn',status:'completed',items:[{type:'agentMessage',text:'已完成'}]}}}])child.stdout.write(JSON.stringify(message)+'\n');},20);continue;}}setImmediate(()=>child.stdout.write(JSON.stringify({id:r.id,result})+'\n'));}done();}});
 const adapter=createCodexAdapter({command:'fake',spawn:()=>child});
 try{await adapter.start({id:'repair',role:'maintenance',cwd:'D:/test',sessionId:'original-thread',prompt,preserveNativeSession:true,nativeQueue:{clientUserMessageId:'stable',retiredRepairIds:[retired]}},e=>events.push(e));assert.equal(requests.filter(r=>r.method==='thread/queue/add').length,0);assert.equal(requests.filter(r=>r.method==='turn/start').length,0);assert.equal(requests.find(r=>r.method==='thread/queue/start').params.queuedSubmissionId,'original-item');assert.deepEqual(requests.filter(r=>r.method==='thread/queue/delete').map(r=>r.params.queuedSubmissionId),['old-recovered']);const resumed=requests.find(r=>r.method==='thread/resume');assert.equal(resumed.params.threadId,'original-thread');assert.equal(resumed.params.model,undefined);assert.equal(resumed.params.sandbox,undefined);if(auto){await new Promise(r=>setTimeout(r,45));assert.equal(events.filter(e=>e.type==='completed').length,1);assert.equal(events.filter(e=>e.type==='failed').length,0);}}finally{await adapter.close();}
});

test('background direct Codex approval answers use the native turn scope',async()=>{
  const requests=[],events=[];
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{child.killed=true;child.emit('exit',0);};
  const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');
  child.stdin=new Writable({write(chunk,_enc,done){
    const request=JSON.parse(String(chunk));requests.push(request);
    if(request.id!==undefined&&request.method)setImmediate(()=>{
      let result={};
      if(request.method==='thread/queue/list')result={data:[]};
      if(request.method==='thread/queue/add')result={queuedSubmission:{id:'native-item'}};
      if(request.method==='thread/queue/start'){
        emit({id:'approval-before-start',method:'item/permissions/requestApproval',params:{threadId:'thread',turnId:'turn',reason:'Query official docs',permissions:{network:{enabled:true}}}});
        result={turn:{id:'turn'}};
      }
      emit({id:request.id,result});
    });
    done();
  }});
  const adapter=createCodexAdapter({command:'fake',spawn:()=>child});
  const task={id:'direct',role:'codex-direct',cwd:'D:/test',sessionId:'thread',prompt:'原话',preserveNativeSession:true,nativeQueue:{clientUserMessageId:'direct'}};
  try{
    await adapter.start(task,event=>events.push(event));
    assert.equal(requests.find(x=>x.method==='thread/queue/start').params.queuedSubmissionId,'native-item');
    const approval=events.find(e=>e.type==='approval');assert.ok(approval);
    await adapter.respond(task,approval,'批准');
    assert.deepEqual(requests.find(x=>x.id==='approval-before-start').result,{permissions:{network:{enabled:true}},scope:'turn'});
    assert.ok(!requests.some(x=>x.method==='turn/start'));
  }finally{await adapter.close();}
});

test('direct recovery follows its exact accepted turn without acquiring a writer or replaying input',async()=>{
  const requests=[],events=[];
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{child.killed=true;child.emit('exit',0);};
  const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');
  const tracked={id:'accepted-turn',status:'inProgress',completedAt:null,items:[{type:'userMessage',clientId:'direct',content:[{type:'text',text:'原话'}]}]};
  const other={id:'personal-turn',status:'completed',completedAt:1,items:[{type:'userMessage',clientId:'other',content:[{type:'text',text:'原话'}]}]};
  child.stdin=new Writable({write(chunk,_enc,done){
    const request=JSON.parse(String(chunk));requests.push(request);
    if(request.id!==undefined)setImmediate(()=>{
      const result=request.method==='thread/turns/list'?{data:[other,tracked]}:{data:[]};
      emit({id:request.id,result});
    });
    done();
  }});
  const adapter=createCodexAdapter({command:'fake',spawn:()=>child});
  const task={id:'direct',role:'codex-direct',cwd:'D:/test',sessionId:'thread',prompt:'',nativeQueue:{clientUserMessageId:'direct',existingOnly:true}};
  try{
    const result=await adapter.start(task,event=>events.push(event));
    assert.equal(result.turnId,tracked.id);
    emit({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:tracked.id,delta:'只收到开头'}});
    emit({method:'turn/completed',params:{threadId:'thread',turn:other}});
    const completed={method:'turn/completed',params:{threadId:'thread',turn:{...tracked,status:'completed',completedAt:2,items:[{type:'agentMessage',text:'已收到完整结果'}]}}};
    emit(completed);emit(completed);
    assert.deepEqual(events.filter(e=>e.type==='completed'),[{type:'completed',text:'已收到完整结果',nativeTurnId:tracked.id}]);
    assert.ok(!requests.some(r=>['thread/resume','thread/queue/add','thread/queue/start','turn/start'].includes(r.method)));
  }finally{await adapter.close();}
});

test('exact direct recovery reads persisted final output without turning a second prompt into work',async()=>{
  const requests=[],events=[];
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{child.killed=true;child.emit('exit',0);};
  child.stdin=new Writable({write(chunk,_enc,done){
    const request=JSON.parse(String(chunk));requests.push(request);
    if(request.id!==undefined)setImmediate(()=>{
      let result={};
      if(request.method==='thread/turns/list')result=request.params.cursor==='page-2'
        ?{data:[{id:'original',status:'completed',completedAt:123,items:[]}]}
        :{data:[{id:'other',status:'completed',completedAt:123,items:[]}],nextCursor:'page-2'};
      if(request.method==='thread/items/list')result={data:[{turnId:'original',item:{type:'agentMessage',phase:'final_answer',text:'原回合真实结果'}}]};
      child.stdout.write(JSON.stringify({id:request.id,result})+'\n');
    });
    done();
  }});
  const adapter=createCodexAdapter({command:'fake',spawn:()=>child});
  try{
    await adapter.start({id:'direct',role:'codex-direct',cwd:'D:/test',sessionId:'thread',prompt:'',
      nativeQueue:{clientUserMessageId:'direct',existingOnly:true,followTurnId:'original',followDeadlineAt:Date.now()+10000}},e=>events.push(e));
    assert.deepEqual(events.filter(e=>e.type==='completed'),[{type:'completed',nativeTurnId:'original',text:'原回合真实结果'}]);
    assert.deepEqual(requests.map(r=>r.method),['initialize','initialized','thread/turns/list','thread/turns/list','thread/items/list']);
    assert.equal(requests.at(-1).params.turnId,'original');
  }finally{await adapter.close();}
});

test('losing the direct output stream retains the original turn identity exactly once',async()=>{
  const events=[];
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{child.killed=true;child.emit('exit',0);};
  child.stdin=new Writable({write(chunk,_enc,done){
    const request=JSON.parse(String(chunk));
    if(request.id!==undefined)setImmediate(()=>{
      const result=request.method==='thread/queue/add'?{queuedSubmission:{id:'queued'}}
        :request.method==='thread/queue/start'?{turn:{id:'active-turn'}}:{data:[]};
      child.stdout.write(JSON.stringify({id:request.id,result})+'\n');
    });
    done();
  }});
  const adapter=createCodexAdapter({command:'fake',spawn:()=>child});
  try{
    await adapter.start({id:'direct',role:'codex-direct',cwd:'D:/test',sessionId:'thread',prompt:'原话',nativeQueue:{clientUserMessageId:'direct'}},e=>events.push(e));
    child.stdout.end();
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events.filter(e=>e.type==='failed'),[{type:'failed',kind:'codex-direct-transport-lost',
      originalTurnId:'active-turn',error:'Codex app-server output stream closed'}]);
  }finally{await adapter.close();}
});
