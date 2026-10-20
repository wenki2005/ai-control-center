import {readFileSync,writeFileSync,existsSync,lstatSync,realpathSync,unlinkSync,appendFileSync,renameSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),runtime=join(root,'runtime'),file=join(runtime,'deployment.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(base,path)=>{const rel=relative(base,path);return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel);};
if(!existsSync(file))process.exit(0);
const deployment=JSON.parse(readFileSync(file,'utf8'));
if(deployment.status!=='pending')process.exit(0);
if(!Array.isArray(deployment.changes)||deployment.changes.length>20||!inside(join(runtime,'repairs'),resolve(deployment.backup)))throw Error('Invalid deployment backup');
if(!inside(realpathSync(join(runtime,'repairs')),realpathSync(deployment.backup)))throw Error('Backup physically escapes repairs');
const restore=[];
for(const change of deployment.changes){
  if(!/^(src|public)\/[\w\u4e00-\u9fff./-]+$/.test(change.name)||change.name.split('/').includes('..'))throw Error('Invalid rollback path');
  const target=resolve(root,change.name),saved=resolve(deployment.backup,change.name);
  if(!inside(root,target)||!inside(resolve(deployment.backup),saved))throw Error('Invalid target');
  for(let parent=target;parent!==root;parent=dirname(parent)){if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw Error('Rollback target is linked');}
  const current=existsSync(target)?hash(readFileSync(target)):null;
  if(current===change.hash)restore.push(change);else if(current!==change.oldHash)throw Error('A deployed file changed; refusing to overwrite it');
  if(change.oldHash!==null && (!existsSync(saved)||!inside(realpathSync(deployment.backup),realpathSync(saved))||hash(readFileSync(saved))!==change.oldHash))throw Error('Rollback backup integrity failed');
}
for(const change of restore){const target=resolve(root,change.name);if(change.oldHash===null)unlinkSync(target);else{const temp=target+'.rollback-'+randomUUID()+'.tmp';try{writeFileSync(temp,readFileSync(resolve(deployment.backup,change.name)));renameSync(temp,target);}finally{if(existsSync(temp))unlinkSync(temp);}}}
deployment.status='rolled_back';deployment.rolledBackAt=new Date().toISOString();writeFileSync(file,JSON.stringify(deployment,null,2));
try{execFileSync('git',['add','--',...deployment.changes.map(change=>change.name)],{cwd:root,windowsHide:true,stdio:'ignore'});execFileSync('git',['commit','-m','回滚未通过启动检查的维护部署 '+deployment.jobId],{cwd:root,windowsHide:true,stdio:'ignore'});}catch{/* source recovery does not depend on Git availability */}
appendFileSync(join(runtime,'guardian-events.jsonl'),JSON.stringify({id:randomUUID(),createdAt:new Date().toISOString(),severity:'warning',service:'maintenance',code:'deployment_rolled_back',message:'维护修复未通过启动检查，已校验备份并自动回滚。',details:{jobId:deployment.jobId}})+'\n');
console.log('Unhealthy maintenance deployment rolled back.');
