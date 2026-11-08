/* Required markup contract: #file-operations-section contains #fo-status,
 * #fo-root, #fo-mode (rename|move|dedupe), #fo-source, #fo-destination,
 * #fo-preview, #fo-commit, #fo-cancel, #fo-undo, #fo-reconcile and #fo-plan. */
'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const section = byId('file-operations-section'); if (!section) return;
  const state = { planId: null, busy: false, plan: null };
  const status = text => { byId('fo-status').textContent = text || ''; };
  const button = (id, enabled) => { const el = byId(id); if (el) el.disabled = !enabled || state.busy; };
  const request = async (url, payload) => {
    const response = await fetch(url, { ...(payload ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(8000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '文件操作请求失败'); return data;
  };
  const syncButtons = () => {
    const plan = state.plan, planExists = !!plan?.id;
    button('fo-commit', planExists && plan.status === 'previewed');
    button('fo-cancel', planExists && plan.status === 'previewed');
    button('fo-undo', planExists && plan.status === 'committed');
    button('fo-reconcile', planExists && ['committing', 'undoing', 'needs-reconciliation'].includes(plan.status));
    button('fo-preview', true);
  };
  const render = plan => {
    state.planId = plan?.id || null; state.plan = plan || null;
    const out = byId('fo-plan'); out.replaceChildren();
    for (const item of plan?.items || []) {
      const row = document.createElement('li');
      row.textContent = `${item.kind}: ${item.source} → ${item.destination} · ${item.size} 字节 · SHA-256 ${item.hash} · ${item.status}`;
      out.append(row);
    }
    for (const item of plan?.duplicateCandidates || []) {
      const row = document.createElement('li'); row.textContent = `内容重复：保留 ${item.kept}；候选 ${item.duplicate} · SHA-256 ${item.hash}`; out.append(row);
    }
    byId('fo-plan-id').textContent = plan?.id ? `计划 ${plan.id} · ${plan.status}` : plan?.status === 'report-only' ? '重复文件报告（没有文件改动）' : '';
    syncButtons();
  };
  const run = async action => {
    state.busy = true; for (const id of ['fo-preview','fo-commit','fo-cancel','fo-undo','fo-reconcile']) button(id, true);
    try {
      let plan;
      if (action === 'preview') {
        const root = byId('fo-root').value, mode = byId('fo-mode').value, sources = byId('fo-source').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean), to = byId('fo-destination').value.trim();
        if (!root || !sources.length || (mode !== 'dedupe' && (!to || sources.length !== 1))) throw new Error('请选择操作目录并填写源文件及目标路径；重命名或移动每次处理一个源文件');
        const operations = mode === 'dedupe' ? sources.map(from => ({ from })) : [{ type: mode, from: sources[0], to }];
        if (mode === 'dedupe' && sources.length < 2) throw new Error('请在源文件框中每行填写一个候选文件路径');
        plan = await request('/api/file-operations/preview', { root, dedupe: mode === 'dedupe', operations });
      } else {
        if (!state.planId) throw new Error('请先预览文件变更');
        if (!window.confirm(action === 'commit' ? '确认按预览执行文件移动或重命名？' : action === 'cancel' ? '取消这个尚未执行的预览？不会修改任何文件。' : action === 'undo' ? '确认撤销此计划？撤销前会再次核对文件内容。' : '确认核对并恢复此计划状态？')) return;
        plan = await request(`/api/file-operations/${encodeURIComponent(state.planId)}/${action}`, { confirmed: true });
      }
      render(plan); status(plan.status === 'report-only' ? '已生成重复文件报告，未修改文件。' : plan.status === 'cancelled' ? '计划已取消，未修改任何文件。' : `文件计划状态：${plan.status}`);
    } catch (error) { status(error.message); }
    finally { state.busy = false; syncButtons(); }
  };
  byId('fo-preview').addEventListener('click', () => void run('preview'));
  for (const action of ['commit','cancel','undo','reconcile']) byId(`fo-${action}`).addEventListener('click', () => void run(action));
  byId('fo-mode').addEventListener('change', () => { const dedupe = byId('fo-mode').value === 'dedupe'; byId('fo-destination').disabled = dedupe; });
  void request('/api/file-operations').then(data => {
    const roots=data.allowedRoots || [], input=byId('fo-root');
    input.placeholder=roots.length ? `${roots[0]} 内的独立子目录绝对路径` : '没有配置可管理目录';
    status(roots.length ? `仅可在所选目录内的现有文件夹整理；不会创建目录。附件接收与归档目录受保护。` : '没有配置可管理的运行时目录。');
  }).catch(error => status(error.message));
})();
