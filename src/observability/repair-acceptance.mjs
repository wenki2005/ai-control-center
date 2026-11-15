import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {captureReleaseIdentity} from '../lifecycle/release.mjs';
import {requireRepairEvidence,repairBaseline} from './repair-contract.mjs';
import {createHash} from 'node:crypto';
import {redact} from '../redact.mjs';
import {reloadBlockers} from '../lifecycle/release.mjs';
import {codexWriterRecovery,verifyMaintenanceEvidence} from './repair-review.mjs';
import {codexWriterBusy} from '../error-strategy.mjs';
const exec=promisify(execFile);
const defer=message=>Object.assign(Error(message),{code:'REPAIR_DEFERRED'});

export function repairValidator({store,root,fetchImpl=fetch,connectionProbe=null,runTests=()=>exec(process.execPath,['scripts/run-tests.mjs'],{cwd:root,windowsHide:true,timeout:180000,maxBuffer:8*1024*1024})}){
 return async result=>{
  if(reloadBlockers(store).tasks.length)throw defer('等待现有工作完成后验收');
  const receipt=await requireRepairEvidence(result,root),fingerprint=captureReleaseIdentity(root).sourceFingerprint;
  await verifyMaintenanceEvidence({store,root,result});
  const testDigest=snapshot=>createHash('sha256').update(JSON.stringify(Object.keys(snapshot.files).filter(key=>!key.startsWith('runtime/')).sort().map(key=>[key,snapshot.files[key]]))).digest('hex');
  const snapshot=await repairBaseline(root),testFingerprint=testDigest(snapshot);
  const testKey='internal-repair:tests:validated-source';
  const regressionStarted=performance.now(),cacheHit=store.meta(testKey)===testFingerprint;
  if(store.meta(testKey)!==testFingerprint){
   try{await runTests();}
   catch(error){throw Error('独立回归失败，继续修复这些失败项：\n'+redact(String(error.stdout||'')+'\n'+String(error.stderr||error.message)).slice(-5000));}
   if(testDigest(await repairBaseline(root))!==testFingerprint)throw defer('回归期间源码或测试发生变化，等待当前版本检查；不复用旧验证');
   store.meta(testKey,testFingerprint);
  }
  store.event(result.taskId||null,'internal-repair.regression-checked',{repairId:result.id,cacheHit,elapsedMs:Math.round(performance.now()-regressionStarted),testFingerprint});
  const response=await fetchImpl('http://127.0.0.1:3188/api/state?view=compact',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('线上中枢验证失败');const live=await response.json();
  if(receipt.status==='fixed'&&live.health?.release?.sourceFingerprint!==fingerprint){store.meta('specialists:reload','automatic-repair-validated');throw defer('修改已通过回归，等待安全重载后再确认生效');}
  if(/QQ|SnowLuma/i.test(result.error)&&live.health?.qq!=='online')throw Error('QQ 尚未恢复在线');
  const sourceTask=result.taskId?store.task(result.taskId):null;
  if(codexWriterBusy(result.error)&&sourceTask?.engine==='codex'&&!codexWriterRecovery(store,result)){
    throw Object.assign(Error('原 Codex 会话尚无解除占用后的真实完成记录。'),{code:'REPAIR_NATIVE_WRITER_BLOCKED'});
  }
  if(/DSH|人设|记忆插件/i.test(result.error)||(sourceTask?.engine==='dsh'&&/fetch failed|TIMEOUT|ECONN|连接|超时/i.test(result.error))){
   if(live.health?.dsh!=='online')throw Error('DSH 尚未恢复在线');
   const evidence=live.health?.dshModel;
   const dispatchedAt=JSON.parse(result.baseline||'{}').capturedAt||result.createdAt;
    if(evidence?.status!=='online'||!Number.isFinite(Date.parse(evidence.checkedAt))||Date.parse(evidence.checkedAt)<Date.parse(dispatchedAt)){
      if(!connectionProbe)throw Error('缺少本轮真实 DSH 成功终态；需要安全只读验收，不能以 HTTP 在线或模拟组装代替');
      await connectionProbe.run(result);
    }
  }
  return {receipt,fingerprint};
 };
}
