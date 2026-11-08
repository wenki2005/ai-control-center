'use strict';
const byId=id=>document.getElementById(id),cards=new Map();let refreshing=false,lastState=null,lastContextAt=0,activeConversation=null,sendPending=false,conversationReading=false;
const put=(id,value)=>{byId(id).textContent=value;};
const stamp=value=>{if(!value)return '—';const date=new Date(value);return Number.isFinite(date.valueOf())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date):'时间未知';};
async function request(path,value){const r=await fetch('/api/remote-companion'+path,{...(value?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}:{}),signal:AbortSignal.timeout(8000)});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error||'读取连接状态失败'),{status:r.status});return data;}
async function requestManagement(){const r=await fetch('/api/devices/management',{signal:AbortSignal.timeout(5000)});const data=await r.json();if(!r.ok)throw Error(data.error||'统一设备状态暂不可用');return data;}
function error(message){byId('error').hidden=!message;put('error',message||'');}
function node(tag,css,text){const x=document.createElement(tag);if(css)x.className=css;if(text!==undefined)x.textContent=text;return x;}
function action(text,fn,css='rc-button'){const b=node('button',css,text);b.type='button';b.onclick=async()=>{b.disabled=true;try{error('');await fn();await refresh(true);}catch(e){error(e.message);}finally{b.disabled=false;}};return b;}
function makeCard(device){
 const card=node('article','rc-device'),head=node('div','rc-device-heading'),symbol=node('span','rc-device-icon','PC'),title=node('div','rc-device-name'),name=node('h3'),badge=node('span','rc-device-status'),detail=node('p','rc-device-detail'),controls=node('div','rc-device-actions'),pair=node('div','rc-pair'),input=node('input','rc-code');
 input.inputMode='numeric';input.maxLength=6;input.placeholder='输入远端六位码';input.setAttribute('aria-label','远端六位配对码');input.autocomplete='off';
 const data={card,name,badge,detail,controls,pair,input,device};title.append(name,badge);head.append(symbol,title);card.append(head,detail,pair,controls);cards.set(device.id,data);return data;
}
function updateDevices(devices){
 const ids=new Set(devices.map(d=>d.id));for(const [id,c]of cards)if(!ids.has(id)){c.card.remove();cards.delete(id);}
 byId('devices-empty')?.remove();
 for(const d of devices){const c=cards.get(d.id)||makeCard(d);c.device=d;c.name.textContent=d.name;const phase=d.status==='pending'?'pending':d.status==='revoked'?'revoked':d.selected?'selected':'approved';c.card.className='rc-device'+(d.selected?' is-selected':'');c.badge.className='rc-device-status '+(d.online?'is-online':'');c.badge.textContent=d.status==='pending'?'等待批准':d.status==='revoked'?'已解除配对':(d.online?'在线':'离线')+(d.selected?' · 当前陪伴':'');c.detail.textContent=d.status==='pending'?'请与远端客户端核对设备名称和六位码。':d.status==='revoked'?'这台设备已不能上传新的内容。':'最近联系 '+stamp(d.lastSeen);
  if(c.phase!==phase+':'+!!d.capabilities?.work){c.phase=phase+':'+!!d.capabilities?.work;c.controls.replaceChildren();c.pair.replaceChildren();if(d.status==='pending'){
    const label=node('p','rc-pair-hint','输入远端客户端显示的核对码');c.pair.append(label,c.input,action('核对并批准',()=>request('/devices',{id:c.device.id,action:'approve',verificationCode:c.input.value.trim()})));
   }else if(d.status==='approved'){
    const settings=node('details'),heading=node('summary',null,'远端工作权限'),select=node('select','rc-code');
    select.setAttribute('aria-label','DSH任务执行方式');for(const [value,label]of [['native-read-only','原生只读沙箱'],['task-read-only','保留原生权限 · 任务约定只读'],...(d.capabilities?.work?[["native-work","实际工作 · 使用原生工具与权限"]]:[]) ]){const option=node('option',null,label);option.value=value;select.append(option);}
    select.value=d.dshExecutionPolicy||'native-read-only';c.policySelect=select;
    settings.append(heading,select,node('p','rc-muted','实际工作可操作应用和任务文件，原生审批仍交给你；改变设置仅影响新派发任务。'),action('保存执行方式',()=>request('/devices',{id:c.device.id,action:'execution-policy',policy:select.value})));c.controls.append(settings);
    if(!d.selected)c.controls.append(action('设为陪伴电脑',()=>request('/devices',{id:c.device.id,action:'select'}),'rc-button rc-button-secondary'));
    c.controls.append(action('解除配对',async()=>{if(confirm('确认解除这台电脑的配对并结束它的陪伴连接？'))await request('/devices',{id:c.device.id,action:'revoke'});},'rc-button rc-button-quiet'));
   }}
  if(!c.card.isConnected)byId('devices').append(c.card);
 }
 if(!devices.length){const empty=node('div','rc-empty','在另一台电脑运行客户端后，连接申请会出现在这里。');empty.id='devices-empty';byId('devices').append(empty);}
 put('device-count',devices.filter(d=>d.status!=='revoked').length+' 台');
}
function updateConnection(s){
 const d=s.devices.find(d=>d.id===s.activeDeviceId),o=s.observation||{},paired=!!d,online=!!d?.online,received=!!o.lastReceived,summary=o.observation?.summary;
 put('pair-label',paired?'已批准 '+d.name:s.devices.some(d=>d.status==='pending')?'有新设备等待批准':'等待设备申请');put('online-label',online?'已建立私有连接':paired?'等待电脑上线':'先完成设备配对');
 const age=Date.now()-Date.parse(o.observation?.capturedAt||o.lastReceived||'');const fresh=o.active&&summary&&Number.isFinite(age)&&age<120000;
 const screenText=!online?'等待连接':o.busy?'正在分析':o.lastError?'分析遇到问题':fresh?'正在陪伴':received&&o.active?'画面待更新':'等待共享画面';
 put('screen-label',fresh?'已看到共享内容':o.busy?'已收图，正在分析':received?'已有画面记录':'尚未收到画面');
 for(const [id,done]of [['step-pair',paired],['step-online',online],['step-screen',!!fresh]])byId(id).classList.toggle('is-complete',done);
 byId('discover-codex').disabled=!s.sessionBridge||!d?.capabilities?.nativeSessions;byId('discover-dsh').disabled=!s.sessionBridge||!d?.capabilities?.nativeSessions;byId('remote-client-download').hidden=!s.clientDownloadReady;
 put('native-access-hint',!s.sessionBridge?'原生会话接入升级正在等待加载，暂不影响当前屏幕共享。':d?.capabilities?.nativeSessions?'已允许接入 '+d.name+' 的原生会话，可直接发现并查看。':'需要远端客户端0.2或以上版本，并点击“允许中枢接入会话”。屏幕共享仍可独立使用。');
 put('remote-access-label',d?.capabilities?.work?'私有连接 · 可实际工作':d?.capabilities?.messages?'私有连接 · 消息与只读任务':d?.capabilities?.nativeSessions?'私有连接 · 只读查看':'私有连接 · 屏幕陪伴');put('selected-name',d?.name||'还没有选择电脑');put('screen-status',screenText);byId('screen-status').className='rc-badge'+(fresh?' is-success':o.lastError?' is-warning':'');
 put('last-contact',stamp(d?.lastSeen));put('last-frame',stamp(o.lastReceived));put('last-analysis',stamp(o.lastSeen));
 byId('screen-placeholder').toggleAttribute('hidden',!!summary);
 put('observation-title',summary?(fresh?window.aiCenterIdentity.name+'最近看到的画面':'最近一次画面记录'):o.lastError?'画面已收到，分析未完成':o.busy?'画面已送达，正在看':'等你选好共享窗口');
 put('observation',summary||(o.lastError?'截图已送达中枢；分析恢复后，这里会显示画面摘要，无需重新配对设备。': '在另一台电脑的客户端点击“选择屏幕或窗口”，这里会显示'+window.aiCenterIdentity.name+'实际看到的内容。'));
 put('next-action',!paired?'先批准设备，或将一台已配对电脑设为陪伴电脑。':!online?'设备已配对，当前没有收到及时心跳；请确认远端客户端和网络仍在运行。':o.lastError?'画面已接收，但这次分析未完成：'+o.lastError:!received?'设备已连接。下一步：在远端客户端选择屏幕或窗口，开始共享。':fresh?'共享正在运行，你可以继续正常工作。每分钟采集一次，也可以在远端点“立即看一眼”。':o.busy?'已收到画面，观察员正在分析。完成后由'+window.aiCenterIdentity.name+'陪你聊。':'当前显示的是已有记录；新画面送达后会更新，不代表实时视频。');
 put('gateway',s.gateway?'私有接收入口运行中 · 仅接收已配对设备':'私有接收入口尚未启动');
}
function updateManagement(view){
 const container=byId('device-management-list'),message=byId('device-management-status');container.replaceChildren();
 if(!view||!Array.isArray(view.devices)){message.textContent='统一设备状态暂不可用；下方配对、共享会话读取仍可单独使用。';return;}
 message.textContent='状态按设备和来源分别汇总；远端会话观察不代表任务已完成。';
 if(!view.devices.length){message.textContent='暂无设备状态。';return;}
 for(const d of view.devices){
  const card=node('article','rc-resource'),title=node('strong',null,d.name||d.deviceId||'未知设备'),meta=node('p','rc-resource-meta');
  const online=d.online===true?'在线':d.online===false?'离线':'未知';
  const caps=d.capabilities?.reported||d.capabilities||{},capText=['nativeSessions','messages','work'].map(key=>`${key==='nativeSessions'?'会话接入':key==='messages'?'消息':'实际工作'}：${caps[key]===true?'已报告允许':caps[key]===false?'已报告关闭':'未知'}`).join(' · ');
  const policy=d.permissions?.executionPolicy||d.permissions?.dshExecutionPolicy||'未知';
  const compatibility=d.capabilities?.compatibility==='reported-0.2.9'?'客户端已报告版本 0.2.9':d.capabilities?.compatibility==='reported-other'?`客户端报告版本 ${d.capabilities.clientVersion||'未知'}；功能按逐项声明显示`: '客户端版本或能力未报告；相关功能未知';
  const share=d.sharing?.active===true?(d.sharing.fresh===true?'共享中 · 状态新鲜':'共享状态待更新'):d.sharing?.active===false?'未共享':'共享状态未知';
  const lease=d.desktopLease?`中枢桌面租约：${({active:'占用中',uncertain:'结果待核对',yielded:'已让出前台'})[d.desktopLease.state]||'未知'}`:'没有中枢租约记录；系统桌面占用未知';
  meta.textContent=`${online} · 最近联系 ${stamp(d.lastSeen)} · 权限 ${policy} · ${compatibility} · ${capText} · ${share} · ${lease}`;
  card.append(title,meta);
  const tasks=Array.isArray(d.currentTasks)?d.currentTasks:[];
  if(!tasks.length)card.append(node('p','rc-muted','当前任务：未知（没有权威任务记录）'));
  let history=null;
  for(const task of tasks){
   const nativeAccepted=task.source==='local-task-record'?(task.nativeAcceptance?.status==='accepted'&&task.accepted===true):task.accepted===true;
   const received=nativeAccepted?'原生引擎已确认接收':task.source!=='local-task-record'&&task.accepted===false?'原生接收未确认':'原生接收状态未知';
   const center=task.centerReceipt?.received===true?'中枢已收件；':'';
   const execution=task.execution?.status==='recent-activity'?'近期有原生活动（不保证当前仍执行）':'原生执行状态未知';
   const recorded=({queued:'中枢排队记录',waiting:'中枢等待记录',interrupted:'历史中断记录',running:'中枢运行记录'})[task.status]||'工作记录';
   const completion=task.completion?.status==='completed'?'已完成 · '+(task.completion.evidence||'有完成记录'):task.completion?.status==='failed'?'未完成 · 有失败记录':'完成状态未知';
   const source=task.source==='local-task-record'?'本机任务记录':task.source==='remote-native-read-job'?'远端接收账本':'来源未知',label=`${task.label||'工作任务'} · ${task.engine||'引擎未知'} · ${recorded} · ${center}${received} · ${execution} · ${completion} · ${source}`;
   if(task.status==='interrupted'){
    if(!history){history=node('details');history.append(node('summary',null,'历史中断记录（不表示仍在执行）'));card.append(history);}
    history.append(node('p','rc-resource-meta',label));
   }else card.append(node('p','rc-resource-meta',label));
  }
  container.append(card);
 }
}
async function updateResources(force){if(!force&&Date.now()-lastContextAt<10000)return;lastContextAt=Date.now();const context=await request('/context'),items=[];for(const s of context.sessions||[]){const row=node('div','rc-resource'),name=node('strong',null,s.sessionName||'未命名会话');row.append(node('span','rc-resource-type',s.engine==='codex'?'Codex':'DSH'),name,node('span','rc-resource-meta',({running:'正在工作',completed:'已完成',failed:'未完成',unknown:'状态待确认'})[s.status]||'状态待确认'));row.append(action('进入会话',()=>openConversation({deviceId:context.device?.id,engine:s.engine,sessionId:s.sessionKey},s.sessionName,true),'rc-button rc-button-secondary'));items.push(row);}for(const f of context.files||[]){const row=node('div','rc-resource');row.append(node('span','rc-resource-type','文档'),node('strong',null,f.name),node('span','rc-resource-meta','已接收'));items.push(row);}if(!items.length)items.push(node('p','rc-muted','还没有共享文档或连接工作会话。'));byId('resources').replaceChildren(...items);}
async function refresh(force=false){if(refreshing)return;refreshing=true;try{const s=await request('');lastState=s;updateDevices(s.devices);updateConnection(s);let management=null;try{management=await requestManagement();}catch(e){byId('device-management-status').textContent='统一设备状态暂不可用：'+e.message+'；配对、权限和会话读取仍可使用。';}if(management)updateManagement(management);await updateResources(force);updateComposer();await updateRemoteApprovals();error('');}catch(e){error('状态暂时没有更新：'+e.message);}finally{refreshing=false;}}
document.addEventListener('ai-center-identity',()=>{if(lastState)updateConnection(lastState);});
void refresh(true);setInterval(()=>{void refresh();void window.aiCenterIdentity.refresh().catch(()=>{});},4000);

