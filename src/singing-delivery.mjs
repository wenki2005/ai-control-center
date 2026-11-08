import {realpathSync,statSync} from 'node:fs';
import {relative,isAbsolute,extname,sep} from 'node:path';

export function singingFile(singing,id) {
  const job=singing.get(id);if(job?.status!=='completed')throw Error('翻唱还未完成');
  const root=realpathSync(singing.runtimeRoot),file=realpathSync(job.resultPath),rel=relative(root,file);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||extname(file).toLowerCase()!=='.wav'||statSync(file).size<44)throw Error('翻唱文件未通过校验');
  return file;
}

export function preparedSingingAudio(singing,row) {
  if(!singing||!String(row.dedupe||'').startsWith('singing-audio:'))return null;
  return singingFile(singing,String(row.dedupe).slice('singing-audio:'.length));
}

export function sendSinging({singing,store,id}) {
  const job=singing.get(id);singingFile(singing,id);
  const dedupe='singing-audio:'+id;
  store.enqueue(`「${job.title}」的${job.mode==='original'?'原创演唱':'翻唱音频'}已生成，可在中枢查看。`,dedupe);
  const delivery=store.db.prepare('SELECT status FROM outbox WHERE dedupe=?').get(dedupe)?.status||'pending';
  return {status:job.status,delivery,sent:delivery==='sent'};
}
