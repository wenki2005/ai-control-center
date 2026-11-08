import { open, stat,writeFile,mkdir } from 'node:fs/promises';
import { extname,dirname,join } from 'node:path';
import {extractDocumentText,renderPdfPages} from './knowledge/document-reader.mjs';
import {createHash} from 'node:crypto';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv']);
const PER_FILE = 2500;
const TOTAL = 6000;
const READ_LIMIT = 128 * 1024;
const documents=new Map();
async function readDocument(path,info){
  const key=path+':'+info.size+':'+info.mtimeMs;
  if(documents.has(key))return documents.get(key);
  const work=(async()=>{
    if(info.size>32*1024*1024)throw Error('文档超过32MB读取上限');
    let text='';try{text=await extractDocumentText(path,{timeoutMs:20000});}catch(error){if(extname(path).toLowerCase()!=='.pdf')throw error;}
    const root=join(dirname(path),'.document-reading',createHash('sha256').update(key).digest('hex').slice(0,16));await mkdir(root,{recursive:true});
    if(text.trim()){const textPath=join(root,'正文.txt');await writeFile(textPath,text,'utf8');return {text,textPath};}
    if(extname(path).toLowerCase()==='.pdf')return {text:'',images:await renderPdfPages(path,{outputDirectory:root})};
    return {text:''};
  })();documents.set(key,work);if(documents.size>32)documents.delete(documents.keys().next().value);
  try{return await work;}catch(e){documents.delete(key);throw e;}
}

function decode(bytes) {
  let utf = new TextDecoder('utf-8', { fatal: true });
  try { return utf.decode(bytes); } catch {}
  try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { return null; }
}

export async function prepareQqFileContext(files = []) {
  const rows = [];
  const imagePaths=[];
  let remaining = TOTAL;
  for (const file of Array.isArray(files) ? files : []) {
    const path = String(file?.path || '');
    const name = String(file?.originalName || file?.name || path.split(/[\\/]/).pop() || '附件');
    let line = `附件：${name}`;
    if (!path) { rows.push(`${line}（没有本地保存路径）`); continue; }
    line += `\n路径：${path}`;
    try {
      const info = await stat(path);
      if (!info.isFile()) { rows.push(`${line}\n（不是普通文件，未读取）`); continue; }
      line += `\n大小：${info.size} 字节`;
      const extension=extname(name).toLowerCase();
      if(['.pdf','.docx','.xlsx','.pptx'].includes(extension)){
        try{const doc=await readDocument(path,info);
          if(doc.text){const clipped=doc.text.slice(0,Math.min(PER_FILE,remaining));remaining-=clipped.length;rows.push(`${line}\n完整可读正文：${doc.textPath}\n正文${clipped.length<doc.text.length?'（已截断，可继续读取完整正文文件）':''}：\n${clipped||'（本轮正文预算已用完）'}`);}
          else if(doc.images?.length){const available=doc.images.slice(0,4-imagePaths.length);imagePaths.push(...available.map(p=>p.path));rows.push(`${line}\n未检测到文字层，已转为前${available.length}页实际图片供视觉读取；超过这些页的内容尚未查看。`);}
          else rows.push(`${line}\n未提取到正文，请核对原文件。`);
        }catch(error){rows.push(`${line}\n文档读取失败：${String(error.message).slice(0,200)}；未读到内容，不能假称已读。`);}
        continue;
      }
      if (file?.isImage===true || String(file?.mimeType||'').startsWith('image/') || !TEXT_EXTENSIONS.has(extname(name).toLowerCase())) { rows.push(`${line}\n（此格式未提取正文）`); continue; }
      const handle = await open(path, 'r');
      let bytes;
      try { bytes = Buffer.alloc(Math.min(info.size, READ_LIMIT)); await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
      const text = decode(bytes);
      if (text === null) { rows.push(`${line}\n（不是可识别的 UTF-8/GB18030 文本，未提取）`); continue; }
      if(remaining<=0){rows.push(`${line}\n（本轮正文预算已用完，请按路径继续读取）`);continue;}
      const clipped = text.slice(0, Math.min(PER_FILE, remaining));
      remaining -= clipped.length;
      const truncated = info.size > READ_LIMIT || text.length > clipped.length;
      rows.push(`${line}\n正文${truncated ? '（已截断）' : ''}：\n${clipped || '（空文件）'}`);
    } catch { rows.push(`${line}\n（文件不存在或无法读取）`); }
  }
  return { text: rows.join('\n\n'), attachments: rows.length,imagePaths };
}