async function nativeRequest(value){const job=await request('/sessions',value);put('remote-read-status','正在连接 '+(value.engine==='codex'?'Codex':'DSH')+'，由远端电脑读取会话…');const end=Date.now()+65000;while(Date.now()<end){const r=await request('/reads/'+job.id);if(r.status==='completed')return r.result;if(['failed','expired','uncertain'].includes(r.status))throw Error(r.error||'远端读取未完成');await new Promise(resolve=>setTimeout(resolve,1500));}throw Error('远端暂未返回，请确认客户端已运行并允许接入');}
async function discover(engine){const d=lastState?.devices.find(x=>x.id===lastState.activeDeviceId);if(!d)throw Error('请先选择远端陪伴电脑');const result=await nativeRequest({deviceId:d.id,engine,action:'list'});put('remote-read-status','已从 '+d.name+' 取得 '+result.items.length+' 个'+(engine==='codex'?' Codex':' DSH')+'会话（最近列表）');const panel=byId('remote-catalog'),search=node('input','rc-code');search.placeholder='搜索远端会话名称';search.setAttribute('aria-label','搜索远端会话');const list=node('div','rc-catalog-list');const render=()=>{list.replaceChildren(...result.items.filter(item=>item.title.toLowerCase().includes(search.value.toLowerCase())).map(item=>{const row=node('div','rc-resource');row.append(node('strong',null,item.title),action('进入会话 · 查看与发消息',()=>openConversation({deviceId:d.id,engine,sessionId:item.sessionId},item.title),'rc-button rc-button-secondary'));return row;}));};search.oninput=render;panel.replaceChildren(search,list);render();}
for(const [id,engine] of [['discover-codex','codex'],['discover-dsh','dsh']])byId(id).onclick=async()=>{const b=byId(id);b.disabled=true;try{await discover(engine);}catch(e){put('remote-read-status',e.message);}finally{b.disabled=false;}};

