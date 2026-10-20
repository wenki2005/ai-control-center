import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const within=(root,target)=>{const relative=path.relative(root,target);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};
const same=(first,second)=>within(first,second)&&within(second,first);
const sameIdentity=(first,second)=>first.dev===second.dev&&first.ino===second.ino;

/** Read one regular file through a stable handle while proving it stays in root. */
export async function readStableFile(file,root,{beforeOpen}={}) {
  const absolute=path.resolve(file),allowed=path.resolve(root);
  const before=await lstat(absolute);
  if(!before.isFile()||before.isSymbolicLink())throw new Error('not a regular file');
  const realBefore=await realpath(absolute);
  if(!same(absolute,realBefore)||!within(allowed,realBefore))throw new Error('file path escaped its allowed directory');
  if(typeof beforeOpen==='function')await beforeOpen();
  const noFollow=Number.isInteger(constants.O_NOFOLLOW)?constants.O_NOFOLLOW:0;
  const handle=await open(absolute,constants.O_RDONLY|noFollow);
  try {
    const opened=await handle.stat();
    if(!opened.isFile()||!sameIdentity(before,opened)||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)throw new Error('file changed before it could be read');
    const buffer=await handle.readFile();
    const after=await handle.stat(),pathAfter=await lstat(absolute),realAfter=await realpath(absolute);
    if(!pathAfter.isFile()||pathAfter.isSymbolicLink()||!sameIdentity(before,after)||!sameIdentity(before,pathAfter)||after.size!==before.size||after.mtimeMs!==before.mtimeMs||buffer.byteLength!==after.size||!same(absolute,realAfter)||!within(allowed,realAfter))throw new Error('file changed while being read');
    return buffer;
  } finally { await handle.close(); }
}
