'use strict';
(() => {
  const el=id=>document.getElementById(id);if(!el('local-resource-section'))return;
  const number=(value,suffix='')=>Number.isFinite(value)?`${Math.round(value*10)/10}${suffix}`:'未知';
  const gib=value=>Number.isFinite(value)?number(value/1073741824,' GiB'):'未知';
  async function refresh(){
    const button=el('local-resources-refresh');button.disabled=true;
    try{
      const response=await fetch('/api/local-resources',{signal:AbortSignal.timeout(5000)}),state=await response.json();if(!response.ok)throw Error(state.error||'本机资源读取失败');
      const monitor=state.monitor,sample=monitor.latest?.snapshot;
      el('local-resources-status').textContent=sample?`本机采样：${new Date(sample.checkedAt).toLocaleString()} · ${sample.durationMs} ms${sample.error?' · 部分数据不可用':''}`:'尚无本机采样；状态刷新不会启动模型。';
      const values=el('local-resources-values');values.replaceChildren();
      for(const [label,value]of [['CPU',number(sample?.cpuPercent,'%')],['内存占用',number(sample?.memoryPercent,'%')],['磁盘剩余',gib(sample?.disk?.freeBytes)],['显存',`${gib(sample?.gpu?.usedBytes)} / ${gib(sample?.gpu?.totalBytes)}`]]){const row=document.createElement('p');row.textContent=`${label}：${value}`;values.append(row);}
      const work=state.coordinator;el('local-resources-work').textContent=`本地计算：${work.active.length} 项预算预约，${work.queued} 项等待；预约不等于模型正在执行。服务活动：${state.busy?'有':'无'}。预算：内存 ${gib(work.limits.memoryBytes)}，显存 ${gib(work.limits.gpuBytes)}。${Object.keys(work.limits).length?'':'尚未配置数字预算；不会猜测模型占用。'}`;
      const maintenance=await fetch('/api/system/maintenance',{signal:AbortSignal.timeout(5000)});
      if(maintenance.ok){const info=await maintenance.json();el('local-maintenance-status').textContent=`已加载：${info.loaded.releaseId}；磁盘：${info.disk.releaseId}。${info.sourceMatches?'源码一致。':'新版尚未加载。'}${info.guidance}`;}
      else if(maintenance.status===404)el('local-maintenance-status').textContent='当前运行版本没有维护核对入口。磁盘新版不等于已加载；需要正常退出并重新打开程序。';
      el('local-resources-alerts').textContent=monitor.incidents.length?`持续异常：${monitor.incidents.map(x=>x.metric).join('、')}`:'当前没有持续异常告警。';
    }catch(error){el('local-resources-status').textContent=error.message;}finally{button.disabled=false;}
  }
  el('local-resources-refresh').addEventListener('click',()=>void refresh());
  el('local-resources-reconcile')?.addEventListener('click',async event=>{
    event.target.disabled=true;
    try{const response=await fetch('/api/local-resources/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const info=await response.json();if(!response.ok)throw Error(info.error||'当前版本没有核对入口');await refresh();el('local-maintenance-status').textContent+=' 核对结果：'+(info.results.map(x=>x.status==='budget-released'?'已核对空闲预算；原业务结果仍未知':'缺少活动证据，继续保护').join('；')||'没有可核对的历史绘图预约');}
    catch(error){el('local-maintenance-status').textContent=error.message;}finally{event.target.disabled=false;}
  });
  document.querySelector('[data-page="system"]')?.addEventListener('click',()=>void refresh());
  void refresh();
})();
