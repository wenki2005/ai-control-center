const ok = value => value.ok && value.value?.code === 200;
const yes = value => value === true || /^(?:yes|true|on)$/i.test(String(value));
export async function collectSecurityPosture(read, connection, containers) {
  const [firewall, ssh] = await Promise.all([read('/hosts/firewall/settings'), read('/hosts/ssh/search', {})]);
  const findings = [];
  const add = (key, severity, title, evidence, action) => findings.push({ key, severity, title, evidence, action });
  if (connection.baseUrl && new URL(connection.baseUrl).protocol !== 'https:') add('panel-http', 'medium', '面板 API 连接未加密', '中枢当前通过 HTTP 连接面板；不能保证传输保密。', '先准备并验证 HTTPS 或加密隧道，再迁移连接与轮换密钥。');
  const f = ok(firewall) ? firewall.value.data : null;
  const system = f?.system?.options?.find(x => x.name === (f.system.current || f.system.selected));
  if (system && system.active === false) add('host-firewall', 'medium', '面板管理的主机防火墙未激活', `当前${system.name}未激活；Docker规则和云安全组是独立层，尚不能据此认定整机无防护。`, '核对云安全组、实际防火墙规则与管理入口，形成端口白名单后再启用。');
  const s = ok(ssh) ? ssh.value.data : null;
  if (s?.isActive && yes(s.passwordAuthentication) && yes(s.permitRootLogin)) add('ssh-root-password', 'high', 'SSH 允许 root 密码登录', '面板读取到密码认证与root直接登录均启用；未据此认定已遭入侵。', '保留可用恢复通道，先验证密钥及sudo账号，再限制root密码登录。');
  for (const item of containers) {
    const flags = item.security;if (!flags) continue;
    if (flags.privileged) add('privileged:' + item.key, 'high', `容器「${item.name}」使用高权限模式`, 'Docker Privileged=true，容器逃逸后的主机影响更大。', '核对业务所需设备与能力，准备最小权限替代配置。');
    if (flags.riskyMounts.length) add('mount:' + item.key, 'high', `容器「${item.name}」可接触敏感主机接口`, flags.riskyMounts.join('、'), '核对挂载用途，优先移除不必要的主机根目录和Docker控制接口。');
    for (const p of flags.ports) if (['0.0.0.0','::',''].includes(p.address) && [3306,5432,6379,27017,9200,11211,2375].includes(p.containerPort)) {
      add('published:' + item.key + ':' + p.port, 'high', `容器「${item.name}」敏感端口绑定全部网卡`, `容器端口${p.containerPort}发布为主机${p.port}；公网可达性还取决于安全组和防火墙。`, '确认访问来源后，改为回环/内网绑定或严格来源白名单。');
    }
  }
  return { checkedAt: new Date().toISOString(), available: { firewall: !!f, ssh: !!s }, findings,
    firewall: system ? { backend: system.name, active: system.active === true } : null,
    ssh: s ? { active: s.isActive === true, passwordLogin: yes(s.passwordAuthentication), keyLogin: yes(s.pubkeyAuthentication), rootLogin: String(s.permitRootLogin || 'unknown').slice(0, 32) } : null,
    limitations: ['未执行入侵取证或恶意软件扫描','未核实云安全组与所有宿主机监听端口','未执行依赖/CVE与业务鉴权审计','未验证备份可恢复性'],
    interpretation: '这是规则式安全配置检查；没有命中规则不等于服务器绝对安全。' };
}
