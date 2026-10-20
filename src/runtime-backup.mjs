import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const sha256File = file => new Promise((resolve,reject)=>{
  const hash=createHash('sha256');
  const stream=createReadStream(file);
  stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')));
});
const inside = (parent,child) => {const rel=path.relative(parent,child);return rel===''||(!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel));};
const normalizeArchivePath = value => String(value||'').replaceAll('\\','/');
const assertRegular = async file => {const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('备份只接受普通文件');return info;};
async function assertNoSymlinkPath(root,file) {
  const rootPath=path.resolve(root),target=path.resolve(file);
  if(!inside(rootPath,target))throw Error('备份路径越界');
  const rel=path.relative(rootPath,target);let current=rootPath;
  for(const part of rel.split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    const info=await lstat(current);
    if(info.isSymbolicLink())throw Error('备份路径不能经过符号链接');
  }
  const [realRoot,realTarget]=await Promise.all([realpath(rootPath),realpath(target)]);
  if(!inside(realRoot,realTarget))throw Error('备份路径解析后越界');
}
const sqlString = value => `'${String(value).replaceAll("'","''")}'`;
const companionDocumentNames = new Set(['mornye-system.md','mornye-persona.md','mornye-memory.md','mornye-handoff.md','mornye-companion.md']);

async function listBlobs(sourceRoot,destinationRoot) {
  const files=[];
  try{const rootInfo=await lstat(sourceRoot);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw Error('归档目录不能是链接');}
  catch(error){if(error.code!=='ENOENT')throw error;return files;}
  const walk=async(directory,relativeDirectory='')=>{
    let entries;
    try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT'&&relativeDirectory==='')return;throw error;}
    for(const entry of entries) {
      const relativeName=relativeDirectory?path.join(relativeDirectory,entry.name):entry.name;
      const absolute=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw Error('归档中出现符号链接，已停止备份');
      if(entry.isDirectory()){await walk(absolute,relativeName);continue;}
      if(!entry.isFile())throw Error('归档中出现非普通文件，已停止备份');
      const parts=relativeName.split(path.sep);
      if(parts.length!==2||! /^[a-f0-9]{2}$/.test(parts[0])||! /^[a-f0-9]{64}$/.test(parts[1])||parts[1].slice(0,2)!==parts[0])throw Error('归档文件名不符合内容哈希格式');
      await assertNoSymlinkPath(sourceRoot,absolute);
      const info=await assertRegular(absolute),hash=await sha256File(absolute);
      if(hash!==parts[1])throw Error('归档文件哈希与文件名不一致');
      const target=path.join(destinationRoot,relativeName);
      await mkdir(path.dirname(target),{recursive:true});await copyFile(absolute,target);
      files.push({path:path.join('knowledge','files',...parts).replaceAll('\\','/'),size:info.size,sha256:hash});
    }
  };
  await walk(sourceRoot);
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

async function copyCompanionDocuments(sourceRoot,destinationRoot) {
  const files=[];
  if(!sourceRoot)return files;
  sourceRoot=path.resolve(sourceRoot);
  let rootInfo;
  try{rootInfo=await lstat(sourceRoot);}catch(error){if(error.code==='ENOENT')return files;throw error;}
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw Error('人设资料目录必须是普通目录');
  for(const name of companionDocumentNames) {
    const source=path.join(sourceRoot,name);
    let info;
    try{info=await lstat(source);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('人设资料不是常规文件或超过 1 MiB');
    await assertNoSymlinkPath(sourceRoot,source);
    const bytes=await readFile(source);
    const after=await lstat(source);
    if(after.dev!==info.dev||after.ino!==info.ino||after.size!==info.size||after.mtimeMs!==info.mtimeMs||bytes.length!==info.size)throw Error('人设资料在备份期间发生变化');
    const target=path.join(destinationRoot,name);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(await sha256File(target)!==hash)throw Error('人设资料备份哈希校验失败');
    files.push({path:`companion-documents/${name}`,size:bytes.length,sha256:hash});
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

function inspectDatabase(file) {
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1||integrity[0].integrity_check!=='ok')throw Error('SQLite integrity_check 未通过');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('SQLite foreign_key_check 未通过');
    const hasArtifacts=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
    const artifacts=hasArtifacts?db.prepare('SELECT id,hash,size,path FROM artifacts').all():[];
    for(const artifact of artifacts) {
      if(!/^[a-f0-9]{64}$/.test(String(artifact.hash))||Number(artifact.size)<0||normalizeArchivePath(artifact.path)!==`files/${artifact.hash.slice(0,2)}/${artifact.hash}`)throw Error('资料库记录存在无效的归档引用');
    }
    return {artifactCount:artifacts.length};
  } finally {db.close();}
}

export async function createRuntimeBackup({runtimeRoot,backupRoot=path.join(runtimeRoot,'backups'),companionRoot=null,createdAt=new Date()}={}) {
  if(typeof runtimeRoot!=='string'||!path.isAbsolute(runtimeRoot))throw new TypeError('runtimeRoot must be an absolute path');
  runtimeRoot=path.resolve(runtimeRoot);backupRoot=path.resolve(backupRoot);
  if(inside(runtimeRoot,backupRoot)&&backupRoot===runtimeRoot)throw Error('backupRoot cannot be the runtime root');
  const sourceDb=path.join(runtimeRoot,'control.sqlite'),sourceFiles=path.join(runtimeRoot,'knowledge','files');
  await assertRegular(sourceDb);await mkdir(backupRoot,{recursive:true});
  const stamp=createdAt.toISOString().replace(/[:.]/g,'-');
  const target=path.join(backupRoot,`snapshot-${stamp}-${randomUUID().slice(0,8)}`);
  const temporary=await mkdtemp(path.join(backupRoot,'.snapshot-'));
  try {
    const databasePath=path.join(temporary,'control.sqlite');
    const database=new DatabaseSync(sourceDb);
    try{database.exec(`VACUUM INTO ${sqlString(databasePath)}`);}finally{database.close();}
    const databaseInfo=await assertRegular(databasePath);
    const dbCheck=inspectDatabase(databasePath);
    const files=await listBlobs(sourceFiles,path.join(temporary,'knowledge','files'));
    const companionDocuments=await copyCompanionDocuments(companionRoot,path.join(temporary,'companion-documents'));
    const references=new Set(files.map(item=>item.path.replace(/^knowledge\//,'')));
    const checkDb=new DatabaseSync(databasePath,{readOnly:true});
    try {
      for(const artifact of checkDb.prepare('SELECT hash,path FROM artifacts').all()) {
        const expected=`files/${artifact.hash.slice(0,2)}/${artifact.hash}`;
        if(normalizeArchivePath(artifact.path)!==expected||!references.has(expected))throw Error('备份中有资料记录缺少对应的归档文件');
      }
    } finally {checkDb.close();}
    const manifest={version:1,createdAt:createdAt.toISOString(),database:{file:'control.sqlite',size:databaseInfo.size,sha256:await sha256File(databasePath)},archive:{root:'knowledge/files',fileCount:files.length,files},companionDocuments,verification:{...dbCheck,allArchiveHashesChecked:true}};
    const handle=await open(path.join(temporary,'manifest.json'),'wx');
    try{await handle.writeFile(JSON.stringify(manifest,null,2)+'\n','utf8');await handle.sync();}finally{await handle.close();}
    await rename(temporary,target);
    return {path:target,manifest};
  } catch(error) {await rm(temporary,{recursive:true,force:true});throw error;}
}

export async function verifyRuntimeBackup(snapshotPath) {
  if(typeof snapshotPath!=='string'||!path.isAbsolute(snapshotPath))throw new TypeError('snapshotPath must be absolute');
  snapshotPath=path.resolve(snapshotPath);
  const info=await lstat(snapshotPath);if(!info.isDirectory()||info.isSymbolicLink())throw Error('备份路径必须是普通目录');
  const snapshotReal=await realpath(snapshotPath);
  if(!inside(snapshotReal,snapshotPath)||!inside(snapshotPath,snapshotReal))throw Error('备份目录路径不能经过链接');
  const manifestPath=path.join(snapshotPath,'manifest.json'),manifestInfo=await assertRegular(manifestPath);
  if(manifestInfo.size>20*1024*1024)throw Error('备份清单超过大小限制');
  await assertNoSymlinkPath(snapshotPath,manifestPath);
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest?.version!==1||manifest.database?.file!=='control.sqlite'||manifest.archive?.root!=='knowledge/files'||!Array.isArray(manifest.archive.files))throw Error('备份清单版本或结构无效');
  const databasePath=path.join(snapshotPath,'control.sqlite');await assertNoSymlinkPath(snapshotPath,databasePath);const databaseInfo=await assertRegular(databasePath);
  if(databaseInfo.size!==manifest.database.size||await sha256File(databasePath)!==manifest.database.sha256)throw Error('备份数据库哈希校验失败');
  const db=inspectDatabase(databasePath),listed=new Map();
  for(const item of manifest.archive.files) {
    if(typeof item?.path!=='string'||!/^knowledge\/files\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(item.path)||item.path.split('/').at(-1)!==item.sha256||item.path.split('/').at(-2)!==String(item.sha256).slice(0,2))throw Error('备份清单包含无效归档路径');
    if(listed.has(item.path))throw Error('备份清单包含重复归档路径');
    const file=path.join(snapshotPath,...item.path.split('/'));
    if(!inside(snapshotPath,file))throw Error('备份清单路径越界');
    await assertNoSymlinkPath(snapshotPath,file);
    const fileInfo=await assertRegular(file);
    if(fileInfo.size!==item.size||await sha256File(file)!==item.sha256)throw Error('归档文件哈希校验失败');
    listed.set(item.path.slice('knowledge/'.length),item);
  }
  const check=new DatabaseSync(databasePath,{readOnly:true});
  try {for(const row of check.prepare('SELECT hash,path FROM artifacts').all()){const rel=normalizeArchivePath(row.path);if(rel!==`files/${row.hash.slice(0,2)}/${row.hash}`||!listed.has(rel))throw Error('备份数据库引用了缺失的归档文件');}}
  finally {check.close();}
  const companionDocuments=Array.isArray(manifest.companionDocuments)?manifest.companionDocuments:[];
  const companionNames=new Set();
  for(const item of companionDocuments) {
    const name=String(item?.path||'').replace(/^companion-documents\//,'');
    if(!companionDocumentNames.has(name)||item.path!==`companion-documents/${name}`||companionNames.has(name)||!Number.isInteger(item.size)||item.size<0||item.size>1024*1024||!/^[a-f0-9]{64}$/.test(String(item.sha256)))throw Error('备份清单包含无效人设资料路径');
    const file=path.join(snapshotPath,'companion-documents',name);await assertNoSymlinkPath(snapshotPath,file);const fileInfo=await assertRegular(file);
    if(fileInfo.size!==item.size||await sha256File(file)!==item.sha256)throw Error('人设资料备份哈希校验失败');
    companionNames.add(name);
  }
  if(manifest.archive.fileCount!==manifest.archive.files.length||manifest.verification?.artifactCount!==db.artifactCount)throw Error('备份清单计数校验失败');
  return {valid:true,createdAt:manifest.createdAt,artifactCount:db.artifactCount,archiveFileCount:manifest.archive.files.length,companionDocumentCount:companionDocuments.length};
}

export async function restoreRuntimeBackup({snapshotPath,targetRoot}={}) {
  if(typeof targetRoot!=='string'||!path.isAbsolute(targetRoot))throw new TypeError('targetRoot must be an absolute path');
  snapshotPath=path.resolve(snapshotPath);targetRoot=path.resolve(targetRoot);
  await verifyRuntimeBackup(snapshotPath);
  try{await lstat(targetRoot);throw Error('恢复目标必须不存在；拒绝覆盖现有目录');}catch(error){if(error.code!=='ENOENT')throw error;}
  const parent=path.dirname(targetRoot);await mkdir(parent,{recursive:true});
  let createdTarget=false;
  try {
    await mkdir(targetRoot,{recursive:false});
    createdTarget=true;
    await copyFile(path.join(snapshotPath,'control.sqlite'),path.join(targetRoot,'control.sqlite'));
    await mkdir(path.join(targetRoot,'knowledge','files'),{recursive:true});
    for(const item of JSON.parse(await readFile(path.join(snapshotPath,'manifest.json'),'utf8')).archive.files) {
      const source=path.join(snapshotPath,...item.path.split('/'));
      const target=path.join(targetRoot,...item.path.split('/'));
      await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);
    }
    for(const item of JSON.parse(await readFile(path.join(snapshotPath,'manifest.json'),'utf8')).companionDocuments||[]) {
      const name=item.path.slice('companion-documents/'.length);
      await mkdir(path.join(targetRoot,'companion-documents'),{recursive:true});
      await copyFile(path.join(snapshotPath,'companion-documents',name),path.join(targetRoot,'companion-documents',name));
    }
    await copyFile(path.join(snapshotPath,'manifest.json'),path.join(targetRoot,'manifest.json'));
    return {path:targetRoot,...await verifyRuntimeBackup(path.join(targetRoot))};
  } catch(error) {if(createdTarget)await rm(targetRoot,{recursive:true,force:true});throw error;}
}
