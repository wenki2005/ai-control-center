import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{repairBaseline,requireRepairEvidence}from'../src/observability/repair-contract.mjs';
test('repair acceptance requires actual scoped file changes and live action evidence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'repair-proof-'));mkdirSync(join(root,'src'));const file=join(root,'src','value.mjs');writeFileSync(file,'export const value=0;');
 const receipt={status:'fixed',changes:['src/value.mjs'],checks:['node verification passed'],actions:[{kind:'edit',target:'src/value.mjs',evidence:'implemented and executed'}],verification:{kind:'live',passed:true}};
 const result={baseline:JSON.stringify(await repairBaseline(root)),detail:'[REPAIR-RESULT] '+JSON.stringify(receipt)};
 try{
  await assert.rejects(requireRepairEvidence(result,root),/没有核实/);
  writeFileSync(file,'export const value=1;');assert.equal((await requireRepairEvidence(result,root)).status,'fixed');
  await assert.rejects(requireRepairEvidence({...result,detail:'[REPAIR-RESULT] '+JSON.stringify({...receipt,changes:['../personal.txt']})},root),/授权代码范围/);
  await assert.rejects(requireRepairEvidence({...result,detail:'[REPAIR-RESULT] '+JSON.stringify({...receipt,verification:{kind:'mock',passed:true}})},root),/模拟/);
  await assert.rejects(requireRepairEvidence({...result,detail:'[REPAIR-RESULT] '+JSON.stringify({...receipt,status:'recovered',changes:[],checks:['尚未发送真实消息验证']})},root),/尚未完成/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
