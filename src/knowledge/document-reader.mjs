import { access, constants, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, sep } from 'node:path';

const EXTRACTOR = fileURLToPath(new URL('./extract.py', import.meta.url));
const PDF_RENDERER = fileURLToPath(new URL('./render_pdf_pages.py', import.meta.url));
const IMAGE_RENDERER = fileURLToPath(new URL('./normalize_visual_image.py', import.meta.url));
const DEFAULT_PYTHON = 'python';
export const VISUAL_IMAGE_EXTENSIONS = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
export const DOCUMENT_EXTENSIONS = new Set(['.docx', '.pdf', '.xlsx', '.pptx', ...VISUAL_IMAGE_EXTENSIONS]);

export async function extractDocumentText(file, { pythonCommand } = {}) {
  const ext = String(file).toLowerCase().slice(String(file).lastIndexOf('.'));
  if (!DOCUMENT_EXTENSIONS.has(ext)) return '';
  let command = pythonCommand || DEFAULT_PYTHON;
  try { await access(command, constants.X_OK); } catch { command = 'python'; }
  return new Promise((resolve, reject) => {
    const child = spawn(command, [EXTRACTOR], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('document text extraction timed out')); }, 120_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) {
        child.kill();
        finish(new Error('document text extraction output exceeded limit'));
      }
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error('document text extraction failed'));
      try {
        const result = JSON.parse(output);
        if (result.status !== 'ok' || typeof result.text !== 'string') return finish(new Error(result.error || 'document text extraction failed'));
        finish(null, result.text);
      } catch { finish(new Error('document text extraction returned invalid output')); }
    });
    child.stdin.end(JSON.stringify({ path: file }));
  });
}

export async function renderPdfPages(file,{outputDirectory,pages,pythonCommand}={}) {
  if(typeof file!=='string'||!isAbsolute(file))throw new TypeError('PDF path must be absolute');
  if(typeof outputDirectory!=='string'||!isAbsolute(outputDirectory))throw new TypeError('PDF render directory must be absolute');
  if(pages!==undefined&&(!Array.isArray(pages)||pages.length<1||pages.length>4||pages.some(page=>!Number.isInteger(page)||page<1||page>500)))throw new TypeError('PDF page selection must contain 1–4 page numbers');
  await mkdir(outputDirectory,{recursive:true});
  let command=pythonCommand||DEFAULT_PYTHON;
  try{await access(command,constants.X_OK);}catch{command='python';}
  const output=await new Promise((resolveOutput,reject)=>{
    const child=spawn(command,[PDF_RENDERER],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let text='',settled=false;
    const timer=setTimeout(()=>{child.kill();finish(new Error('PDF page rendering exceeded 60 seconds'));},60_000);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolveOutput(value);};
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{text+=chunk;if(text.length>32_000){child.kill();finish(new Error('PDF render manifest exceeded limit'));}});
    child.on('error',error=>finish(error));
    child.on('close',code=>{
      if(code!==0)return finish(new Error('PDF page rendering failed'));
      try{const result=JSON.parse(text);if(result.status!=='ok'||!Array.isArray(result.images))return finish(new Error(result.error||'PDF page rendering failed'));finish(null,result.images);}
      catch{finish(new Error('PDF page renderer returned invalid output'));}
    });
    child.stdin.end(JSON.stringify({path:file,outputDirectory,pages:pages??null}));
  });
  const root=await realpath(outputDirectory),images=[];let total=0;
  if(output.length<1||output.length>4)throw new Error('PDF renderer returned an invalid page count');
  for(const item of output){
    if(!Number.isInteger(item?.page)||item.page<1||item.page>500||typeof item.path!=='string'||!isAbsolute(item.path))throw new Error('PDF renderer returned an invalid image path');
    const imagePath=await realpath(item.path),rel=relative(root,imagePath);
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('Rendered PDF page escaped its temporary directory');
    const info=await stat(imagePath);if(!info.isFile()||info.size<4||info.size>8*1024*1024)throw new Error('Rendered PDF page image exceeded its size limit');
    total+=info.size;if(total>16*1024*1024)throw new Error('Rendered PDF pages exceeded the combined 16 MB limit');
    images.push({page:item.page,path:imagePath});
  }
  return images;
}

const VISUAL_MIME_BY_EXTENSION = new Map([
  ['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp'],['.gif','image/gif'],
  ['.bmp','image/bmp'],['.tif','image/tiff'],['.tiff','image/tiff'],
]);

export async function normalizeVisualImage(file,{outputDirectory,expectedMimeType,pythonCommand}={}) {
  if(typeof file!=='string'||!isAbsolute(file))throw new TypeError('Image path must be absolute');
  if(typeof outputDirectory!=='string'||!isAbsolute(outputDirectory))throw new TypeError('Image render directory must be absolute');
  const expected=expectedMimeType || VISUAL_MIME_BY_EXTENSION.get(file.slice(file.lastIndexOf('.')).toLowerCase());
  if(![...VISUAL_MIME_BY_EXTENSION.values()].includes(expected))throw new Error('Unsupported visual image type');
  const info=await stat(file);if(!info.isFile()||info.size<1||info.size>20*1024*1024)throw new Error('Image exceeds the 20 MB visual input limit');
  await mkdir(outputDirectory,{recursive:true});
  let command=pythonCommand||DEFAULT_PYTHON;
  try{await access(command,constants.X_OK);}catch{command='python';}
  const output=await new Promise((resolveOutput,reject)=>{
    const child=spawn(command,[IMAGE_RENDERER],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let text='',settled=false;
    const timer=setTimeout(()=>{child.kill();finish(new Error('Image normalization exceeded 60 seconds'));},60_000);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolveOutput(value);};
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{text+=chunk;if(text.length>16_000){child.kill();finish(new Error('Image normalization manifest exceeded limit'));}});
    child.on('error',error=>finish(error));
    child.on('close',code=>{
      if(code!==0)return finish(new Error('Image normalization failed'));
      try{const result=JSON.parse(text);if(result.status!=='ok'||typeof result.path!=='string'||!isAbsolute(result.path))return finish(new Error(result.error||'Image normalization failed'));finish(null,result.path);}
      catch{finish(new Error('Image normalizer returned invalid output'));}
    });
    child.stdin.end(JSON.stringify({path:file,outputDirectory,expectedMimeType:expected}));
  });
  const root=await realpath(outputDirectory),imagePath=await realpath(output),rel=relative(root,imagePath);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('Normalized image escaped its temporary directory');
  const normalized=await stat(imagePath);
  if(!normalized.isFile()||normalized.size<4||normalized.size>8*1024*1024)throw new Error('Normalized image exceeds the 8 MB visual limit');
  const bytes=await readFile(imagePath);
  if(bytes[0]!==0xff||bytes[1]!==0xd8||bytes[2]!==0xff)throw new Error('Normalized image has an invalid JPEG signature');
  return imagePath;
}
