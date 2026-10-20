import { createHash } from 'node:crypto';
import { mkdir, copyFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { isQqShareableArtifact } from './knowledge/share-policy.mjs';

export function qqDeliveryName(artifact) {
  const original=basename(String(artifact?.name || '').replace(/\\/g,'/'));
  const extension=extname(original).toLowerCase();
  let stem=original.slice(0,-extension.length).replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/[. ]+$/g,'').trim();
  if(!stem || /^[a-f0-9-]{24,}$/i.test(stem))stem='任务报告';
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem))stem='文件-'+stem;
  return stem.slice(0,100)+extension;
}

// Archive files are addressed by content hash. Give the transport a copy with
// its real display name: OneBot file segments derive the QQ filename from it.
export async function prepareQqArtifact({artifact,source,root}) {
  if(!isQqShareableArtifact(artifact))throw Error('这个格式只保留在本机文件库；QQ 只发送常见文档和图片');
  const name=qqDeliveryName(artifact);
  const key=createHash('sha256').update(String(artifact.id)+'\0'+String(source)+'\0'+name).digest('hex');
  const directory=join(root,key);await mkdir(directory,{recursive:true});
  const filePath=join(directory,name);await copyFile(source,filePath);
  return filePath;
}