function updateComposer(){
 const d=lastState?.devices.find(x=>x.id===activeConversation?.deviceId);byId('remote-message').placeholder=d?.capabilities?.work?'输入要让远端会话执行的工作或消息':'输入消息或只读任务';const allowed=!!(d?.online&&d?.capabilities?.messages);
 byId('remote-message-send').disabled=sendPending||!allowed;
 byId('remote-message').disabled=!allowed||sendPending;
 byId('remote-conversation-refresh').disabled=conversationReading||!d?.online;
}
function showMessages(data){const messages=byId('remote-conversation-messages');messages.replaceChildren(...(data.messages||[]).map(m=>{const entry=node('article','rc-message');entry.append(node('p','rc-eyebrow',m.role==='user'?'远端用户输入':'远端助手回复'),node('pre','rc-message-text',m.text));return entry;}));if(!data.messages?.length)messages.append(node('p','rc-muted','这个会话暂时没有可见消息。'));}
async function openConversation(target,title,discoverFirst=false){
 if(sendPending)throw Error('上一条消息正在确认接收，请稍等，不会重复提交');
 if(discoverFirst){const catalog=await nativeRequest({deviceId:target.deviceId,engine:target.engine,action:'list'});if(!catalog.items?.some(x=>x.sessionId===target.sessionId))throw Error('这条会话没有出现在远端当前列表，请重新发现并选择会话');}
 const data=await nativeRequest({...target,action:'read'}),d=lastState?.devices.find(x=>x.id===target.deviceId);activeConversation=target;
 byId('remote-message').value='';showMessages(data);put('remote-conversation-title',(d?.name||'远端电脑')+' · '+(data.sessionName||title));
 put('remote-message-status',!d?.online?'远端设备当前离线。':d.capabilities?.messages?d.capabilities?.work?'消息直接发到远端原会话，可按原生权限操作应用和任务文件；审批交给你。':'消息直接发到这个远端原会话，保留上下文；任务执行方式见设备设置。':'请在远端陪伴助手的权限设置中选择“允许消息和只读任务”。');
 updateComposer();byId('remote-conversation').showModal();put('remote-read-status','已连接所选远端原会话，可以查看内容或发送消息。');
}
async function refreshConversation(){if(!activeConversation||conversationReading)return;conversationReading=true;updateComposer();const target=activeConversation;try{const data=await nativeRequest({...target,action:'read'});if(activeConversation===target)showMessages(data);}finally{conversationReading=false;updateComposer();}}
byId('remote-conversation-refresh').onclick=async()=>{try{await refreshConversation();}catch(e){put('remote-message-status','会话暂时没有更新：'+e.message);}};
byId('remote-message-send').onclick=async()=>{
 if(sendPending)return;const target=activeConversation,prompt=byId('remote-message').value;
 try{if(!target||!prompt.trim())throw Error('请先选择会话并输入消息');const d=lastState?.devices.find(x=>x.id===target.deviceId);if(!d?.online||!d.capabilities?.messages)throw Error('远端当前未连接，或尚未允许发送消息');sendPending=true;updateComposer();put('remote-message-status','正在交给所选远端会话，不会派到中枢本机…');
 const result=await nativeRequest({...target,action:'post',prompt});
 if(activeConversation===target){put('remote-message-status',result.stage==='native_message_queued'?'远端 DSH 已确认接收，等待原会话执行；这还不是完成结果。':'远端 Codex 已确认接收，正在原会话执行；这还不是完成结果。');byId('remote-message').value='';void refreshConversation().catch(()=>{});}
 }catch(e){if(activeConversation===target)put('remote-message-status',e.message);}finally{sendPending=false;updateComposer();}
};
setInterval(()=>{if(byId('remote-conversation').open&&!sendPending)void refreshConversation().catch(()=>{});},15000);

