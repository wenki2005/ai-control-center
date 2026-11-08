import{realpath,lstat}from'node:fs/promises';import{isAbsolute,relative,resolve,sep}from'node:path';
const within=(root,file)=>{const rel=relative(root,file);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
// Metadata verification only. It proves a current scoped file exists, not
// exclusive causation by the desktop action or a platform delivery receipt.
export function createScopedFilePostcondition({allowedRoots}){
 return async(file,{action}={})=>{
  if(typeof file!=='string'||!isAbsolute(file))return false;
  try{
   const absolute=resolve(file),actual=await realpath(absolute),entry=await lstat(absolute);
   if(entry.isSymbolicLink()||!entry.isFile())return false;
   let allowed=false;for(const root of allowedRoots){try{if(within(await realpath(root),actual)){allowed=true;break;}}catch{}}
   if(!allowed)return false;
   const since=Date.parse(action?.createdAt||'');return Number.isFinite(since)&&entry.mtimeMs>=since-2000;
  }catch{return false;}
 };
}
