import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID,createHash } from 'node:crypto';
import { fixedWorkerSlotForTask } from './routing/fixed-worker.mjs';
const run=promisify(execFile);
const APPS={bilibili:{name:'B站',packages:['tv.danmaku.bili','com.bilibili.app.in','com.bilibili.app.blue']},heybox:{name:'小黑盒',packages:['com.max.xiaoheihe']}};
const decode=s=>String(s||'').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(match,hex,decimal)=>{const n=parseInt(hex||decimal,hex?16:10);return n<=0x10ffff?String.fromCodePoint(n):match;}).replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;
const compact=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').trim();

export class CompanionSocial {
  constructor({store,hub,onChange=()=>{}}){Object.assign(this,{store,hub,onChange});this.publishing=false;
    this.adb='C:/Users/USER/AppData/Local/Android/Sdk/platform-tools/adb.exe';this.serial='ce0817181c1e4cbb0d7e';
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_social_drafts(id TEXT PRIMARY KEY,platform TEXT NOT NULL,title TEXT NOT NULL,
      url TEXT NOT NULL,content TEXT NOT NULL,sourceTaskId TEXT NOT NULL,status TEXT NOT NULL,workerId TEXT,error TEXT,
      createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);`);
    store.db.prepare("UPDATE companion_social_drafts SET status='uncertain',error='发布过程被重载中断，请核对原评论，不自动重发' WHERE status='submitting'").run();
  }
  async command(args){try{return (await run(this.adb,args,{windowsHide:true,timeout:20000,maxBuffer:3*1024*1024})).stdout;}catch{throw Error('手机未连接或 ADB 操作未完成，请检查 USB 与调试授权');}}
  async shell(command){return this.command(['-s',this.serial,'shell',command]);}
  async status(){const devices=await this.command(['devices']);const connected=devices.split(/\r?\n/).some(line=>line.split(/\s+/)[0]===this.serial&&/\sdevice\s*$/.test(line));
    if(!connected)return {connected:false,apps:[],message:'未检测到已授权的 USB 手机'};
    const packages=await this.shell('pm list packages');return {connected:true,apps:Object.entries(APPS).map(([id,app])=>({id,name:app.name,installed:app.packages.some(p=>packages.split(/\r?\n/).some(line=>line.trim()==='package:'+p))}))};}
  async screen(){await this.shell('uiautomator dump /sdcard/_hub_social_ui.xml');const xml=await this.shell('cat /sdcard/_hub_social_ui.xml');const nodes=[];
    for(const match of xml.matchAll(/<node\b[^>]*>/g)){const tag=match[0],attr=k=>decode(new RegExp(`${k}="([^"]*)"`).exec(tag)?.[1]);const bounds=/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
      if(!bounds)continue;nodes.push({text:attr('text'),description:attr('content-desc'),package:attr('package'),class:attr('class'),enabled:attr('enabled')==='true',clickable:attr('clickable')==='true',x:(+bounds[1]+ +bounds[3])/2,y:(+bounds[2]+ +bounds[4])/2});}
    return nodes;
  }
  list(){return this.store.db.prepare('SELECT * FROM companion_social_drafts ORDER BY createdAt DESC LIMIT 30').all().map(row=>this.public(row));}
  public(row){return row?{id:row.id,platform:APPS[row.platform]?.name,title:row.title,url:row.url,content:row.content,status:row.status,error:row.error,createdAt:row.createdAt}:null;}
  row(id){const row=this.store.db.prepare('SELECT * FROM companion_social_drafts WHERE id=?').get(String(id));if(!row)throw Error('评论草稿不存在');return row;}
  caller(sessionId){const task=this.store.db.prepare("SELECT * FROM tasks WHERE sessionId=? AND role='worker' AND engine='dsh' AND status='running' ORDER BY createdAt DESC LIMIT 1").get(String(sessionId));if(!task||!/(?:手机|phone|安卓)/iu.test(task.prompt))throw Error('请在持有手机操作任务的 DSH 固定工作会话调用');return task;}
  async browse({platform,goal,sessionId,requestKey}={}){if(!APPS[platform])throw Error('请选择 B站 或小黑盒');const status=await this.status();if(!status.connected)throw Error(status.message);
    if(!status.apps.find(app=>app.id===platform)?.installed)throw Error(`${APPS[platform].name} 尚未安装；可由原工作会话按 mornye-phone.md 从官方来源安装`);
    const director=sessionId?this.store.db.prepare("SELECT * FROM tasks WHERE sessionId=? AND role='coordinator' AND status='running' ORDER BY createdAt DESC LIMIT 1").get(String(sessionId)):null;
    if(sessionId&&!director)throw Error('这轮主管请求已结束，未重复派发');
    if(director&&this.hub.directorRequestedEngine(director)==='codex')throw Error('手机操作使用 DSH 工具；这条请求选择了 Codex，请改选 DSH 后再浏览');
    const goalText=String(goal||'按兴趣挑一条内容，看看正文和评论，分享真实发现').slice(0,500);
    const digest=createHash('sha256').update(platform+'\0'+goalText).digest('hex').slice(0,24);
    const task=await this.hub.create({engine:'dsh',prompt:`用手机浏览${APPS[platform].name}：${goalText}。先读 D:/qq助手/mornye-phone.md。需要评论时用 hub_social_draft 起草，等用户确认，不直接点发布。`,role:'worker',messageKey:director?`coordinator:${director.id}:${digest}`:`phone-social-browse:${String(requestKey||Math.floor(Date.now()/10000)).slice(0,80)}:${digest}`});
    return {accepted:true,sessionTitle:this.hub.sessionTitleForTask(task),status:task.status};}
  async draft({sessionId,platform,title,url='',content}={}){
    const task=this.caller(sessionId);if(!APPS[platform])throw Error('平台无效');title=String(title||'').trim();content=String(content||'').trim();
    if(title.length<4||title.length>200||!content||content.length>500)throw Error('请提供明确的内容标题及 1—500 字的评论');
    if(url){let target;try{target=new URL(url);}catch{throw Error('评论目标链接无效');}if(!/^https?:$/.test(target.protocol)||target.username||target.password||!(platform==='bilibili'?/(^|\.)(bilibili\.com|b23\.tv)$/.test(target.hostname):/(^|\.)xiaoheihe\.cn$/.test(target.hostname)))throw Error('评论链接必须属于对应平台');}
    const nodes=await this.screen(),app=APPS[platform];
    if(!nodes.some(n=>app.packages.includes(n.package))||!nodes.some(n=>compact(n.text||n.description).includes(compact(title))))throw Error('当前手机界面无法核对目标标题，请先打开并读取该内容，不凭空起草');
    const prior=this.store.db.prepare("SELECT * FROM companion_social_drafts WHERE platform=? AND title=? AND content=? AND status IN ('pending','approved','submitting','posted','uncertain') ORDER BY createdAt DESC LIMIT 1").get(platform,title,content);
    if(prior)return this.public(prior);
    if(this.store.db.prepare("SELECT id FROM companion_social_drafts WHERE status='pending' LIMIT 1").get())throw Error('已有一条评论待确认，先处理再起草下一条');
    const id=randomUUID(),now=this.store.now();this.store.db.prepare('INSERT INTO companion_social_drafts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,platform,title,url,content,task.id,'pending',null,null,now,now);
    this.hub.notification(`想在${app.name}的「${title}」下说一句：\n“${content}”\n\n这是待发布草稿。回复“确认发布评论”才会发送；不想发就回复“取消这条评论”。`,`social-preview:${id}`);this.onChange();return this.public(this.row(id));
  }
  async decide(id,approve){let row=this.row(id);if(row.status!=='pending')return this.public(row);
    if(Date.now()-Date.parse(row.createdAt)>24*3600000){this.update(id,'expired','草稿已超过一天，请重新核对内容');return this.public(this.row(id));}
    if(!approve){this.update(id,'cancelled');return this.public(this.row(id));}
    const changed=this.store.db.prepare("UPDATE companion_social_drafts SET status='approved',updatedAt=? WHERE id=? AND status='pending'").run(this.store.now(),id);if(!changed.changes)return this.public(this.row(id));
    try{const source=this.store.task(row.sourceTaskId),slot=source?fixedWorkerSlotForTask(source,this.hub.workspaceRoot):1;
      const work=await this.hub.create({engine:'dsh',role:'worker',workerSlot:slot,prompt:`手机：发布用户已确认的${APPS[row.platform].name}评论。先读 D:/qq助手/mornye-phone.md；用 hub_social_drafts 查看获批草稿 ${id}。打开并核对原内容标题，打开空白评论输入框，用 hub_social_publish 发布原文。不能改字、换目标或使用 phone_tap/phone_text 绕过发布工具。未能确认发布时停止重试并报告真实状态。`,messageKey:`social-approved:${id}`});
      this.store.db.prepare('UPDATE companion_social_drafts SET workerId=? WHERE id=?').run(work.id,id);
    }catch(error){this.update(id,'needs_attention',String(error.message).slice(0,500));}
    this.onChange();return this.public(this.row(id));
  }
  update(id,status,error=null){this.store.db.prepare('UPDATE companion_social_drafts SET status=?,error=?,updatedAt=? WHERE id=?').run(status,error,this.store.now(),id);this.onChange();}
  async reply(text){const input=String(text).split(/\n\[引用消息/u)[0].trim();if(!/^(?:确认发布评论|确认发这条评论|同意发布这条评论|取消这条评论|取消发布评论)[。！!]?$/u.test(input))return null;
    const pending=this.store.db.prepare("SELECT id FROM companion_social_drafts WHERE status='pending'").all();if(pending.length!==1)return {ok:false,reply:pending.length?'有多条评论待确认，请在中枢选择具体草稿。':'现在没有待确认的评论，未发布任何内容。'};
    const result=await this.decide(pending[0].id,!input.startsWith('取消'));
    return {ok:true,reply:result.status==='approved'?'已确认这条评论，交给原手机工作席位核对页面后发布；是否发出以实际结果为准。':result.status==='cancelled'?'这条评论已经取消，没有发布。':`评论未发布：${result.error||result.status}`};
  }
  async publish({id,sessionId}){const task=this.caller(sessionId),row=this.row(id);if(row.status!=='approved')return this.public(row);
    if(row.workerId!==task.id)throw Error('这条确认不属于当前发布任务');if(this.publishing)throw Error('另一条评论正在发布');this.publishing=true;
    try{
      let nodes=await this.screen();const app=APPS[row.platform];const verifyTarget=ns=>ns.some(n=>app.packages.includes(n.package))&&ns.some(n=>compact(n.text||n.description).includes(compact(row.title)));
      if(!verifyTarget(nodes))throw Error('当前界面无法核对原内容标题，请调整页面后重试；尚未点击发布');
      const edit=nodes.filter(n=>n.enabled&&/EditText$/.test(n.class));if(edit.length!==1)throw Error('没有唯一的评论输入框，请打开原内容的评论框');
      if(edit[0].text&&edit[0].text!==row.content&&!/^(?:说点什么|发一条友善的评论|写评论|发表评论|添加评论|输入评论)/u.test(edit[0].text))throw Error('输入框已有其他草稿，未覆盖');
      if(nodes.some(n=>!/EditText$/.test(n.class)&&n.text===row.content))throw Error('页面已存在相同文字，未重复发布，请先核对');
      await this.shell(`input tap ${Math.round(edit[0].x)} ${Math.round(edit[0].y)}`);
      if(edit[0].text!==row.content){
        const has=await this.shell('ime list -a');if(!has.includes('com.android.adbkeyboard'))throw Error('手机未安装 ADBKeyboard，不能可靠输入中文');
        const old=(await this.shell('settings get secure default_input_method')).trim(),enabled=(await this.shell('settings get secure enabled_input_methods')).trim();
        try{await this.shell('ime enable com.android.adbkeyboard/.AdbIME');await this.shell('settings put secure default_input_method com.android.adbkeyboard/.AdbIME');await new Promise(r=>setTimeout(r,600));await this.shell(`am broadcast -a ADB_INPUT_B64 --es msg ${Buffer.from(row.content).toString('base64')}`);}
        finally{if(old&&old!=='null')await this.shell(`settings put secure default_input_method ${quote(old)}`);if(enabled&&enabled!=='null')await this.shell(`settings put secure enabled_input_methods ${quote(enabled)}`);}
      }
      nodes=await this.screen();if(!verifyTarget(nodes)||!nodes.some(n=>/EditText$/.test(n.class)&&n.text===row.content))throw Error('发布前目标或评论原文无法确认，未点击发送');
      const buttons=nodes.filter(n=>n.enabled&&n.clickable&&/^(?:发送|发布|发表)$/.test(n.text||n.description));if(buttons.length!==1)throw Error('未找到唯一的发布按钮，未点击发送');
      const claim=this.store.db.prepare("UPDATE companion_social_drafts SET status='submitting',updatedAt=? WHERE id=? AND status='approved'").run(this.store.now(),id);if(!claim.changes)return this.public(this.row(id));
      try{await this.shell(`input tap ${Math.round(buttons[0].x)} ${Math.round(buttons[0].y)}`);await new Promise(r=>setTimeout(r,2000));const after=await this.screen();
        const visible=after.some(n=>app.packages.includes(n.package)&&!/EditText$/.test(n.class)&&n.text===row.content),stillEditing=after.some(n=>/EditText$/.test(n.class)&&n.text===row.content);
        this.update(id,visible&&!stillEditing?'posted':'uncertain',visible&&!stillEditing?null:'已点击发布但未核对到新评论，请到原内容查看，不自动重发');
      }catch{this.update(id,'uncertain','发布动作结果未确认，请到原内容核对，不自动重发');}
      return this.public(this.row(id));
    }finally{this.publishing=false;}
  }
}