const remoteApprovalCards=new Map();
async function updateRemoteApprovals(){
 let result;try{result=await request('/approvals');}catch{put('remote-approvals','远端审批通道等待中枢加载，现有会话连接不受影响。');return;}const {items=[]}=result,visible=new Set(items.map(a=>a.id)),container=byId('remote-approvals');
 for(const [id,card]of remoteApprovalCards)if(!visible.has(id)){card.remove();remoteApprovalCards.delete(id);}
 if(!items.length){if(!remoteApprovalCards.size)container.replaceChildren(node('p','rc-muted','暂无待确认事项。'));return;}
 if(!remoteApprovalCards.size)container.replaceChildren();
 for(const item of items){if(remoteApprovalCards.has(item.id))continue;const card=node('article','rc-resource'),body=node('div'),device=lastState?.devices.find(d=>d.id===item.deviceId);
 body.append(node('strong',null,(device?.name||'远端电脑')+' · '+(item.engine==='codex'?'Codex':'DSH')),node('pre','rc-message-text',item.question));
 const controls=node('div','rc-device-actions');const answer=async value=>{await request('/approvals/'+encodeURIComponent(item.id),{answer:value});await updateRemoteApprovals();};
 if(item.options?.length){for(const option of item.options)controls.append(action(option.label,()=>answer(option.value),'rc-button rc-button-secondary'));}
 else{const field=node('textarea','rc-code');field.maxLength=12000;field.setAttribute('aria-label','远端会话需要的答复');field.placeholder='输入答复';controls.append(field,action('发送答复',()=>answer(field.value)));}
 body.append(controls);card.append(body);remoteApprovalCards.set(item.id,card);container.append(card);}
}
