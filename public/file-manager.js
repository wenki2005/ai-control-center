(() => {
  const $=selector=>document.querySelector(selector);if(!$('#sent-files-panel'))return;
  const state={q:'',type:'all',page:1,hasMore:false,request:0,preview:0};
  const node=(tag,className,text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e;};
  const formatSize=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${Math.ceil(n/1024)} KB`:`${n} B`;
  async function read(url){const r=await fetch(url,{credentials:'same-origin',signal:AbortSignal.timeout(25000)});const body=await r.json();if(!r.ok)throw Error(body.error||'暂时无法读取文件');return body;}
  function select(section){const sent=section==='sent';$('#sent-files-panel').hidden=!sent;$('#library-workspace').hidden=section!=='personal';$('#task-files-panel').hidden=section!=='tasks';$('#sent-files-tab').setAttribute('aria-selected',String(sent));$('#personal-files-tab').setAttribute('aria-selected',String(section==='personal'));$('#task-files-tab').setAttribute('aria-selected',String(section==='tasks'));if(sent)void load();else if(section==='personal')$('#tab-archive').click();else document.dispatchEvent(new Event('ai-center:archive-open'));}
  async function preview(file){
    const ticket=++state.preview,dialog=$('#sent-file-preview'),body=$('#sent-file-preview-body');
    $('#sent-file-preview-title').textContent=file.name;$('#sent-file-preview-download').href=file.downloadUrl;body.replaceChildren(node('p','file-manager-note','正在打开文件…'));if(!dialog.open)dialog.showModal();
    try{const result=await read(`/api/files/${encodeURIComponent(file.id)}/preview`);if(ticket!==state.preview||!dialog.open)return;body.replaceChildren();
      if(result.kind==='image'){const image=node('img','sent-file-image');image.src=result.url;image.alt=file.name;image.addEventListener('error',()=>body.replaceChildren(node('p','file-manager-note','图片暂时无法显示，可以下载后查看。')));body.append(image);}
      else if(result.kind==='pdf'){const frame=node('iframe','sent-file-pdf');frame.src=result.url;frame.title=file.name;body.append(frame);body.append(node('p','file-manager-note','如果没有显示预览，可下载后用 PDF 阅读器打开。'));}
      else if(result.kind==='text'){body.append(node('pre','sent-file-text',result.text));if(result.truncated)body.append(node('p','file-manager-note','这里只预览部分内容，下载可查看完整文件。'));}
      else body.append(node('p','file-manager-note',result.message));
    }catch(error){if(ticket===state.preview)body.replaceChildren(node('p','file-manager-note',error.message));}
  }
  async function load(){
    if($('#sent-files-panel').hidden)return;const ticket=++state.request;
    const list=$('#sent-files-list'),status=$('#sent-files-status');status.textContent='正在读取文件…';
    try{
      const data=await read('/api/files?'+new URLSearchParams({q:state.q,type:state.type,page:String(state.page)}));if(ticket!==state.request)return;
      list.replaceChildren();state.hasMore=data.hasMore;$('#sent-files-count').textContent=`共 ${data.total} 个文件`;$('#sent-files-page').textContent=`第 ${data.page} 页`;
      $('#sent-files-prev').disabled=data.page<=1;$('#sent-files-next').disabled=!data.hasMore;status.textContent='';
      if(!data.files.length)list.append(node('div','empty-state',state.q?'没有找到匹配的文件，换个关键词试试。':'发给你的文件会出现在这里。'));
      for(const file of data.files){
        const card=node('article','sent-file-card'),top=node('div','sent-file-top');top.append(node('span','sent-file-badge',file.extension||'文件'),node('h3','sent-file-title',file.name));card.append(top);
        const date=new Date(file.sentAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
        card.append(node('p','sent-file-meta',`${date} · ${formatSize(file.size)} · ${file.available?'已发送':'本机文件已不可用'}`));
        const actions=node('div','sent-file-actions'),view=node('button','','查看');view.type='button';view.disabled=!file.available;view.addEventListener('click',()=>preview(file));actions.append(view);
        if(file.available){const download=node('a','download-link','下载');download.href=file.downloadUrl;download.setAttribute('download',file.name);actions.append(download);}
        card.append(actions);list.append(card);
      }
    }catch(error){if(ticket!==state.request)return;status.textContent=error.message;list.replaceChildren(node('div','empty-state','文件暂时没有读出来，请点“刷新”重试。'));}
  }
  $('#sent-files-tab').addEventListener('click',()=>select('sent'));$('#personal-files-tab').addEventListener('click',()=>select('personal'));$('#task-files-tab').addEventListener('click',()=>select('tasks'));
  $('#sent-files-search').addEventListener('submit',e=>{e.preventDefault();state.q=$('#sent-files-query').value.trim();state.page=1;void load();});
  $('#sent-files-type').addEventListener('change',()=>{state.type=$('#sent-files-type').value;state.page=1;void load();});
  $('#sent-files-refresh').addEventListener('click',()=>load());$('#sent-files-prev').addEventListener('click',()=>{state.page=Math.max(1,state.page-1);void load();});$('#sent-files-next').addEventListener('click',()=>{if(state.hasMore){state.page++;void load();}});
  $('#sent-file-preview-close').addEventListener('click',()=>$('#sent-file-preview').close());$('#sent-file-preview').addEventListener('close',()=>{state.preview++;$('#sent-file-preview-body').replaceChildren();});
  document.addEventListener('ai-center:files-open',()=>load());
  setInterval(()=>{if(!document.hidden&&!$('#page-archive').hidden&&!$('#sent-files-panel').hidden)void load();},30000);
  function openLinkedFiles(){if(location.hash==='#files'){$('#task-files-panel').hidden=true;$('#task-files-tab').setAttribute('aria-selected','false');$('#sent-files-panel').hidden=false;$('#library-workspace').hidden=true;$('#sent-files-tab').setAttribute('aria-selected','true');$('#personal-files-tab').setAttribute('aria-selected','false');$('#tab-archive').click();}}
  window.addEventListener('hashchange',openLinkedFiles);openLinkedFiles();
  if(!$('#page-archive').hidden)void load();
})();
