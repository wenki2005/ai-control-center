import { monitorFetch } from './server-monitor-network.mjs';
import { collectSecurityPosture } from './server-monitor-security.mjs';

const safe = (value, max = 160) => String(value || '').replace(/[\r\n]/g, ' ').slice(0, max);
const envelope = response => response.ok && response.value?.code === 200;
async function paged(read, path, extra = {}) {
  const items = [];let total = 0;
  for (let page = 1; page <= 20; page++) {
    const response = await read(path, { page, pageSize: 100, ...extra });
    if (!envelope(response)) return { available: false, code: response.code || 'PANEL_REJECTED', items: [], total: null };
    const data = response.value.data;if (!Array.isArray(data?.items)) return { available: false, code: 'INVALID_INVENTORY', items: [], total: null };
    items.push(...data.items);total = Number(data.total ?? items.length);
    if (items.length >= total || !data.items.length) break;
  }
  return { available: true, items, total, truncated: items.length < total };
}

export async function collectServerInventory(read, connection = {}) {
  const [containers, sitesResponse, dockerResponse] = await Promise.all([
    paged(read, '/containers/search', { name: '', state: 'all', orderBy: 'name', order: 'ascending' }),
    read('/websites/list'), read('/containers/docker/status')
  ]);
  const records = [];
  if (containers.available) {
    // Inspect is read-only. Never persist environment variables, mounted file
    // contents or private keys from the response: retain only runtime state.
    for (let offset = 0; offset < containers.items.length; offset += 3) {
      const group = await Promise.all(containers.items.slice(offset, offset + 3).map(async item => {
        const response = await read('/containers/inspect', { id: item.containerID, type: 'container', detail: '' });
        let detail = envelope(response) ? response.value.data : null;
        try { if (typeof detail === 'string') detail = JSON.parse(detail); } catch { detail = null; }
        if (Array.isArray(detail)) detail = detail[0];
        return { key: safe(item.containerID, 100), name: safe(item.name), state: safe(detail?.State?.Status || item.state, 40),
          health: detail?.State?.Health?.Status ? safe(detail.State.Health.Status, 40) : null,
          restarts: Number.isSafeInteger(detail?.RestartCount) ? detail.RestartCount : null,
          oomKilled: typeof detail?.State?.OOMKilled === 'boolean' ? detail.State.OOMKilled : null,
          security:detail?.HostConfig?{privileged:detail.HostConfig.Privileged===true,
            ports:Object.entries(detail.NetworkSettings?.Ports||{}).flatMap(([port,bindings])=>(bindings||[]).map(b=>({containerPort:Number(port.split('/')[0]),address:safe(b.HostIp,60),port:Number(b.HostPort)}))),
            riskyMounts:(detail.Mounts||[]).filter(m=>m.Source==='/'||String(m.Source||'').includes('docker.sock')).map(m=>safe(m.Source,100))}:null,
          inspected: !!detail?.State };
      }));records.push(...group);
    }
  }
  const websitesAvailable = envelope(sitesResponse) && Array.isArray(sitesResponse.value.data);
  const websites = websitesAvailable ? sitesResponse.value.data.map(site => {
    const tls = String(site.protocol || '').toUpperCase() === 'HTTPS';
    const expiry = tls && site.webSiteSSLId ? Date.parse(site.webSiteSSL?.expireDate) : NaN;
    return { key: String(site.id), domain: safe(site.primaryDomain), state: safe(site.status, 40), protocol: tls ? 'HTTPS' : 'HTTP',
      certificate: tls ? { available: Number.isFinite(expiry), expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
        daysRemaining: Number.isFinite(expiry) ? Math.floor((expiry - Date.now()) / 86400000) : null } : null };
  }) : [];
  // Probe registered public sites without credentials; a 401/403 still proves
  // reachability, not business health. Do not follow links or redirects.
  for (let offset = 0; offset < websites.length; offset += 3) await Promise.all(websites.slice(offset, offset + 3).map(async site => {
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(site.domain) || /\.(?:local|localhost|internal)$/i.test(site.domain)) { site.probe = { available: false, reason: 'unsupported_domain' };return; }
    try {
      const response = await monitorFetch(new URL((site.protocol === 'HTTPS' ? 'https://' : 'http://') + site.domain + '/'), {
        signal: AbortSignal.timeout(10000), monitorPublicOnly: true
      });
      await response.body?.cancel();site.probe = { available: true, reachable: response.status < 500, http: response.status };
    } catch (error) { site.probe = { available: true, reachable: false, code: safe(error.cause?.code || error.code || error.name, 60) }; }
  }));
  const docker = envelope(dockerResponse) ? { available: true, active: dockerResponse.value.data?.isActive === true,
    installed: dockerResponse.value.data?.isExist === true } : { available: false, code: dockerResponse.code || 'PANEL_REJECTED' };
  const security=await collectSecurityPosture(read,connection,records);
  return { checkedAt: new Date().toISOString(), docker,security,
    containers: { available: containers.available, total: containers.total, truncated: containers.truncated || false, code: containers.code || null, items: records },
    websites: { available: websitesAvailable, code: websitesAvailable ? null : sitesResponse.code || 'PANEL_REJECTED', items: websites },
    scope: '主机资源、Docker及全部可枚举容器、1Panel登记站点及其实际绑定证书；HTTP可达不等于业务健康，容器运行不等于数据库内部查询通过。' };
}
