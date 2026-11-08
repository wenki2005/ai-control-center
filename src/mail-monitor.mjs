import {personaGreeting} from './persona-address.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {redact} from './redact.mjs';
const execFileAsync=promisify(execFile),ZONE='Asia/Shanghai';
export const shanghaiDay=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const day=shanghaiDay;
const hour=(date=new Date())=>Number(new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,hour:'2-digit',hourCycle:'h23'}).format(date));
const important=mail=>{const text=`${mail.subject||''} ${mail.snippet||''} ${mail.from?.name||''}`;return /(?:重要|紧急|urgent|deadline|截止|到期|面试|offer|录用|合同|账单|缴费|安全|登录|验证码|学校|招聘|应聘|回复|确认|会议|通知)/iu.test(text)||mail.has_attachments===true;};
function parseOutput(stdout){const match=String(stdout).match(/\{\s*"ok"\s*:[\s\S]*\}\s*(?:tip:|$)/);if(!match)throw Error('Agent Mail 返回格式无法解析');return JSON.parse(match[0].replace(/\s*tip:[\s\S]*$/,''));}
export class MailMonitor {
 constructor({store,notify=()=>{},personaForNotification=()=>({}),cli='agently-cli',intervalMs=300000,dailyOnly=false,address=null,provider='agent-mail',credentialsPath='runtime/qq-mail-credentials.json',python='python',now=()=>new Date()}={}){Object.assign(this,{store,notify,personaForNotification,cli,intervalMs,dailyOnly,address,provider,credentialsPath,python,now});this.timer=null;this.busy=false;this.closed=false;this.db=store.db;this.db.exec(`CREATE TABLE IF NOT EXISTS mail_seen(messageId TEXT PRIMARY KEY,createdAt TEXT,important INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS mail_digest(day TEXT PRIMARY KEY,status TEXT,updatedAt TEXT)`);}
 settings(){return {enabled:this.store.meta('mail-monitor:enabled')!=='false',address:this.address||this.store.meta('mail-monitor:address')||'user@example.invalid',zone:ZONE,summaryTime:'19:00',dailyOnly:this.dailyOnly,intervalMinutes:this.dailyOnly?1440:this.intervalMs/60000,lastScan:this.store.meta('mail-monitor:last-scan')||null};}
 async list(dayKey=day(this.now())){
  if(this.provider==='qq-imap'){const {stdout}=await execFileAsync(this.python,['scripts/qq-mail-list.py',this.credentialsPath,dayKey],{windowsHide:true,timeout:30000,maxBuffer:500000,env:{...process.env,PYTHONIOENCODING:'utf-8'}});const data=JSON.parse(String(stdout));if(!data.ok)throw Error('QQ IMAP 返回失败');this.scanComplete=data.data?.complete!==false;return data.data?.data||[];}
  const args=['message','+list','--dir','inbox','--limit','50','--after',dayKey];
  const directScript=process.platform==='win32'&&/\.ps1$/i.test(this.cli)?'D:/DevTools/npm-global/node_modules/@tencent-qqmail/agently-cli/scripts/run.js':null;
  const command=directScript?'D:/DevTools/NodeJS/node-v24.20.0-win-x64/node.exe':this.cli;
  const commandArgs=directScript?[directScript,...args]:args;
  const {stdout}=await execFileAsync(command,commandArgs,{windowsHide:true,timeout:30000,maxBuffer:500000});const data=parseOutput(stdout);const rows=data.data?.data||[];this.scanComplete=rows.length<50;return rows;
 }
 async scan(){if(this.busy||this.closed||this.settings().enabled===false)return;this.busy=true;try{const mails=await this.list();for(const mail of mails){const id=String(mail.message_id||'');if(!id)continue;const isImportant=important(mail);const seen=this.db.prepare('SELECT important FROM mail_seen WHERE messageId=?').get(id);this.db.prepare('INSERT INTO mail_seen(messageId,createdAt,important) VALUES(?,?,?) ON CONFLICT(messageId) DO UPDATE SET important=MAX(important,excluded.important)').run(id,mail.created_at||this.store.now(),isImportant?1:0);if(isImportant&&!seen&&!this.dailyOnly){const subject=redact(String(mail.subject||'无主题')).slice(0,160),from=redact(String(mail.from?.name||mail.from?.email||'未知发件人')).slice(0,100),snippet=redact(String(mail.snippet||'')).replace(/\s+/g,' ').slice(0,260);this.store.enqueue(`${personaGreeting(this.personaForNotification())}有一封我判断值得留意的邮件：${subject}\n发件人：${from}\n${snippet}`,`mail-important:${id}`);}}
      if(hour(this.now())>=19){const key=day(this.now()),done=this.db.prepare('SELECT status FROM mail_digest WHERE day=?').get(key);if(!done){const today=mails.filter(m=>{const t=Date.parse(m.created_at||'');return Number.isFinite(t)&&day(new Date(t))===key;});const rows=today.filter(important).slice(0,10);const body=rows.length?`${personaGreeting(this.personaForNotification())}今天邮箱里有 ${rows.length} 封值得留意的邮件：\n${rows.map(m=>`- ${redact(String(m.subject||'无主题')).slice(0,120)}（${redact(String(m.from?.name||m.from?.email||'未知')).slice(0,60)}）`).join('\n')}`:`${personaGreeting(this.personaForNotification())}我看过今天的邮箱了，暂时没有筛出需要特别提醒你的重要邮件。`;this.store.enqueue((this.scanComplete===false?'本次仅覆盖部分邮件，以下不是完整收件箱汇总。\n':'')+body,`mail-daily-digest:${key}`);this.db.prepare('INSERT INTO mail_digest(day,status,updatedAt) VALUES(?,?,?)').run(key,'queued',this.store.now());}}
      this.store.meta('mail-monitor:last-scan',this.store.now());void this.notify();
    }catch(error){this.store.event(null,'mail-monitor.scan-failed',{error:redact(error.message).slice(0,500)});}finally{this.busy=false;}}
 start(){
  this.closed=false;clearInterval(this.timer);
  const tick=()=>{if(!this.dailyOnly||hour(this.now())>=19&&!this.db.prepare('SELECT 1 FROM mail_digest WHERE day=?').get(day(this.now())))void this.scan();};
  tick();this.timer=setInterval(tick,this.dailyOnly?60000:this.intervalMs);this.timer.unref?.();
 }
 async close(){this.closed=true;clearInterval(this.timer);while(this.busy)await new Promise(r=>setTimeout(r,50));}
}
