import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isQqShareableArtifact} from './share-policy.mjs';

const IMAGE=/\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif)$/i;
const within=(root,target)=>{const rel=path.relative(root,target);return rel!=='' && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel)};
const normalized=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);

// Read explicit local deliverable references, never enumerate the user project.
export function taskFileReferences(task) {
  const values=[],text=String(task.result||'');
  for(const match of text.matchAll(/!?\[[^\]\r\n]*\]\((<[^>\r\n]+>|[^)\r\n]+)\)/g))values.push(match[1].replace(/^<|>$/g,''));
  for(const match of text.matchAll(/`([^`\r\n]+)`/g))values.push(match[1]);
  for(const match of text.matchAll(/[A-Za-z]:[\\/][^\r\n<>"|?*]+?\.(?:md|markdown|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|txt)(?=[\s）)。，；;、"'`]|$)/gi))values.push(match[0]);
  const files=new Map();
  for(let value of values) {
    value=value.trim();if(!value || /^(?:https?:|data:|javascript:|generated:)/i.test(value))continue;
    try{if(value.startsWith('file:'))value=fileURLToPath(value);else if(/%[a-f0-9]{2}/i.test(value))value=decodeURIComponent(value);}catch{continue;}
    const file=path.resolve(task.cwd,value),name=path.basename(file);
    if(!within(path.resolve(task.cwd),file) || !isQqShareableArtifact({name,isImage:IMAGE.test(name)}))continue;
    files.set(normalized(file),file);
  }
  return [...files.values()].slice(0,8);
}

async function rejectLinks(target) {
  const root=path.parse(target).root;let current=root;
  for(const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);const info=await lstat(current);
    if(info.isSymbolicLink())throw Error('成果文件路径包含链接，未自动发送');
  }
}

export function ensureDeliverableSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS task_deliverables(taskId TEXT NOT NULL,artifactId TEXT NOT NULL,originalPath TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(taskId,artifactId))');
}

export function isDeclaredDeliverable(task,artifact) {
  if(!artifact?.sourcePath || !task?.cwd)return false;
  return taskFileReferences(task).some(file=>normalized(file)===normalized(artifact.sourcePath));
}

export async function collectTaskDeliverables({task,archive,workspaceRoot,verifiedDelivery=null}) {
  if(verifiedDelivery&&(!/^-?\d+$/.test(String(verifiedDelivery.messageId))||!Number.isFinite(verifiedDelivery.time)||!String(task.prompt).replaceAll('\\','/').includes(verifiedDelivery.path.replaceAll('\\','/'))||path.basename(verifiedDelivery.path)!==verifiedDelivery.name))throw Error('外部文件缺少本轮明确路径与平台回执');
  const references=verifiedDelivery?[path.resolve(verifiedDelivery.path)]:taskFileReferences(task),warnings=[];
  if(!references.length)return [];
  if(!/^t-[\w-]+$/u.test(task.id))throw Error('成果任务编号无效');
  const cwd=await realpath(task.cwd);await rejectLinks(path.resolve(task.cwd));
  const stage=path.resolve(workspaceRoot,'_deliverables',task.id,'run-'+(Number(task.runVersion)||0));
  if(!within(path.resolve(workspaceRoot),stage))throw Error('成果暂存路径无效');
  await mkdir(stage,{recursive:true});await rejectLinks(stage);
  const copied=new Map();let total=0;
  for(const file of references) {
    try {
      await rejectLinks(file);const source=await realpath(file);if(!within(cwd,source)&&!(verifiedDelivery&&normalized(source)===normalized(verifiedDelivery.path)))throw Error('成果文件不在本任务项目中');
      const info=await lstat(source);if(!info.isFile() || info.size>20*1024*1024 || total+info.size>60*1024*1024)throw Error('成果文件不是常规文件或超过自动发送大小');
      if(verifiedDelivery&&(info.mtimeMs>verifiedDelivery.time*1000+1000||!isQqShareableArtifact({name:verifiedDelivery.name,isImage:IMAGE.test(verifiedDelivery.name)})))throw Error('已发送文件的当前版本或名称无法确认');
      const handle=await open(source,constants.O_RDONLY);let buffer;
      try{const before=await handle.stat();if(!before.isFile() || before.ino!==info.ino || before.dev!==info.dev || before.size!==info.size)throw Error('成果文件正在变化');buffer=await handle.readFile();const after=await handle.stat();if(buffer.length!==before.size || after.ino!==before.ino || after.dev!==before.dev || after.size!==before.size || after.mtimeMs!==before.mtimeMs)throw Error('成果文件正在变化');}finally{await handle.close();}
      const name=path.basename(source);if(copied.has(name))continue;
      const target=path.join(stage,name);
      try{await writeFile(target,buffer,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;await rejectLinks(target);if(!(await readFile(target)).equals(buffer))throw Error('已归档成果发生变化，请更新任务后重新交付');}
      const staged=await lstat(target);if(!staged.isFile()||staged.size!==buffer.length||(await readFile(target)).length!==buffer.length)throw Error('成果暂存文件大小校验失败');
      copied.set(name,source);total+=buffer.length;
    }catch(error){warnings.push({path:path.basename(file),reason:error.message});}
  }
  if(!copied.size){const empty=[];Object.defineProperty(empty,'warnings',{value:warnings});return empty;}
  const records=await archive.collect({taskId:task.id,cwd:stage});ensureDeliverableSchema(archive.db);
  const insert=archive.db.prepare('INSERT OR IGNORE INTO task_deliverables(taskId,artifactId,originalPath,createdAt) VALUES(?,?,?,?)');
  for(const record of records)if(!String(record.sourcePath).startsWith('generated://') && copied.has(record.name))insert.run(task.id,record.id,copied.get(record.name),new Date().toISOString());
  const allWarnings=[...warnings,...(records.warnings||[])];
  const result=records.filter(record=>copied.has(record.name) && !String(record.sourcePath).startsWith('generated://'));
  Object.defineProperty(result,'warnings',{value:allWarnings});return result;
}
