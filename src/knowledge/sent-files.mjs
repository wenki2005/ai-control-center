import {realpath,stat,open} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename,extname} from 'node:path';
import {QQ_SHAREABLE_EXTENSIONS,hasHumanReadableName} from './share-policy.mjs';
import {extractDocumentText} from './document-reader.mjs';

const mimeFor=ext=>({'.md':'text/markdown; charset=utf-8','.markdown':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8','.tsv':'text/tab-separated-values; charset=utf-8','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.avif':'image/avif','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.doc':'application/msword','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'}[ext]||'application/octet-stream');
const within=(root,file)=>{const rel=relative(root,file);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
const kindSql="CASE WHEN o.artifactId LIKE 'sticker:%' THEN 'sticker' WHEN o.image=1 THEN 'image' ELSE 'document' END";
const baseSql=`WITH latest AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY artifactId ORDER BY updatedAt DESC,rowid DESC) AS position FROM attachment_outbox WHERE status='sent')
 SELECT o.id,o.artifactId,o.filePath,o.image,o.updatedAt AS sentAt,a.name,a.path AS archivePath,a.size,a.task_id AS taskId,t.prompt AS taskPrompt,${kindSql} AS kind
 FROM latest o LEFT JOIN artifacts a ON a.id=o.artifactId LEFT JOIN tasks t ON t.id=a.task_id WHERE o.position=1`;

/** Existing, confirmed deliveries are the catalog. No history replay or second copy. */
export class SentFiles {
 constructor({store,archive,allowedRoots=[],pythonCommand}){Object.assign(this,{store,archive,allowedRoots:allowedRoots.filter(p=>typeof p==='string'&&p).map(p=>resolve(p)),pythonCommand});}
 title(row){
  const original=basename(String(row.name||row.filePath).replaceAll('\\','/')),extension=extname(original).toLowerCase();
  if(hasHumanReadableName({name:original}))return original;
  const topic=String(row.taskPrompt||'').split('\n')[0].replace(/\[.*?\]/g,'').trim().slice(0,35);
  return (topic|| (row.kind==='image'?'会话图片':row.kind==='sticker'?'表情图片':'会话文档'))+extension;
 }
 async target(row,{verify=false}={}){
  if(row.archivePath){try{const file=verify?await this.archive.resolveFile(row.artifactId):await this.allowedPath(resolve(this.archive.root,row.archivePath));if(file)return file;}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}}
  return this.allowedPath(row.filePath);
 }
 async allowedPath(file){
  const target=await realpath(file),roots=await Promise.all(this.allowedRoots.map(root=>realpath(root).catch(()=>null)));
  if(!roots.some(root=>root&&within(root,target)))throw Error('该文件不在已登记的文件存储目录');
  if(!(await stat(target)).isFile())throw Error('文件不可读取');return target;
 }
 async list({q='',type='all',page=1,pageSize=24}={}){
  const allowed=new Set(['all','document','image','sticker']);if(!allowed.has(type))throw Error('文件类型无效');
  const requestedPage=Number(page),requestedSize=Number(pageSize);
  page=Number.isFinite(requestedPage)?Math.max(1,Math.min(1_000_000,Math.floor(requestedPage))):1;pageSize=Number.isFinite(requestedSize)?Math.max(1,Math.min(48,Math.floor(requestedSize))):24;
  const search=String(q).trim().slice(0,200),where=(type==='all'?" AND o.artifactId NOT LIKE 'sticker:%'":` AND (${kindSql})=?`)+" AND (?='' OR instr(lower(COALESCE(a.name,o.filePath)),lower(?))>0 OR instr(lower(COALESCE(t.prompt,'')),lower(?))>0)";
  const args=[...(type==='all'?[]:[type]),search,search,search];
  const total=this.store.db.prepare('SELECT count(*) AS total FROM ('+baseSql+where+')').get(...args).total;
  const rows=this.store.db.prepare(baseSql+where+' ORDER BY o.updatedAt DESC,o.id LIMIT ? OFFSET ?').all(...args,pageSize,(page-1)*pageSize);
  const files=await Promise.all(rows.map(async row=>{
   let available=true,size=row.size||0;try{const file=await this.target(row);size=(await stat(file)).size;}catch{available=false;}
   const extension=extname(String(row.name||row.filePath)).toLowerCase();
   return {id:row.id,name:this.title(row),kind:row.kind,extension:extension.slice(1).toUpperCase(),size,sentAt:row.sentAt,status:'sent',available,
    downloadUrl:`/api/files/${encodeURIComponent(row.id)}/download`,contentUrl:`/api/files/${encodeURIComponent(row.id)}/content`};
  }));
  return {files,total,page,pageSize,hasMore:page*pageSize<total};
 }
 row(id){return this.store.db.prepare(`SELECT o.id,o.artifactId,o.filePath,o.image,o.updatedAt AS sentAt,a.name,a.path AS archivePath,a.size,a.task_id AS taskId,t.prompt AS taskPrompt,${kindSql} AS kind FROM attachment_outbox o LEFT JOIN artifacts a ON a.id=o.artifactId LEFT JOIN tasks t ON t.id=a.task_id WHERE o.status='sent' AND o.id=?`).get(String(id));}
 results({q=''}={}){
  const query=String(q).trim().slice(0,200);
  const rows=this.store.db.prepare(`SELECT a.id,a.name,a.task_id AS taskId,a.size,a.created_at AS createdAt,a.excerpt,a.source_path AS sourcePath
   FROM artifacts a LEFT JOIN tasks t ON t.id=a.task_id
   WHERE (?='' OR instr(lower(a.name),lower(?))>0 OR instr(lower(COALESCE(t.prompt,'')),lower(?))>0)
   ORDER BY a.created_at DESC,a.id`).iterate(query,query,query);
  const artifacts=[];let total=0;
  for(const row of rows){
   if(!QQ_SHAREABLE_EXTENSIONS.has(extname(row.name).toLowerCase())||!hasHumanReadableName(row)||/^(?:qq_[-\d]+-\d+|dsh-session-t-[a-z\d-]+)\./i.test(row.name)||/(?:^|[\\/])_(?:maintenance|librarian)(?:[\\/]|$)/i.test(row.sourcePath))continue;
   total++;
   if(artifacts.length<80){const {sourcePath,...record}=row;artifacts.push({...record,excerpt:String(record.excerpt||'').slice(0,280)});}
  }
  return {artifacts,total};
 }
 async resolve(id){
  const row=this.row(id);if(!row)return null;
  const extension=extname(String(row.name||row.filePath)).toLowerCase();
  if(!QQ_SHAREABLE_EXTENSIONS.has(extension))throw Error('此文件格式请从原任务归档查看');
  const path=await this.target(row,{verify:true});
  return {path,name:this.title(row),extension,mime:mimeFor(extension),size:(await stat(path)).size};
 }
 async preview(id){
  const row=this.row(id),file=await this.resolve(id);if(!file)return null;
  if(row.image||file.extension==='.pdf')return {kind:row.image?'image':'pdf',name:file.name,url:`/api/files/${encodeURIComponent(id)}/content`};
  if(['.txt','.md','.markdown','.csv','.tsv','.rtf'].includes(file.extension)){
   const handle=await open(file.path,'r');try{const buffer=Buffer.alloc(Math.min(file.size,128_000));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);const bytes=buffer.subarray(0,bytesRead);let text=new TextDecoder('utf-8').decode(bytes);if(text.includes('\uFFFD'))text=new TextDecoder('gb18030').decode(bytes);return {kind:'text',name:file.name,text:text.slice(0,30000),truncated:file.size>bytesRead||text.length>30000};}finally{await handle.close();}
  }
  const archived=this.store.db.prepare('SELECT text_content FROM artifacts WHERE id=?').get(row.artifactId)?.text_content;
  if(archived)return {kind:'text',name:file.name,text:archived.slice(0,30000),truncated:archived.length>30000};
  if(file.size<=20*1024*1024&&['.docx','.xlsx','.pptx'].includes(file.extension)){
   const text=await extractDocumentText(file.path,{pythonCommand:this.pythonCommand,timeoutMs:20000});
   if(text)return {kind:'text',name:file.name,text:text.slice(0,30000),truncated:text.length>30000};
  }
  return {kind:'download',name:file.name,message:'这个格式可以下载后用本机软件打开。'};
 }
}
