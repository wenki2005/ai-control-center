import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { persistNamedRequest } from './report-delivery.mjs';
import { monitorFetch } from './server-monitor-network.mjs';
import { collectServerInventory } from './server-monitor-inventory.mjs';

const DEFAULTS = { enabled: true, intervalSeconds: 60, consecutiveSamples: 3, recoverySamples: 2,
  cooldownMinutes: 360, cpu: 85, memory: 85, disk: 85, load: 100, inventoryIntervalSeconds: 600, summaryHours: 24, certificateDays: 14,
  summaryEnabled:false,aiReports:false,trafficMbps:100,dailyTrafficGB:0,monthlyTrafficGB:0,
  resourceFocus:true,recoveryNotifications:false,expiresOn:'',expiryWarningDays:30 };
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const round = value => value === null ? null : Math.round(value * 10) / 10;
function parse(value, fallback) { try { return JSON.parse(value || '') ?? fallback; } catch { return fallback; } }
const localTime = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) + '（上海时间）';
async function readJson(url, headers, fetchImpl, body) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: {...headers,...(body?{'content-type':'application/json'}:{})}, method:body?'POST':'GET', body:body?JSON.stringify(body):undefined, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) {
        last = { ok: false, http: response.status, code: 'HTTP_' + response.status, attempts: attempt };
        if (attempt === 1 && [502, 503, 504].includes(response.status)) { await response.body?.cancel();await new Promise(r => setTimeout(r, 600));continue; }
        await response.body?.cancel();return last;
      }
      const text = await response.text();if (text.length > 200000) return { ok: false, http: response.status, code: 'RESPONSE_TOO_LARGE', attempts: attempt };
      try { return { ok: true, http: response.status, value: JSON.parse(text), attempts: attempt, dns:response.monitorDns||null }; }
      catch { return { ok: false, http: response.status, code: 'INVALID_JSON', attempts: attempt }; }
    } catch (error) {
      const code = error.cause?.code || error.code || (error.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR');
      last = { ok: false, http: null, code: /^[A-Z0-9_]{1,60}$/.test(String(code)) ? String(code) : 'TRANSPORT_ERROR', attempts: attempt };
      if (attempt === 1) await new Promise(r => setTimeout(r, 600));
    }
  }
  return last;
}

export async function readPanelSnapshot(connection, fetchImpl = monitorFetch) {
  const base = new URL(connection.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !connection.apiKey) throw Error('本机 1Panel 连接配置不完整');
  const version = connection.apiVersion === 'v1' ? 'v1' : 'v2';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = createHash('md5').update('1panel' + connection.apiKey + timestamp).digest('hex');
  // Probe these independently: failure of the management channel does not
  // prevent checking the public application's health on the same sample.
  const [panel, health] = await Promise.all([
    readJson(new URL(`/api/${version}/dashboard/current/all/${encodeURIComponent(connection.networkInterface||'all')}`, base), { '1Panel-Token': token, '1Panel-Timestamp': timestamp }, fetchImpl),
    connection.healthUrl ? readJson(new URL(connection.healthUrl), {}, fetchImpl) : Promise.resolve(null)
  ]);
  const value = panel.value;
  if (panel.ok && (value?.code !== 200 || !value?.data || typeof value.data !== 'object')) { panel.ok = false;panel.code = 'PANEL_REJECTED'; }
  const d = panel.ok ? value.data : {};
  const cpu = number(d.cpuUsedPercent), memory = number(d.memoryUsedPercent);
  if (panel.ok && (cpu === null || memory === null)) { panel.ok = false;panel.code = 'MISSING_METRICS'; }
  const disks = Array.isArray(d.diskData) ? d.diskData.filter(x => number(x.usedPercent) !== null).slice(0, 64)
    .map(x => ({ path: String(x.path || '未知挂载点').slice(0, 160), percent: round(number(x.usedPercent)), freeBytes:number(x.free),totalBytes:number(x.total),inodes:round(number(x.inodesUsedPercent)) })) : [];
  const snapshot = { cpu: round(cpu), memory: round(memory), load: round(number(d.loadUsagePercent)),
    disks, host:{uptimeSeconds:number(d.uptime),processes:number(d.procs),swapPercent:number(d.swapMemoryUsedPercent),networkInterface:connection.networkInterface||'all',networkReceivedBytes:number(d.netBytesRecv),networkSentBytes:number(d.netBytesSent),ioReadBytes:number(d.ioReadBytes),ioWriteBytes:number(d.ioWriteBytes)},
    panel: { healthy: panel.ok, http: panel.http, code: panel.code || null, attempts: panel.attempts, dns:panel.dns||null,
      error: panel.ok ? null : `1Panel 指标读取未成功（${panel.code}）` },
    app: { configured: !!connection.healthUrl, healthy: health ? health.ok && health.value?.status === 'ok' : null,
      http: health?.http || null, code: health ? health.ok ? health.value?.status === 'ok' ? null : 'UNHEALTHY_RESPONSE' : health.code : null } };
  return snapshot;
}

