(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const panel = $('screen-companion-dialog'), feedback = $('screen-companion-feedback');
  let stream = null, token = null, heartbeat = null, sampling = null, polling = null, busy = false, previous = null, stopping = null;
  const pickerClient=crypto.randomUUID();let pickerRequest=null,checkingPicker=false;
  const video = document.createElement('video'), canvas = document.createElement('canvas'), thumb = document.createElement('canvas');
  video.muted=true;video.autoplay=true;video.playsInline=true;
  thumb.width = 96;thumb.height = 54;
  async function api(path, value) {
    const response = await fetch('/api/screen-companion' + path, value === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
    });
    const data = await response.json();if (!response.ok) throw Error(data.error || '陪工作暂时无法连接');return data;
  }
  function controls(active) {
    $('screen-companion-send').hidden=!active;
    $('screen-companion-badge').textContent = active ? '● 正在共享 · 每分钟采集' : '未共享屏幕';$('screen-companion-open').textContent=active?'共享中 · 查看或停止':'陪我工作 · 选择窗口';
  }
  async function update() {
    const status = await api('');
    if (token && !status.active) { await end('共享连接已结束，请重新选择画面');return; }
    if(token&&status.shareRequest&&!busy)await sendFrame(status.shareRequest.id);
    if(token&&status.lastShare)$('screen-companion-send').title=status.lastShare.sent?'上次共享画面已通过QQ发送':status.lastShare.error||'点击截取当前共享窗口并发送到QQ';
    if (token) feedback.textContent = status.lastError || (status.busy ? '她正在看这次画面，普通聊天仍可继续…' :
      `正在陪你工作${status.lastSeen ? ' · 最近看过 ' + new Date(status.lastSeen).toLocaleTimeString() : ''}。画面没变时安静等待。`);
  }
  function snapshot(){
    if(!stream||!token||video.readyState<2)throw Error('当前共享窗口还没有可用画面');
    const width=Math.min(1440,video.videoWidth),height=Math.round(video.videoHeight*width/video.videoWidth);
    if(!width||!height)throw Error('当前共享画面尺寸无效');
    canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(video,0,0,width,height);
    let image=canvas.toDataURL('image/jpeg',0.7);if(image.length>1500000)image=canvas.toDataURL('image/jpeg',0.4);return image;
  }
  async function sendFrame(requestId){
    if(busy)return;busy=true;
    try{const result=await api('/share',{token,requestId,image:snapshot()});feedback.textContent=result.sent?'共享画面已通过QQ发送。':result.status==='queued'?'共享画面已截取，等待QQ确认发送。':result.error||'正在等待共享画面。';}
    catch(error){feedback.textContent=error.message;}finally{busy=false;}
  }
  $('screen-companion-send').addEventListener('click',()=>void sendFrame('web:'+crypto.randomUUID()));
  async function capture(question = '') {
    if (!stream || !token || busy || video.readyState < 2) return false;
    busy = true;
    try {
      const ctx = thumb.getContext('2d', { willReadFrequently: true });ctx.drawImage(video, 0, 0, 96, 54);
      const pixels = ctx.getImageData(0, 0, 96, 54).data;
      let difference = 0;
      if (previous) for (let i = 0; i < pixels.length; i += 4) difference += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]);
      if (!question && previous && difference / (96 * 54 * 3) < 1.5) return false;
      const image=snapshot();
      const result = await api('/frame', { token, image, question });
      if (result.accepted || result.queued) { previous = new Uint8ClampedArray(pixels);feedback.textContent = '画面已交给她，等她看一眼…'; }
      else if (question) feedback.textContent = '她还在看上一张画面，请等这轮结束再问；你的文字已保留。';
      return result.accepted === true;
    } catch (error) { feedback.textContent = error.message;return false; }
    finally { busy = false; }
  }
  function end(message = '陪工作已结束，停止采集画面。') {
    if (stopping) return stopping;
    const oldToken = token;token = null;
    clearInterval(heartbeat);clearInterval(sampling);clearInterval(polling);
    const oldStream = stream;stream = null;oldStream?.getTracks().forEach(track => track.stop());
    video.srcObject = null;previous = null;canvas.width = canvas.height = 0;
    controls(false);feedback.textContent = message;
    stopping = (oldToken ? api('/stop', { token: oldToken, confirmed: true }).catch(() => {}) : Promise.resolve()).finally(() => { stopping = null; });
    return stopping;
  }
  const picker=document.createElement('div');picker.dataset.screenPicker='true';panel.appendChild(picker);
  async function resolvePicker(status){
    const id=pickerRequest;pickerRequest=null;if(!id)return;
    await api('/picker/resolve',{id,clientId:pickerClient,status}).catch(()=>{});
  }
  panel.addEventListener('close',()=>{if(!token)void resolvePicker('cancelled');});
  async function pick(){
    if(token){if(window.confirm('停止共享当前窗口？'))await end();return;}
    if(!window.mornyeScreen){await startSharing();return;}
    panel.showModal();picker.replaceChildren();feedback.hidden=false;feedback.textContent='正在读取屏幕和窗口…';
    try{const sources=await window.mornyeScreen.sources();for(const source of sources){
      const button=document.createElement('button');button.type='button';button.className='screen-source-choice';
      const img=document.createElement('img');img.src=source.thumbnail;img.alt='';img.className='screen-source-preview';
      const label=document.createElement('span');label.textContent=(source.kind==='screen'?'屏幕 · ':'窗口 · ')+source.name;button.append(img,label);
      button.onclick=async()=>{try{await window.mornyeScreen.choose(source.id);await startSharing();}catch(error){feedback.hidden=false;feedback.textContent=error.message;}};picker.appendChild(button);
    }feedback.hidden=sources.length>0;if(!sources.length)feedback.textContent='暂时没有可选画面，请稍后重新打开选择器。';}catch(error){feedback.hidden=false;feedback.textContent='窗口列表读取失败：'+error.message;await resolvePicker('failed');}
  }
  $('screen-companion-open').addEventListener('click',()=>void pick());
  async function startSharing() {
    if (stream || stopping) return;
    if (!navigator.mediaDevices?.getDisplayMedia) { await resolvePicker('failed');if(!panel.open)panel.showModal();feedback.hidden=false;feedback.textContent = '当前容器不提供屏幕共享。请使用新版中枢桌面端，或在本机 Edge 打开中枢后选择共享。';return; }
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
      video.srcObject = stream;await video.play();
      const result = await api('/start', {});token = result.token;
      stream.getVideoTracks()[0].addEventListener('ended', () => { void end('你已停止屏幕共享，陪工作也已结束。'); }, { once: true });
      if (stream.getVideoTracks()[0].readyState !== 'live') { await end();return; }
      controls(true);feedback.textContent = '共享已开始，每分钟采集变化画面。';picker.replaceChildren();panel.close();
      await resolvePicker('shared');
      heartbeat = setInterval(() => { if (token) void api('/heartbeat', { token }).catch(() => end('连接已中断，画面采集已停止，请重新开启。')); }, 20000);
      sampling = setInterval(() => { void capture(); }, 60000);
      polling = setInterval(() => { void update().catch(() => {}); }, 5000);
      void capture();
    } catch (error) { await end();await resolvePicker(error.name==='NotAllowedError'?'cancelled':'failed');if(!panel.open)panel.showModal();feedback.hidden=false;feedback.textContent = error.name === 'NotAllowedError' ? '没有开启共享，你可以准备好后再叫她。' : ('共享失败：'+error.name+' · '+error.message); }
  }
  async function checkPicker(){
    // Only the native desktop can enumerate sources without a browser gesture.
    // Other tabs must not consume the QQ request or silently start capture.
    if(!window.mornyeScreen||token||stopping||panel.open||checkingPicker)return;
    checkingPicker=true;
    try{const state=await api('/picker');if(state.request?.status!=='pending')return;
      const claimed=await api('/picker/claim',{id:state.request.id,clientId:pickerClient});
      if(!claimed.request)return;pickerRequest=claimed.request.id;window.focus();await pick();
    }catch(error){if(pickerRequest){feedback.hidden=false;feedback.textContent=error.message;await resolvePicker('failed');}}
    finally{checkingPicker=false;}
  }
  setInterval(()=>void checkPicker(),3000);void checkPicker();
  window.addEventListener('pagehide', () => { void end(); });
})();
