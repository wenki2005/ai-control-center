import {createHash} from 'node:crypto';
import {readdir,readFile,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';

export function repairReceipt(text){
 const start=String(text||'').lastIndexOf('[REPAIR-RESULT]');if(start<0)return null;
 try{return JSON.parse(String(text).slice(start+15).trim());}catch{return null;}
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function repairBaseline(root){
 const files={};
 async function walk(directory){let entries;try{entries=await readdir(resolve(root,directory),{withFileTypes:true});}catch{return;}
  for(const entry of entries){if(entry.isSymbolicLink())continue;const path=directory+'/'+entry.name;
   if(entry.isDirectory())await walk(path);
   else if(entry.isFile()&&/\.(?:mjs|js|cjs|json|py|ps1|html|css)$/u.test(entry.name))files[path]=digest(await readFile(resolve(root,path)));
  }
 }
 for(const directory of ['src','plugins','public','scripts','test','runtime/repair-execution-test'])await walk(directory);
 for(const file of ['package.json','package-lock.json'])try{files[file]=digest(await readFile(resolve(root,file)));}catch(error){if(error.code!=='ENOENT')throw error;}
 return {files,capturedAt:new Date().toISOString()};
}
export async function requireRepairEvidence(result,root){
 const receipt=repairReceipt(result.detail);if(!receipt||!['fixed','recovered'].includes(receipt.status))throw Error('缺少可验收的修复回执');
 const candidate=['fixed','recovered'].includes(receipt.status)&&receipt.verification?.kind==='targeted'&&receipt.verification?.awaitingIndependent===true;
 if(!Array.isArray(receipt.checks)||!receipt.checks.length||!Array.isArray(receipt.actions)||!receipt.actions.length||receipt.verification?.passed!==true||(!candidate&&receipt.verification?.kind!=='live'))throw Error('只有诊断或模拟检查；需要实际动作和本轮 live 验证或针对性通过的代码候选');
 if(receipt.actions.some(a=>!['edit','recovery','reload','verification'].includes(a?.kind)||typeof a.target!=='string'||!a.target.trim()||typeof a.evidence!=='string'||!a.evidence.trim()))throw Error('修复动作必须指明实际目标和执行证据');
 if(!candidate&&/(?:尚未|未进行|未发送|无法).{0,20}(?:真实|实测|整轮|完整|运行进程|重载)/u.test(receipt.checks.join('\n')))throw Error('回执明确承认关键验证尚未完成，不能判为已恢复');
 if(receipt.status==='fixed'){
  if(!Array.isArray(receipt.changes)||!receipt.changes.length)throw Error('声称 fixed 但没有实际修改文件');
  let baseline;try{baseline=JSON.parse(result.baseline||'{}');}catch{}
  if(!baseline?.files)throw Error('缺少派修前文件基线，无法核对实际修改');
  for(const claimed of receipt.changes){
   const path=resolve(root,claimed),rel=relative(root,path).split(sep).join('/');
   if(isAbsolute(rel)||rel.startsWith('../')||! /^(?:src|plugins|public|scripts|test|runtime\/repair-execution-test)\//u.test(rel))throw Error('修复文件不在授权代码范围内');
   let after=null;try{if(!(await stat(path)).isFile())throw Error('修复目标不是文件');after=digest(await readFile(path));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(after===(baseline.files[rel]||null))throw Error(`没有核实到文件的实际变化：${rel}`);
  }
 }
 return receipt;
}
