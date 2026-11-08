import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export function wakeScreenDesktop(root,{launch=spawn,exists=existsSync}={}){
 let version='0.1.0';try{const value=JSON.parse(readFileSync(join(root,'desktop/package.json'),'utf8')).version;if(/^\d+\.\d+\.\d+$/.test(value))version=value;}catch{}
 const file=[join(root,`desktop/dist/AI-Control-Center-${version}.exe`),join(root,'desktop/dist/AI-Control-Center-0.1.0.exe'),join(root,'desktop/dist/Mornye-Control-Center-0.1.0.exe'),join(root,'desktop/dist-picker/win-unpacked/助手 AI 中控.exe')].find(exists);
 if(!file)throw Error('未找到桌面端，请在电脑中打开中枢后点击“选择窗口”');
 return new Promise((resolve,reject)=>{
  const child=launch(file,[],{cwd:root,windowsHide:true,detached:true,stdio:'ignore'});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
 });
}

/** A selector request is not a capture grant. Only the user's source click starts capture. */
export class ScreenPicker {
 constructor({store,isSharing=()=>false,wake=async()=>{},onChange=()=>{}}){
  Object.assign(this,{store,isSharing,wake,onChange});
  store.db.exec('CREATE TABLE IF NOT EXISTS screen_picker_requests(id TEXT PRIMARY KEY,status TEXT NOT NULL,clientId TEXT,error TEXT,createdAt TEXT NOT NULL,expiresAt TEXT NOT NULL,updatedAt TEXT NOT NULL)');
 }
 pending(){
  this.store.db.prepare("UPDATE screen_picker_requests SET status='expired',updatedAt=? WHERE status IN ('pending','presenting') AND expiresAt<=?").run(this.store.now(),this.store.now());
  return this.store.db.prepare("SELECT id,status,createdAt,expiresAt,error FROM screen_picker_requests WHERE status IN ('pending','presenting') ORDER BY createdAt DESC LIMIT 1").get()||null;
 }
 async request({requestId}={}){
  if(this.isSharing())return{status:'already_sharing'};
  const previous=this.pending();if(previous)return previous;
  const id=String(requestId||randomUUID());if(id.length>150)throw Error('选择请求无效');
  const now=this.store.now(),expires=new Date(Date.parse(now)+5*60000).toISOString();
  this.store.db.prepare("INSERT OR IGNORE INTO screen_picker_requests VALUES(?,'pending',NULL,NULL,?,?,?)").run(id,now,expires,now);
  const row=this.store.db.prepare('SELECT * FROM screen_picker_requests WHERE id=?').get(id);
  if(row.status!=='pending')return{id:row.id,status:row.status};
  this.store.event(null,'screen.picker-requested',{requestId:id});this.onChange();
  try{await this.wake();}catch(error){this.store.db.prepare('UPDATE screen_picker_requests SET error=? WHERE id=?').run(String(error.message).slice(0,250),id);}
  return this.pending()||{id,status:'expired'};
 }
 claim({id,clientId}={}){
  if(typeof clientId!=='string'||!/^[\w-]{8,100}$/u.test(clientId))throw Error('共享客户端标识无效');
  this.pending();
  if(this.isSharing())throw Error('已有画面正在共享，请回到原共享窗口');
  const row=this.store.db.prepare("UPDATE screen_picker_requests SET status='presenting',clientId=?,updatedAt=? WHERE id=? AND status='pending' RETURNING id,status").get(clientId,this.store.now(),id);
  return row||null;
 }
 resolve({id,clientId,status}={}){
  if(!['shared','cancelled','failed'].includes(status))throw Error('选择状态无效');
  const result=this.store.db.prepare("UPDATE screen_picker_requests SET status=?,updatedAt=? WHERE id=? AND clientId=? AND status='presenting'").run(status,this.store.now(),id,clientId);
  if(!result.changes)throw Error('选择请求已结束或不属于当前客户端');
  this.store.event(null,'screen.picker-'+status,{requestId:id});this.onChange();return{status};
 }
}
