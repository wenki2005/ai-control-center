(() => {
  'use strict';
  const $ = id => document.getElementById(id), panel = $('server-monitor-window');
  let editing = false;
  const message = text => { $('server-monitor-feedback').textContent = text; };
  async function api(path = '', body) {
    const response = await fetch('/api/server-monitor' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const value = await response.json();if (!response.ok) throw Error(value.error || '巡检连接失败');return value;
  }
  function render(state) {
    const last = state.last, snapshot = last?.snapshot;
    $('server-monitor-status').textContent = `${state.label} · ${!state.configured ? '尚未接入' : !state.settings.enabled ? '已暂停' : last?.error ? '未取得服务器指标' : last ? '巡检中' : '等待首次检查'}${last ? ' · 最近检查 ' + new Date(last.checkedAt).toLocaleString() : ''}${state.stale ? ' · 数据尚未更新，请勿当作当前状态' : ''}`;
    const metrics = $('server-monitor-metrics');metrics.replaceChildren();
    const add = (parent, text) => { const p = document.createElement('p');p.textContent = text;parent.append(p); };
    if (last?.error) add(metrics, last.error);
    if (snapshot) {
      const percent = value => value === null ? '未取得' : value + '%';
      add(metrics, `CPU ${percent(snapshot.cpu)} · 内存 ${percent(snapshot.memory)} · 负载 ${percent(snapshot.load)}`);
      for (const disk of snapshot.disks) add(metrics, `磁盘 ${disk.path}：${disk.percent}%${disk.freeBytes!==null&&disk.freeBytes!==undefined?' · 可用 '+(disk.freeBytes/1e9).toFixed(1)+' GB':''}`);
      if(snapshot.host)add(metrics,`主机进程 ${snapshot.host.processes??'未取得'} 个 · 运行 ${snapshot.host.uptimeSeconds===null?'未取得':Math.floor(snapshot.host.uptimeSeconds/86400)+' 天'} · 交换内存 ${percent(snapshot.host.swapPercent)}`);
      if(snapshot.panel?.dns?.systemError)add(metrics,`系统域名解析曾返回 ${snapshot.panel.dns.systemError}，本次通过${snapshot.panel.dns.source==='independent-resolver'?'独立解析器':'近期有效解析记录'}取得指标；原域名与证书校验保留。`);
      if(snapshot.host?.sendMbps!==undefined)add(metrics,`网卡 ${snapshot.host.networkInterface}：入站 ${snapshot.host.receiveMbps} Mbps · 出站 ${snapshot.host.sendMbps} Mbps`);
      add(metrics, `背单词应用：${!snapshot.app.configured ? '未配置健康检查' : snapshot.app.healthy ? '健康接口正常' : '健康检查失败'}。`);
    }
    const inventory=state.settings.resourceFocus?null:state.inventory;
    if(inventory){
      add(metrics,`全机清单：${new Date(inventory.checkedAt).toLocaleString()}${state.inventoryStale?'（已过期）':''}。${inventory.scope}`);
      add(metrics,`Docker：${!inventory.docker.available?'未取得':!inventory.docker.installed?'未安装':inventory.docker.active?'运行中':'未运行'}`);
      if(!inventory.containers.available)add(metrics,'容器清单未取得，不能据此认定容器停止。');
      for(const item of inventory.containers.items)add(metrics,`容器 ${item.name}：${item.state}${item.health?' · '+item.health:''}${item.restarts!==null?' · 重启计数 '+item.restarts:''}${!item.inspected?' · 详细状态未取得':''}`);
      if(!inventory.websites.available)add(metrics,'站点清单未取得。');
      for(const item of inventory.websites.items)add(metrics,`站点 ${item.domain}：${item.state} · ${item.probe?.http?'入口 HTTP '+item.probe.http:item.probe?.code||'入口未检查'}${item.certificate?' · 绑定证书'+(item.certificate.available?'剩余 '+item.certificate.daysRemaining+' 天':'有效期未取得'):''}`);
    }else add(metrics,state.settings.resourceFocus?'资源监控模式：安全、容器和站点检查已暂停，正常和恢复是否通知以开关为准。':'全机容器和站点清单尚未取得，请勿将单项资源正常当成全面健康。');
    if(inventory?.security){
      add(metrics,'安全配置检查：'+inventory.security.interpretation);
      for(const finding of inventory.security.findings)add(metrics,`${finding.severity==='high'?'高风险':'待加固'}：${finding.title}。${finding.evidence}`);
      if(!inventory.security.findings.length)add(metrics,'本轮没有命中已配置的安全风险规则。');
      add(metrics,'尚未验证：'+inventory.security.limitations.join('；'));
    }
    if(state.traffic){
      if(state.traffic.today)add(metrics,`今日已记录入站 ${(state.traffic.today.received/1e9).toFixed(3)} GB · 出站 ${(state.traffic.today.sent/1e9).toFixed(3)} GB · 覆盖约 ${Math.round(state.traffic.today.seconds/60)} 分钟`);
      if(state.traffic.month?.sent!=null)add(metrics,`当月已记录入站 ${((state.traffic.month?.received||0)/1e9).toFixed(3)} GB · 出站 ${(state.traffic.month.sent/1e9).toFixed(3)} GB`);
      add(metrics,state.traffic.scope);
    }
    add(metrics,state.expiry?.configured?`服务器到期日：${state.expiry.date} · ${state.expiry.daysRemaining>=0?'剩余 '+state.expiry.daysRemaining+' 天':'已超过登记日期 '+(-state.expiry.daysRemaining)+' 天'}（以云厂商实际账单为准）`:'尚未填写服务器到期日，续费提醒未启用。');
    if(state.tokenPolicy)add(metrics,`监控模型调用：${state.tokenPolicy.mode==='rules-only'?'规则模式，巡检和通知不调用模型':'仅异常可用AI，每天最多2次'} · 本策略今日已登记 ${state.tokenPolicy.aiCallsToday} 次。${state.tokenPolicy.scope}`);
    const incidents = $('server-monitor-incidents');incidents.replaceChildren();
    for (const incident of state.incidents) add(incidents, `待关注：${incident.lastValue} · 始于 ${new Date(incident.startedAt).toLocaleString()}`);
    if (!editing) {
      $('server-monitor-enabled').checked = state.settings.enabled;
      $('server-monitor-resource-focus').checked=state.settings.resourceFocus;
      $('server-monitor-recovery').checked=state.settings.recoveryNotifications;
      $('server-monitor-expires').value=state.settings.expiresOn||'';
      $('server-monitor-expiry-days').value=state.settings.expiryWarningDays;
      $('server-monitor-ai').checked=state.settings.aiReports;$('server-monitor-summary').checked=state.settings.summaryEnabled;
      for (const [id, key] of [['interval', 'intervalSeconds'], ['count', 'consecutiveSamples'], ['cpu', 'cpu'], ['memory', 'memory'], ['disk', 'disk'],['inventory-interval','inventoryIntervalSeconds'],['summary-hours','summaryHours'],['traffic-mbps','trafficMbps'],['daily-gb','dailyTrafficGB'],['monthly-gb','monthlyTrafficGB']]) $('server-monitor-' + id).value = state.settings[key];
    }
  }
  async function load() { try { render(await api()); } catch (error) { message(error.message); } }
  panel.addEventListener('toggle', () => { if (panel.open) void load(); });
  $('server-monitor-form').addEventListener('input', () => { editing = true; });
  $('server-monitor-form').addEventListener('submit', async event => {
    event.preventDefault();const button = event.submitter;button.disabled = true;
    try {
      const value = { enabled: $('server-monitor-enabled').checked,aiReports:$('server-monitor-ai').checked,summaryEnabled:$('server-monitor-summary').checked };
      Object.assign(value,{resourceFocus:$('server-monitor-resource-focus').checked,recoveryNotifications:$('server-monitor-recovery').checked,expiresOn:$('server-monitor-expires').value,expiryWarningDays:Number($('server-monitor-expiry-days').value)});
      for (const [id, key] of [['interval', 'intervalSeconds'], ['count', 'consecutiveSamples'], ['cpu', 'cpu'], ['memory', 'memory'], ['disk', 'disk'],['inventory-interval','inventoryIntervalSeconds'],['summary-hours','summaryHours'],['traffic-mbps','trafficMbps'],['daily-gb','dailyTrafficGB'],['monthly-gb','monthlyTrafficGB']]) value[key] = Number($('server-monitor-' + id).value);
      const state = await api('/settings', value);editing = false;render(state);message('设置已保存。');
    } catch (error) { message(error.message); } finally { button.disabled = false; }
  });
  $('server-monitor-check').addEventListener('click', async event => {
    const button = event.currentTarget;button.disabled = true;
    try { render(await api('/check', {}));message('本次检查已结束，以采样状态为准。'); }
    catch (error) { message(error.message); } finally { button.disabled = false; }
  });
  setInterval(() => { if (panel.open) void load(); }, 15000);
})();