export class ServerMonitor {
  constructor({ store, reports, hub, persona=()=>({}), runtime, onChange = () => {}, fetchImpl = monitorFetch }) {
    Object.assign(this, { store, reports, hub, persona, onChange, fetchImpl });
    this.connectionFile = join(runtime, 'server-monitor-connection.json');
    this.busy = false;this.closed = false;this.nextAt = 0;
    this.inventory=parse(store.meta('server-monitor:inventory'),null);this.nextInventory=0;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS server_monitor_incidents(
      metric TEXT PRIMARY KEY,bad INTEGER NOT NULL DEFAULT 0,good INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0,startedAt TEXT,lastNoticeAt TEXT,episode TEXT,lastValue TEXT,updatedAt TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS server_monitor_samples(id INTEGER PRIMARY KEY,checkedAt TEXT NOT NULL,panelOk INTEGER NOT NULL,errorCode TEXT,attempts INTEGER NOT NULL,applicationOk INTEGER,snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS server_monitor_traffic(day TEXT PRIMARY KEY,received REAL NOT NULL,sent REAL NOT NULL,seconds REAL NOT NULL,samples INTEGER NOT NULL)`);
  }
  settings() { return { ...DEFAULTS, ...parse(this.store.meta('server-monitor:settings'), {}) }; }
  connection() { return JSON.parse(readFileSync(this.connectionFile, 'utf8')); }
  state() {
    let configured = false, label = '服务器';try { const c = this.connection();configured = !!c.baseUrl && !!c.apiKey;label = String(c.label || label).slice(0, 100); } catch {}
    const settings = this.settings(), last = parse(this.store.meta('server-monitor:last'), null);
    return { configured, label, scope:'whole-server',settings, busy: this.busy, last,inventory:this.inventory,traffic:this.traffic(),
      tokenPolicy:{mode:settings.aiReports?'bounded-ai-alerts':'rules-only',maxAiCallsPerDay:2,aiCallsToday:Number(this.store.meta('server-monitor:ai-count:'+this.day()))||0,routineModelCalls:0,scope:'仅本省Token策略登记的调用，不包含升级前和中枢其他功能。'},
      inventoryStale:!this.inventory||Date.now()-Date.parse(this.inventory.checkedAt)>settings.inventoryIntervalSeconds*3000,
      stale: !last || Date.now() - Date.parse(last.checkedAt) > Math.max(180000, settings.intervalSeconds * 3000),
      expiry:{configured:!!settings.expiresOn,date:settings.expiresOn||null,daysRemaining:settings.expiresOn?this.expiryDays(settings.expiresOn):null},
      incidents: this.store.db.prepare('SELECT metric,startedAt,lastNoticeAt,lastValue FROM server_monitor_incidents WHERE active=1').all().filter(row=>this.metricEnabled(row.metric,settings)),
      status: !configured ? 'unconfigured' : !settings.enabled ? 'paused' : !last ? 'waiting' : last.error ? 'connection_error' : 'monitoring' };
  }
  configure(input = {}) {
    const next = this.settings();
    for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw Error('未知巡检设置');
    for(const key of ['enabled','summaryEnabled','aiReports','resourceFocus','recoveryNotifications'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')throw Error('开关状态无效');next[key]=input[key];}
    if(input.expiresOn!==undefined){
      const value=input.expiresOn;
      if(typeof value!=='string'||(value!==''&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)))throw Error('服务器到期日无效，请填写真实的年月日');
      next.expiresOn=value;
    }
    const ranges = { intervalSeconds: [30, 3600], consecutiveSamples: [1, 10], recoverySamples: [1, 10], cooldownMinutes: [5, 1440], cpu: [30, 100], memory: [30, 100], disk: [30, 100], load: [50, 500], inventoryIntervalSeconds:[60,3600],summaryHours:[1,24],certificateDays:[1,90],trafficMbps:[1,100000],dailyTrafficGB:[0,1000000],monthlyTrafficGB:[0,10000000] };
    ranges.expiryWarningDays=[1,90];
    for (const [key, [min, max]] of Object.entries(ranges)) if (input[key] !== undefined) {
      if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw Error(`${key} 设置不在允许范围内`);
      next[key] = input[key];
    }
    this.store.meta('server-monitor:settings', JSON.stringify(next));this.nextAt = 0;this.nextInventory=0;this.onChange();return this.state();
  }
  metricEnabled(metric,settings=this.settings()){
    return !settings.resourceFocus||metric==='connection'||metric==='memory'||metric.startsWith('disk:')||metric.startsWith('traffic-');
  }
  expiryDays(date){return Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(this.day()+'T00:00:00Z'))/86400000);}
  checkExpiry(settings){
    if(!settings.expiresOn)return;
    const days=this.expiryDays(settings.expiresOn);
    if(days>settings.expiryWarningDays)return;
    const stage=days<=0?0:days<=1?1:days<=7?Math.min(7,settings.expiryWarningDays):settings.expiryWarningDays;
    const label=String(this.connection().label||'服务器').slice(0,100);
    this.publishNotice({key:`server-monitor:expiry:${settings.expiresOn}:${stage}`,task:{id:'server-expiry-'+randomUUID(),engine:'1panel',role:'server-monitor',status:'failed',prompt:`${label}到期提醒`,result:`登记的服务器到期日是 ${settings.expiresOn}（上海日期），${days>0?'还剩 '+days+' 天':days===0?'今天到期':'已超过登记日期 '+(-days)+' 天'}。请核对云厂商续费页面；续费后更新这里的到期日。`,updatedAt:this.store.now()},situation:''});
  }
  day(date=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
  traffic(){
    const day=this.day(),today=this.store.db.prepare('SELECT * FROM server_monitor_traffic WHERE day=?').get(day)||null;
    const month=this.store.db.prepare('SELECT sum(received) received,sum(sent) sent,sum(seconds) seconds FROM server_monitor_traffic WHERE substr(day,1,7)=?').get(day.slice(0,7));
    return {today,month,scope:'仅已采集网卡计数增量，跳过断线/重启/计数重置；不是云厂商账单，启用前及离线期间未统计。'};
  }
  recordTraffic(previous,current,at,settings){
    const old=previous?.snapshot?.host,now=current?.host,seconds=(Date.parse(at)-Date.parse(previous?.checkedAt))/1000;
    if(!old||!now||!previous?.snapshot?.panel?.healthy||!current.panel.healthy||old.networkInterface!==now.networkInterface||!(seconds>0&&seconds<=settings.intervalSeconds*3))return;
    if(old.uptimeSeconds!==null&&now.uptimeSeconds!==null&&now.uptimeSeconds<old.uptimeSeconds)return;
    if([old.networkReceivedBytes,old.networkSentBytes,now.networkReceivedBytes,now.networkSentBytes].some(x=>x===null||x===undefined))return;
    const incoming=now.networkReceivedBytes-old.networkReceivedBytes,outgoing=now.networkSentBytes-old.networkSentBytes;
    if(incoming<0||outgoing<0)return;
    now.receiveMbps=round(incoming*8/seconds/1e6);now.sendMbps=round(outgoing*8/seconds/1e6);
    this.store.db.prepare(`INSERT INTO server_monitor_traffic VALUES(?,?,?,?,1) ON CONFLICT(day) DO UPDATE SET received=received+excluded.received,sent=sent+excluded.sent,seconds=seconds+excluded.seconds,samples=samples+1`).run(this.day(new Date(at)),incoming,outgoing,seconds);
    this.incident('traffic-rate',now.sendMbps>=settings.trafficMbps,now.sendMbps<settings.trafficMbps*0.8,`已采集出口速率 ${now.sendMbps} Mbps，参考线 ${settings.trafficMbps} Mbps；业务下载或备份也可能造成，未判定为攻击`,settings);
    const traffic=this.traffic();
    for(const [key,total,limit]of [['daily',traffic.today,settings.dailyTrafficGB],['monthly',traffic.month,settings.monthlyTrafficGB]])if(total&&limit>0){
      const gb=(total.sent||0)/1e9;this.incident('traffic-budget:'+key,gb>=limit,gb<limit*0.9,`${key==='daily'?'当天':'当月'}已记录出口 ${round(gb)} GB，提醒线 ${limit} GB；不是云厂商账单`,settings);
    }
  }
  publishNotice({key,task,situation,allowAi=false}){
    if(this.store.db.prepare('SELECT 1 FROM outbox WHERE dedupe=?').get(key)||this.store.db.prepare('SELECT 1 FROM report_requests WHERE key=?').get(key))return;
    const settings=this.settings(),counter='server-monitor:ai-count:'+this.day(),count=Number(this.store.meta(counter))||0;
    if(allowAi&&settings.aiReports&&count<2){
      persistNamedRequest(this.store,{key,task,kind:'server-monitor',artifacts:[],situation});this.store.meta(counter,String(count+1));
      queueMicrotask(()=>this.reports.wakeAnnouncementWorker());return;
    }
    const address=String(this.persona()?.address||'').slice(0,24);
    const text=(address?address+'，':'')+task.prompt+'\n'+task.result;
    this.store.enqueue(text.slice(0,1700),key);this.hub?.say?.(text.slice(0,1700),{source:'server-monitor'});
    queueMicrotask(()=>{void this.hub?.notify?.();});
  }
  incident(metric, bad, healthy, value, settings) {
    return this.store.transaction(() => this.updateIncident(metric, bad, healthy, value, settings));
  }
  updateIncident(metric, bad, healthy, value, settings) {
    if(!this.metricEnabled(metric,settings))return;
    const now = this.store.now();
    const previous = this.store.db.prepare('SELECT * FROM server_monitor_incidents WHERE metric=?').get(metric);
    const row = previous || { metric, bad: 0, good: 0, active: 0, startedAt: null, lastNoticeAt: null, episode: null };
    row.bad = bad ? row.bad + 1 : 0;row.good = healthy ? row.good + 1 : 0;
    if (bad && !row.startedAt) row.startedAt = now;
    let kind = null;
    if (bad && row.bad >= settings.consecutiveSamples && (!row.active || !row.lastNoticeAt || Date.now() - Date.parse(row.lastNoticeAt) >= settings.cooldownMinutes * 60000)) {
      if (!row.active) row.episode = randomUUID();row.active = 1;kind = 'warning';
    } else if (healthy && row.active && row.good >= settings.recoverySamples) { row.active = 0;kind = 'recovered'; }
    if (kind && (kind!=='recovered'||settings.recoveryNotifications)) {
      const connection = this.connection(), label = String(connection.label || '服务器').slice(0, 100);
      const key = `server-monitor:${row.episode}:${kind}:${kind === 'warning' ? row.lastNoticeAt || 'first' : 'end'}`;
      const task = { id: 'server-notice-' + randomUUID(), engine: '1panel', role: 'server-monitor', status: kind === 'warning' ? 'failed' : 'completed',
        prompt: `${label}只读巡检${kind === 'warning' ? '预警' : '恢复通知'}`, result: `${localTime(now)}；${value}。${kind === 'warning' ? `连续${row.bad}次采样异常，首次发现于${localTime(row.startedAt)}。` : `连续${row.good}次采样恢复到正常范围。仅表示这个检查项恢复。`}后台仍按设置持续巡检。`, updatedAt: now };
      this.publishNotice({ key, task, allowAi:kind==='warning', situation:
        '这是服务器只读巡检的真实指标。用当前人设简短说明本项异常或恢复。所有时间按已格式化的上海时间，不把UTC当本地时间。仅凭连续失败不能断言不是偶发抖动，不能猜测根因或情绪化放大风险。后台已经持续监督，不再问要不要继续盯；仅确实需要额外操作时再询问。不派单、不发附件、不展示编号。' });
      row.lastNoticeAt = now;
    }
    if (!bad && !row.active) { row.startedAt = null;row.bad = 0; }
    this.store.db.prepare(`INSERT OR REPLACE INTO server_monitor_incidents(metric,bad,good,active,startedAt,lastNoticeAt,episode,lastValue,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(metric, row.bad, row.good, row.active, row.startedAt, row.lastNoticeAt, row.episode, value, now);
  }
  async tick({ force = false } = {}) {
    if (this.closed || this.busy || !existsSync(this.connectionFile)) return this.state();
    const settings = this.settings();if (!settings.enabled || (!force && Date.now() < this.nextAt)) return this.state();
    this.busy = true;this.nextAt = Date.now() + settings.intervalSeconds * 1000;
    try {
      this.checkExpiry(settings);
      let snapshot, error = null;
      const previous=parse(this.store.meta('server-monitor:last'),null);
      try { snapshot = await readPanelSnapshot(this.connection(), this.fetchImpl);error = snapshot.panel.error; }
      catch (err) { error = /^(?:1Panel|本机)/.test(err.message) ? err.message.slice(0, 140) : '1Panel 连接失败，暂时无法取得指标'; }
      const checkedAt = this.store.now();
      this.recordTraffic(previous,snapshot,checkedAt,settings);
      this.store.meta('server-monitor:last', JSON.stringify({ checkedAt, snapshot: snapshot || null, error }));
      this.store.db.prepare('INSERT INTO server_monitor_samples(checkedAt,panelOk,errorCode,attempts,applicationOk,snapshot) VALUES(?,?,?,?,?,?)').run(checkedAt,error?0:1,snapshot?.panel.code || (error?'CONFIG_ERROR':null),snapshot?.panel.attempts || 0,snapshot?.app.healthy===null||!snapshot?null:snapshot.app.healthy?1:0,JSON.stringify(snapshot || {}));
      this.store.db.prepare('DELETE FROM server_monitor_samples WHERE checkedAt<?').run(new Date(Date.now()-30*86400000).toISOString());
      const appNote = snapshot?.app.configured ? snapshot.app.healthy ? '；独立检查的应用健康接口正常' : '；应用健康检查也未成功，原因需另查' : '';
      this.incident('connection', !!error, !error, (error || '1Panel 指标读取恢复') + appNote, settings.resourceFocus?{...settings,consecutiveSamples:Math.max(settings.consecutiveSamples,Math.ceil(900/settings.intervalSeconds))}:settings);
      if (snapshot) {
        for (const [key, label] of [['cpu', 'CPU'], ['memory', '内存'], ['load', '负载']]) {
          const value = snapshot[key];if (value === null) continue;
          this.incident(key, value >= settings[key], value <= settings[key] - 5, `${label}使用率 ${value}%（预警阈值 ${settings[key]}%）`, settings);
        }
        for (const disk of snapshot.disks) this.incident('disk:' + disk.path, disk.percent >= settings.disk, disk.percent <= settings.disk - 5,
          `磁盘 ${disk.path} 使用率 ${disk.percent}%（预警阈值 ${settings.disk}%）${disk.freeBytes!==null?'，可用 '+round(disk.freeBytes/1e9)+' GB':''}`, settings);
        if (snapshot.app.configured) this.incident('application', snapshot.app.healthy === false, snapshot.app.healthy === true,
          snapshot.app.healthy ? '背单词应用健康接口恢复正常' : `背单词应用健康检查失败${snapshot.app.http ? '（HTTP ' + snapshot.app.http + '）' : '（未取得有效响应）'}`, settings);
        if(!settings.resourceFocus && snapshot.panel.healthy && (force||Date.now()>=this.nextInventory))await this.inspectServer(settings);
      }
      this.onChange();
    } finally { this.busy = false; }
    return this.state();
  }
  async inspectServer(settings) {
    this.nextInventory=Date.now()+settings.inventoryIntervalSeconds*1000;
    const c=this.connection(),version=c.apiVersion==='v1'?'v1':'v2';
    const read=(path,body)=>{const time=String(Math.floor(Date.now()/1000));return readJson(new URL(`/api/${version}`+path,c.baseUrl),{'1Panel-Token':createHash('md5').update('1panel'+c.apiKey+time).digest('hex'),'1Panel-Timestamp':time},this.fetchImpl,body);};
    const previous=this.inventory;
    this.inventory=await collectServerInventory(read,c);this.store.meta('server-monitor:inventory',JSON.stringify(this.inventory));
    const inv=this.inventory;
    this.incident('coverage:containers',!inv.containers.available,inv.containers.available,inv.containers.available?'全服务器容器清单读取恢复':'全服务器容器清单暂不可读；不等于容器停止',settings);
    this.incident('coverage:websites',!inv.websites.available,inv.websites.available,inv.websites.available?'全服务器站点清单读取恢复':'全服务器站点清单暂不可读；不等于站点离线',settings);
    if(inv.docker.available&&inv.docker.installed)this.incident('docker',!inv.docker.active,inv.docker.active,inv.docker.active?'Docker 服务运行中':'Docker 服务未运行',settings);
    if(inv.containers.available)for(const item of inv.containers.items){
      const old=previous?.containers.items.find(x=>x.key===item.key);
      const tracked=this.store.meta('server-monitor:container-active:'+item.key)==='true';
      if(item.state==='running')this.store.meta('server-monitor:container-active:'+item.key,'true');
      const bad=['restarting','dead'].includes(item.state)||item.health==='unhealthy'||(tracked&&['exited','paused','created'].includes(item.state));
      const healthy=item.state==='running'&&item.health!=='unhealthy';
      if(bad||healthy)this.incident('container:'+item.key,bad,healthy,`容器「${item.name}」：${item.state}${item.health?'，健康检查 '+item.health:''}${old&&item.restarts!==null&&old.restarts!==null&&item.restarts>old.restarts?'，重启次数增加 '+(item.restarts-old.restarts):''}`,settings);
    }
    if(inv.websites.available)for(const site of inv.websites.items){
      const running=site.state.toLowerCase()==='running';
      const tracked=this.store.meta('server-monitor:website-active:'+site.key)==='true';
      if(running)this.store.meta('server-monitor:website-active:'+site.key,'true');
      if(running||tracked)this.incident('website:'+site.key,!running,running,`站点「${site.domain}」面板状态：${site.state}`,settings);
      if(site.probe?.available)this.incident('website-http:'+site.key,!site.probe.reachable,site.probe.reachable,`站点「${site.domain}」入口${site.probe.reachable?'可达':'未成功响应'}${site.probe.http?'（HTTP '+site.probe.http+'）':'（'+site.probe.code+'）'}；只代表入口检查`,settings);
      if(site.certificate?.available)this.incident('certificate:'+site.key,site.certificate.daysRemaining<=settings.certificateDays,site.certificate.daysRemaining>settings.certificateDays+2,`站点「${site.domain}」当前绑定证书剩余 ${site.certificate.daysRemaining} 天`,settings);
    }
    const last=Date.parse(this.store.meta('server-monitor:last-overview')||'');
    const security=inv.security;
    for(const finding of security.findings){
      if(finding.severity==='high'||finding.severity==='medium')this.incident('security:'+finding.key,true,false,`安全检查：${finding.title}。${finding.evidence}建议：${finding.action}`,{...settings,consecutiveSamples:finding.severity==='high'?1:settings.consecutiveSamples});
    }
    for(const row of this.store.db.prepare("SELECT metric FROM server_monitor_incidents WHERE metric LIKE 'security:%' AND active=1").all()){
      const key=row.metric.slice(9);if(security.findings.some(x=>x.key===key))continue;
      const covered=key.startsWith('published:')||key.startsWith('mount:')||key.startsWith('privileged:')?inv.containers.available&&!inv.containers.truncated&&inv.containers.items.every(x=>x.inspected):key==='host-firewall'?security.available.firewall:key==='ssh-root-password'?security.available.ssh:key==='panel-http';
      if(covered)this.incident(row.metric,false,true,'之前的安全配置风险本轮未再检出；不等于整机已通过安全审计',settings);
    }
    if(settings.summaryEnabled&&(!Number.isFinite(last)||Date.now()-last>=settings.summaryHours*3600000))this.overview(settings);
  }
  overview(settings) {
    const now=this.store.now(),inv=this.inventory,snapshot=parse(this.store.meta('server-monitor:last'),null)?.snapshot;
    const key='server-monitor:whole-overview:'+Math.floor(Date.now()/(settings.summaryHours*3600000));
    const text=[`${localTime(now)} 全机巡检（覆盖范围：${inv.scope}）`,snapshot?.panel.healthy?`主机CPU ${snapshot.cpu}%，内存 ${snapshot.memory}%，磁盘 ${snapshot.disks.map(x=>x.path+' '+x.percent+'%').join('、')}`:'主机指标未取得',
      inv.containers.available?`容器共${inv.containers.items.length}个，运行${inv.containers.items.filter(x=>x.state==='running').length}个${inv.containers.truncated?'，清单尚未取全':''}`:'容器清单未取得',
      inv.websites.available?`登记站点${inv.websites.items.length}个，入口可达${inv.websites.items.filter(x=>x.probe?.reachable).length}个，其中${inv.websites.items.filter(x=>x.probe?.http>=400&&x.probe.http<500).length}个返回4xx（仅表示收到HTTP响应，需要按具体业务路径判断），绑定的HTTPS证书${inv.websites.items.filter(x=>x.certificate).length}个`:'站点清单未取得',
      `当前持续告警${this.store.db.prepare('SELECT count(*) n FROM server_monitor_incidents WHERE active=1').get().n}项。后台持续巡检，未执行处置。`].join('；');
    this.store.transaction(()=>{this.publishNotice({key,task:{id:'server-overview-'+randomUUID(),engine:'1panel',role:'server-monitor',status:'completed',prompt:'整台云服务器运行概览',result:text,updatedAt:now},situation:''});this.store.meta('server-monitor:last-overview',now);});
  }
  start() {
    this.timer = setInterval(() => { void this.tick().catch(() => { /* A later sample retries without restarting services. */ }); }, 10000);
    this.timer.unref();void this.tick().catch(() => {});
  }
  async close() { this.closed = true;clearInterval(this.timer);while (this.busy) await new Promise(resolve => setTimeout(resolve, 100)); }
}
