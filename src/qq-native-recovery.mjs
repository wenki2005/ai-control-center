import{readFileSync,writeFileSync}from'node:fs';
import{isDeepStrictEqual}from'node:util';

// QQ verifies the file bytes, not just the parsed main field. Never serialize
// the backup during restoration, and never overwrite unrelated user changes.
export function restoreOriginalQqPackage({packageFile,backupFile,expectedVersion,originalMain,bootstrapMain,auditFile}){
  const original=readFileSync(backupFile),current=readFileSync(packageFile);
  const before=JSON.parse(original),live=JSON.parse(current);
  if(before.version!==expectedVersion||live.version!==expectedVersion||before.main!==originalMain)throw Error('QQ版本或原始备份不匹配，未覆盖');
  if(![originalMain,bootstrapMain].includes(live.main)||!isDeepStrictEqual({...live,main:originalMain},before))throw Error('QQ配置存在其他改动，未覆盖');
  if(auditFile)writeFileSync(auditFile,current);
  writeFileSync(packageFile,original);
  if(!readFileSync(packageFile).equals(original))throw Error('QQ原文件字节校验失败');
  return{restored:true,bytes:original.length};
}
