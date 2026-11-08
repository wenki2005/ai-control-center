(() => {
  'use strict';

  // All public pages use this one identity/theme projection. Application names
  // remain stable; persona names and portraits follow the active card.
  const identity = (() => {
    let persona={},lastRefresh=0,inflight=null;
    const avatarFile=(value={})=>/^[a-zA-Z0-9_-]+\.(?:png|webp|jpe?g)$/i.test(String(value.avatar||''))?value.avatar:({'AI 助手':'default-avatar.png','AI 助手':'default-avatar.png','AI 助手':'default-avatar.png'}[value.name]||'default-avatar.png');
    const avatarUrl=value=>{const file=avatarFile(value);return file==='default-avatar.png'?'/default-avatar.png':`/persona-avatars/${encodeURIComponent(file)}`;};
    function apply(value={}){
      persona=value;
      const color=/^#[0-9a-f]{6}$/i.test(value.themeColor||'')?value.themeColor:'#5d79b2',style=document.documentElement.style;
      for(const key of ['--blue','--blue-deep','--persona-color','--rc-accent'])style.setProperty(key,color);
      for(const [key,mix]of [['--blue-wash',`${color} 10%, white`],['--paper',`${color} 3%, #f7f8fb`],['--line',`${color} 12%, #eef1f6`],['--persona-glow',`${color} 9%, white`]])style.setProperty(key,`color-mix(in srgb, ${mix})`);
      const page=document.body.dataset.appPage||'';document.title=page?`${page} · AI 中枢`:'AI 中枢';
      let icon=document.querySelector('link[rel="icon"]');if(!icon){icon=document.createElement('link');icon.rel='icon';document.head.append(icon);}icon.href=avatarUrl(value);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content',color);
      for(const label of document.querySelectorAll('[data-persona-name]'))label.textContent=value.name||'当前助手';
      for(const image of document.querySelectorAll('[data-persona-avatar]')){image.src=avatarUrl(value);image.alt=value.name||'当前人设';}
      document.dispatchEvent(new CustomEvent('ai-center-identity',{detail:value}));
    }
    async function refresh(){
      if(Date.now()-lastRefresh<15000)return persona;
      if(inflight)return inflight;
      inflight=(async()=>{const r=await fetch('/api/companion?view=appearance',{credentials:'same-origin',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('读取当前人设失败');const data=await r.json();if(data.persona){apply(data.persona);lastRefresh=Date.now();}return persona;})().finally(()=>{inflight=null;});return inflight;
    }
    return {applicationName:'AI 中枢',apply,refresh,avatarFile,avatarUrl,get persona(){return persona;},get name(){return persona.name||'当前助手';}};
  })();
  window.aiCenterIdentity=identity;
  if(!document.querySelector('#chat-form')){void identity.refresh().catch(()=>{});return;}

  try { history.scrollRestoration = 'manual'; } catch { /* The embedded view may lock scroll restoration. */ }
  const resetDocumentScroll = () => window.scrollTo(0, 0);
  resetDocumentScroll();
  window.addEventListener('pageshow', resetDocumentScroll);
  requestAnimationFrame(resetDocumentScroll);

  const $ = (selector, root = document) => root.querySelector(selector);
  const withoutTaskIds = value => String(value ?? '').replace(/(?:任务\s*(?:ID|编号|标识)\s*[:：]?\s*)?\bt-[a-f0-9][a-f0-9-]{7,}\b[。；;]?/gi,'').trim();
  const taskLabel = id => {
    const task = state.tasks.find(item => item.id === id);
    return task ? withoutTaskIds(task.sessionTitle || task.prompt || '').split(/\r?\n/u,1)[0].slice(0,42) : '';
  };
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const state = { tasks: [], approvals: [], artifacts: [], errors: [], chat: [], health: {}, companion: {}, directSession: {enabled:false}, busy: false };
  const companion = { loaded: false, data: { persona: {}, personaProfiles: [], activePersonaId: 'mornye', memories: [], revisions: [], behavior: {} }, loading: false };
  const library = { artifacts: [], categories: [], imports: [], jobs: [], lastWarnings: [], query: '', category: '', selected: new Set(), loading: false };
  const computer = { actions: [], loading: false };
  let toastTimer;
  let showAllTasks = false;
  let taskHistoryPage=[],taskHistoryCursor=null,taskHistoryStarted=false;
  let activeSearch = '';
  let searchResults = [];
  let archiveResultCount = 0;
  let selectedTaskId = '';
  let taskMonitor = { task: null, events: [], loading: false };
  let taskEventRequest = 0;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : null;
    if (!response.ok) throw new Error(payload?.error || `请求失败 (${response.status})`);
    return payload;
  }
  const json = (value) => JSON.stringify(value);
  function toast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('show'), 2800);
  }
  function renderDirectSession() {
    const status=state.directSession||{enabled:false};
    const button=$('#direct-session-open');
    button.textContent=status.enabled?`直连：${status.title||'DSH 会话'}`:'选择 DSH 会话';
    button.title=status.enabled?`当前直连 ${status.title||'DSH 会话'}，点击切换`:'选择要直接对话的 DSH 会话';
    $('#direct-session-exit').hidden=!status.enabled;
  }
  async function loadDirectSessions(query='') {
    const list=$('#direct-session-list');list.replaceChildren(make('div','empty-state','正在读取会话…'));
    try {
      const data=await api(`/api/dsh/sessions?q=${encodeURIComponent(query)}`);
      const sessions=Array.isArray(data?.sessions)?data.sessions:[];
      list.replaceChildren();
      if(!sessions.length){list.append(make('div','empty-state','没有找到匹配的 DSH 会话。'));return;}
      for(const session of sessions) {
        const row=make('button','direct-session-row');row.type='button';row.setAttribute('role','option');
        const description=[session.project,session.running?'正在运行':session.updatedAt?timeLabel(session.updatedAt):''].filter(Boolean).join(' · ');
        row.append(make('span','direct-session-row-title',session.title),make('span','direct-session-row-meta',description));
        row.addEventListener('click',async()=>{
          $('#direct-session-feedback').textContent=`正在连接「${session.title}」…`;
          for(const item of list.querySelectorAll('button'))item.disabled=true;
          try {
            const result=await api('/api/direct-session',{method:'POST',body:json({sessionId:session.sessionId})});
            state.directSession={enabled:true,title:result.title||session.title,connected:!!result.connected};renderDirectSession();
            $('#direct-session-feedback').textContent=`已直连「${state.directSession.title}」。现在在左侧对话框输入的话会原样发给这个会话。`;
            toast(`已连接「${state.directSession.title}」`);
          } catch(error) {$('#direct-session-feedback').textContent=`连接失败：${error.message}`;for(const item of list.querySelectorAll('button'))item.disabled=false;}
        });
        list.append(row);
      }
    } catch(error) {list.replaceChildren(make('div','empty-state',`读取失败：${error.message}`));}
  }
  async function loadCleanupSessions() {
    const list=$('#session-cleanup-list'),confirm=$('#session-cleanup-confirm');
    confirm.disabled=true;list.replaceChildren(make('div','empty-state','正在读取旧自动会话…'));
    try {
      const [data,retention]=await Promise.all([api('/api/dsh/sessions/cleanup'),api('/api/dsh/sessions/retention/settings').catch(()=>null)]);list.replaceChildren();
      $('#session-retention-enabled').disabled=!retention;
      if(retention){$('#session-retention-enabled').checked=retention.enabled;$('#session-retention-status').textContent=`${retention.enabled?'已启用':'已暂停'}：每小时检查系统创建超过3天或闲置超过15天的会话；先备份、整理记忆候选，再归档。个人、固定、正在工作及归属不明的会话保留。累计归档${retention.archivedCount||0}个。`;}
      else $('#session-retention-status').textContent='自动归档规则已准备，等待当前任务结束后安全加载；原有会话整理仍可使用。';
      const sessions=Array.isArray(data?.sessions)?data.sessions:[];
      if(!sessions.length){list.append(make('div','empty-state','没有发现标题明确标记为测试的会话。'));return;}
      for(const session of sessions) {
        const row=make('label','direct-session-row cleanup-session-row');
        const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.sessionId=session.sessionId;checkbox.disabled=session.protected;
        const content=make('span','cleanup-session-content');
        content.append(make('span','direct-session-row-title',session.title),make('span','direct-session-row-meta',[session.project,`${session.turns} 轮`,session.protected?`保留：${session.reason}`:session.updatedAt?timeLabel(session.updatedAt):'可清理'].filter(Boolean).join(' · ')));
        row.append(checkbox,content);list.append(row);
      }
      const update=()=>{confirm.disabled=!list.querySelector('input:checked');};
      list.querySelectorAll('input').forEach(box=>box.addEventListener('change',update));
      $('#session-cleanup-feedback').textContent=`共 ${sessions.length} 条旧自动或测试会话，可清理 ${data.eligible} 条，受保护 ${data.protected} 条。`;
    } catch(error){list.replaceChildren(make('div','empty-state',`读取失败：${error.message}`));$('#session-cleanup-feedback').textContent='';}
  }
  function asDate(value) {
    if (value === undefined || value === null || value === '') return null;
    const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function timeLabel(value) {
    const date = asDate(value);
    return date ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }
  function latestTime(value) {
    const date = asDate(value);
    return date ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  }
  function active(task) { return ['queued', 'pending', 'running', 'working', 'waiting', 'waiting_approval', 'in_progress'].includes(String(task.status || '').toLowerCase()); }
  function statusText(status) {
    const labels = { queued: '排队中', pending: '等待启动', running: '执行中', working: '执行中', in_progress: '执行中', waiting: '待回复', waiting_approval: '待审批', completed: '已完成', done: '已完成', interrupted: '已中断', failed: '失败', cancelled: '已取消', canceled: '已取消', detached: '直连已关闭' };
    return labels[String(status || '').toLowerCase()] || status || '未知';
  }
  function setConnection(ok, label) {
    const el = $('#connection-label');
    el.replaceChildren();
    const dot = make('span', `status-dot ${ok ? 'ok' : 'down'}`);
    el.append(dot, make('span', '', label));
  }
  function healthValue(value) {
    if (value === true || value === 'ok' || value === 'ready' || value === 'connected' || value === 'online') return ['ok', '在线'];
    if (value === false || value === 'down' || value === 'offline' || value === 'error' || value === null) return ['down', '离线'];
    if (typeof value === 'object' && value) {
      const label = value.status || value.state || (value.ok ? '在线' : '离线');
      if (String(label).toLowerCase() === 'available') return ['warn', '可启动'];
      const healthy = value.ok === true || /ready|online|connected|healthy|ok|在线|就绪/i.test(String(label));
      return [healthy ? 'ok' : 'warn', value.label || label || '未知'];
    }
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'available') return ['warn', '可启动'];
      return [/ready|online|connected|healthy|ok|在线|就绪/i.test(value) ? 'ok' : 'warn', value];
    }
    return ['warn', value === undefined ? '未知' : String(value)];
  }
  function renderHealth() {
    const strip = $('#health-strip');
    strip.replaceChildren();
    const health = state.health || {};
    const names = [['dsh', 'DSH'], ['dshDirector','主管'], ['codex', 'Codex'], ['workbuddy','WorkBuddy'], ['qq', 'QQ']];
    $('input[name="engine"][value="workbuddy"]').disabled=health.workbuddy!=='available';
    for (const [key, label] of names) {
      const modelFailure=key==='dsh' && health.dsh==='online' && health.dshModel?.status==='offline';
      const modelPending=key==='dsh' && health.dsh==='online' && health.dshModel?.status==='checking';
      const [baseClass, baseText] = healthValue(health[key]);
      const [className, text] = modelFailure?['warn','服务在线，最近一次模型连接失败']:modelPending?[baseClass,health.dshModel.reason==='stale-evidence'?'服务在线，模型连接证据已过期':'服务在线，尚无模型连接验证']: [baseClass,baseText];
      const item = make('span', 'health-item');
      item.title = key==='dsh' && modelPending && health.dshModel.checkedAt
        ? `${label}：${text}（最近验证 ${new Date(health.dshModel.checkedAt).toLocaleString()}）`
        : `${label}：${text}`;
      item.append(make('i', `status-dot ${className}`), make('span', '', modelFailure?`${label} · 模型连接异常`:label));
      strip.append(item);
    }
    if (health.mode !== undefined) {
      const mode = make('span', 'health-item mode-item', `模式 ${health.mode}`);
      mode.title = `运行模式：${health.mode}`;
      strip.append(mode);
    }
  }
  function renderCompanionEmotion() {
    const target = $('#companion-mood'); if (!target) return;
    const emotion = state.companion?.emotion || {};
    const labels = { calm: '平静', focused: '专注', happy: '开心', concerned: '担心', urgent: '有点急', relieved: '放心了', frustrated: '有点懊恼', sad: '低落', curious: '好奇', playful: '俏皮', affectionate: '亲近', wistful: '怀念' };
    const mood = labels[emotion.mood] || '平静';
    target.className = `companion-mood mood-${emotion.mood || 'calm'}`;
    target.textContent = `${companion.data.persona?.name || '当前助手'} · ${mood}`;
    target.title = emotion.reason || '';
  }
  function taskEventText(event) {
    const data = event?.data || {};
    if (event?.type === 'message') return String(data.text || '').trim();
    if (event?.type === 'narrator.completed' || event?.type === 'narrator.fallback') return String(data.text || '').trim();
    if (event?.type === 'task.dispatch-hint') return '派发提示：'+String(data.text || '').trim();
    if (event?.type === 'approval.created' || event?.type === 'approval') return `需要选择：${data.question || '请确认下一步'}`;
    if (event?.type === 'failed') return `执行失败：${data.error || '未知错误'}`;
    if (event?.type === 'completed') return String(data.text || '任务已完成。').trim();
    if (event?.type === 'session') return '执行会话已接通。';
    if (event?.type === 'task.started') return '任务已开始执行。';
    if (event?.type === 'task.created') return '任务已进入执行队列。';
    if (event?.type === 'task.receipt') return `收到任务回执：${data.status || '已返回'}`;
    return '';
  }
  function renderTaskMonitor(log) {
    if (!selectedTaskId) return;
    const task = taskMonitor.task || state.tasks.find(item => item.id === selectedTaskId);
    const monitor = make('article', 'task-monitor');
    const head = make('div', 'task-monitor-head');
    const title = make('strong', '', `任务运行过程 · ${task?.sessionTitle || '中枢派发任务'}`);
    const close = make('button', 'task-monitor-close', '收起'); close.type = 'button'; close.addEventListener('click', () => { selectedTaskId = ''; taskMonitor = { task: null, events: [], loading: false }; renderChat(); renderTasks(); });
    head.append(title, close); monitor.append(head);
    const meta = [task?.engine === 'codex' ? 'Codex' : task?.engine === 'workbuddy' ? 'WorkBuddy' : 'DSH', task && statusText(task.status), task?.sessionTitle && `会话名称：${task.sessionTitle}`].filter(Boolean).join(' · ');
    if (meta) monitor.append(make('div', 'task-monitor-meta', meta));
    const body = make('div', 'task-monitor-body');
    if (taskMonitor.loading) body.append(make('div', 'empty-state', '正在读取运行过程…'));
    else if (!taskMonitor.events.length) body.append(make('div', 'empty-state', '这项任务暂时还没有可显示的运行事件。'));
    else {
      const rows = [];
      for (const event of taskMonitor.events) {
        const text = taskEventText(event); if (!text || rows.at(-1)?.text === text) continue;
        rows.push({ text, createdAt: event.createdAt, type: event.type });
      }
      for (const row of rows.slice(-14)) {
        const item = make('div', `task-monitor-event ${row.type === 'failed' ? 'is-error' : row.type === 'approval' ? 'is-choice' : ''}`);
        item.append(make('time', '', timeLabel(row.createdAt)), make('span', '', row.text)); body.append(item);
      }
    }
    monitor.append(body); log.append(monitor);
  }
  function renderChat() {
    const log = $('#chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.replaceChildren();
    renderTaskMonitor(log);
    if (!state.chat.length) {
      const empty = make('div', 'chat-empty');
      empty.append(make('div', 'empty-orbit', '✦'), make('div', '', '对话会显示在这里。\n有工作要做，也可以从右侧派给 DSH 或 Codex。'));
      log.append(empty);
      return;
    }
    for (const item of state.chat) {
      const user = String(item.role || '').toLowerCase() === 'user';
      const retracted = !!(item.retracted || item.retractedAt);
      const row = make('article', `chat-message ${user ? 'user' : 'assistant'}`);
      if (!user) {
        const avatar = make('div', 'chat-avatar');
        avatar.append(makePersonaAvatar(companion.data.persona||{},true));
        row.append(avatar);
      }
      const bubble = make('div', 'chat-bubble');
      bubble.append(make('div', '', user && retracted ? '这条消息已撤回' : user ? item.text ?? '' : withoutTaskIds(item.text)));
      if (user && item.id && !retracted) {
        const retract = make('button', 'chat-retract-button', '撤回');
        retract.type = 'button';
        retract.setAttribute('aria-label', '撤回这条消息');
        retract.addEventListener('click', async () => {
          retract.disabled = true;
          try {
            const result = await api(`/api/chat/${encodeURIComponent(item.id)}/retract`, { method: 'POST', body: json({}) });
            await loadState();
            if (result?.warning) toast(`消息已撤回。${result.warning}`);
            else toast('消息已撤回');
          } catch (error) {
            toast(`撤回失败：${error.message || '请稍后重试'}`);
            retract.disabled = false;
          }
        });
        bubble.append(retract);
      }
      const when = timeLabel(item.createdAt);
      if (when) bubble.append(make('time', 'message-time', when));
      row.append(bubble); log.append(row);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }
  function renderApprovals() {
    const list = $('#approval-list');
    list.replaceChildren();
    const pending = state.approvals.filter(item => !item.status || ['pending', 'open', 'waiting'].includes(String(item.status).toLowerCase()));
    const recovery = state.approvals.filter(item => String(item.status).toLowerCase() === 'recovery_required');
    $('#approval-count').textContent = String(pending.length);
    const tabBadge = $('#approval-tab-count');
    tabBadge.textContent = String(pending.length + recovery.length);
    tabBadge.hidden = pending.length + recovery.length === 0;
    if (!pending.length && !recovery.length) { list.append(make('div', 'empty-state', '暂时没有待处理的选择。')); return; }
    const kindLabels = { followup: '任务选择', command: '命令审批', tool: '工具审批', question: '问题确认' };
    for (const approval of pending) {
      const card = make('article', 'approval-card');
      const kind = String(approval.kind || '').toLowerCase();
      card.append(make('div', 'approval-meta', [kindLabels[kind] || approval.kind || '需要确认',taskLabel(approval.taskId)].filter(Boolean).join(' · ')));
      card.append(make('div', 'approval-question', approval.question || '请为这个请求选择一个选项。'));
      const actions = make('div', 'choice-actions');
      const options = Array.isArray(approval.options) ? approval.options : [];
      for (const option of options) {
        const value = typeof option === 'string' ? option : (option?.value ?? option?.label ?? option?.text ?? '');
        if (!value) continue;
        const button = make('button', 'choice-button', typeof option === 'string' ? option : (option.label ?? option.text ?? value));
        button.type = 'button'; button.addEventListener('click', () => answerApproval(approval, String(value), button));
        actions.append(button);
      }
      const custom = make('button', 'choice-button custom', options.length ? '自定义…' : '回复…');
      custom.type = 'button';
      custom.addEventListener('click', () => {
        const existing = card.querySelector('.answer-inline');
        if (existing) { existing.querySelector('input').focus(); return; }
        const form = make('form', 'answer-inline');
        const input = document.createElement('input'); input.type = 'text'; input.maxLength = 1000; input.placeholder = '写下你的选择'; input.required = true;
        const submit = make('button', '', '提交'); submit.type = 'submit'; form.append(input, submit);
        form.addEventListener('submit', event => { event.preventDefault(); answerApproval(approval, input.value.trim(), submit); });
        card.append(form); input.focus();
      });
      actions.append(custom); card.append(actions); list.append(card);
    }
    for (const approval of recovery) {
      const card = make('article', 'approval-card recovery-required');
      card.append(make('div', 'approval-meta', `需要人工恢复 · ${taskLabel(approval.taskId)}`));
      card.append(make('div', 'approval-question', approval.question || '中枢重启前有一项待处理选择。'));
      card.append(make('div', 'task-detail', '原引擎请求无法确认仍有效。中枢已暂停自动续跑，请到对应 Agent 会话核对；这里不会提交过期选择。'));
      const task = state.tasks.find(item => item.id === approval.taskId);
      if (task?.sessionUrl) {
        const open = make('button', 'text-action task-session-button', '打开原 DSH 会话');
        open.type = 'button'; open.addEventListener('click', () => window.open(task.sessionUrl, '_blank', 'noopener,noreferrer'));
        card.append(open);
      }
      list.append(card);
    }
  }
  async function answerApproval(approval, answer, control) {
    if (!answer) return;
    control.disabled = true;
    try { await api(`/api/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: json({ answer }) }); toast('已提交选择'); await loadState(); }
    catch (error) { toast(`提交失败：${error.message}`); control.disabled = false; }
  }
  function renderTasks() {
    const list = $('#task-list');
    list.replaceChildren();
    const tasks = [...state.tasks].sort((a, b) => (asDate(b.updatedAt)?.getTime() || 0) - (asDate(a.updatedAt)?.getTime() || 0));
    $('#task-count').textContent = Number.isInteger(state.taskCount)?`${state.taskCount} 项记录 · 当前载入 ${tasks.length} 项`:`${tasks.length} 项`;
    if (!tasks.length) { list.append(make('div', 'empty-state', '还没有任务。')); return; }
    const visibleTasks = showAllTasks ? tasks : tasks.slice(0, 10);
    for (const task of visibleTasks) {
      const card = make('article', 'task-card');
      const top = make('div', 'task-topline');
      const roleName={maintenance:'维护助手',librarian:'资料管理员',director:'主管对话（理解与派单）',coordinator:'二级主管（并行派单）'}[task.role];
      const engineName=task.engine === 'codex' ? 'Codex' : task.engine === 'workbuddy' ? 'WorkBuddy' : 'DSH';
      const engineDetail=`${engineName}${task.model ? ` · ${task.model}` : ''}`;
      const subject=withoutTaskIds(task.sessionTitle || task.prompt).split(/\r?\n/u,1)[0].trim();
      const shortSubject=subject.length>48 ? `${subject.slice(0,47)}…` : subject;
      top.append(make('span', 'task-name', `${roleName ? `${roleName} · ${engineDetail}` : engineDetail}${shortSubject ? ` · ${shortSubject}` : ''}`));
      const status = make('span', `task-status ${String(task.status || '').toLowerCase()}`, statusText(task.status)); top.append(status); card.append(top);
      card.append(make('div', 'task-prompt', withoutTaskIds(task.prompt) || '（无任务说明）'));
      card.append(make('div', 'task-detail', task.hasSession ? '会话已接通' : '等待会话连接'));
      const meta = [task.updatedAt && `更新 ${latestTime(task.updatedAt)}`].filter(Boolean).join(' · ');
      if (meta) card.append(make('div', 'file-info', meta));
      if (task.hasSession) {
        const session = make('div', 'task-detail', `会话名称 · ${task.sessionTitle || '中枢派发任务'}`);
        session.title = task.sessionTitle || ''; card.append(session);
      }
      if (task.summary) card.append(make('div', 'task-detail task-output', withoutTaskIds(task.summary)));
      const actions = make('div', 'task-actions');
      const monitorButton = make('button', 'text-action task-session-button', selectedTaskId === task.id ? '已在左侧查看' : '在左侧查看运行过程');
      monitorButton.type = 'button'; monitorButton.addEventListener('click', () => openTaskMonitor(task)); actions.append(monitorButton);
      if (task.engine === 'dsh' && task.hasSession) {
        const dshButton = make('button', 'text-action task-session-button', '在 DSH 中查看');
        dshButton.type = 'button';
        dshButton.disabled = typeof task.sessionUrl !== 'string' || !task.sessionUrl;
        dshButton.title = dshButton.disabled ? '此任务尚无可用的 DSH 会话定位链接' : `打开 DSH，查看“${task.sessionTitle || '中枢派发任务'}”`;
        dshButton.addEventListener('click', () => {
          if (dshButton.disabled) return;
          window.open(task.sessionUrl, '_blank', 'noopener,noreferrer');
          toast(`已打开 DSH 会话“${task.sessionTitle || '中枢派发任务'}”`);
        });
        actions.append(dshButton);
      }
      if (active(task)) {
        const cancel = make('button', 'text-action danger', '强制停止'); cancel.type = 'button'; cancel.addEventListener('click', () => cancelTask(task, cancel)); actions.append(cancel);
      }
      if (task.canAmend || (!active(task) && task.canContinue)) {
        const follow = make('form', 'followup');
        const input = document.createElement('input'); input.type = 'text'; input.maxLength = 12000; input.placeholder = active(task) ? '补充要求，本轮安全结束后续接…' : task.status === 'interrupted' ? '在原会话继续…' : '继续这个任务…'; input.setAttribute('aria-label', '给这个任务发送后续消息');
        const button = make('button', '', active(task)?'记录补充':'发送'); button.type = 'submit'; follow.append(input, button);
        follow.addEventListener('submit', event => { event.preventDefault(); sendFollowup(task, input.value.trim(), button, input); });
        actions.append(follow);
      }
      if (actions.childNodes.length) card.append(actions);
      list.append(card);
    }
    if (tasks.length > 10) {
      const toggle = make('button', 'task-list-toggle', showAllTasks ? '收起较早任务' : `显示更多任务（还有 ${tasks.length - 10} 项）`);
      toggle.type = 'button'; toggle.addEventListener('click', () => { showAllTasks = !showAllTasks; renderTasks(); });
      list.append(toggle);
    }
  }
  async function cancelTask(task, button) {
    const sessionName = task.sessionTitle || '中枢任务会话';
    if (!window.confirm(`确定立即停止“${sessionName}”中的这个任务吗？这会中断执行并禁止后续自动接续；已经发生的操作不会自动撤销。`)) return;
    button.disabled = true;
    try { const result=await api(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', body: json({confirmed:true}) }); toast(result.ok?'执行端已确认停止':'停止尚未确认，请查看任务状态'); await loadState(); }
    catch (error) { toast(`取消失败：${error.message}`); button.disabled = false; }
  }
  async function sendFollowup(task, text, button, input) {
    if (!text) return;
    button.disabled = true;
    try {
      if(input.dataset.amendmentText!==text){input.dataset.amendmentText=text;input.dataset.amendmentKey=crypto.randomUUID();}
      const result=await api(`/api/tasks/${encodeURIComponent(task.id)}/message`, { method: 'POST', body: json({ text,messageKey:input.dataset.amendmentKey }) });
      input.value = '';delete input.dataset.amendmentText;delete input.dataset.amendmentKey;
      toast(result.reply||'已发回原任务会话'); await loadState();
    }
    catch (error) { toast(`发送失败：${error.message}`); }
    finally { button.disabled = false; }
  }
  async function openTaskMonitor(task) {
    selectedTaskId = String(task.id); taskMonitor = { task, events: [], loading: true }; renderChat(); renderTasks();
    // The monitor is rendered before the chat history. renderChat normally
    // preserves the reader's near-bottom position, which leaves a newly
    // opened monitor above the viewport. Reveal it explicitly on open.
    const log = $('#chat-log'); if (log) log.scrollTop = 0;
    await loadTaskEvents(selectedTaskId);
  }
  async function loadTaskEvents(taskId, renderAfter = true) {
    if (!taskId) return;
    const request = ++taskEventRequest;
    try {
      const data = await api(`/api/tasks/${encodeURIComponent(taskId)}/events?limit=180`);
      if (request !== taskEventRequest || selectedTaskId !== taskId) return;
      taskMonitor = { task: data?.task || state.tasks.find(item => item.id === taskId), events: Array.isArray(data?.events) ? data.events : [], loading: false };
    } catch (error) {
      if (request !== taskEventRequest || selectedTaskId !== taskId) return;
      taskMonitor = { task: state.tasks.find(item => item.id === taskId), events: [{ type: 'failed', createdAt: new Date().toISOString(), data: { error: `无法读取运行过程：${error.message}` } }], loading: false };
    }
    if (renderAfter) renderChat();
  }
  function renderErrors() {
    const panel = $('#errors-panel'); const list = $('#error-list');
    list.replaceChildren();
    const errors = [...state.errors].sort((a, b) => (asDate(b.createdAt)?.getTime() || 0) - (asDate(a.createdAt)?.getTime() || 0));
    const recordCount=errors.reduce((sum,item)=>sum+(Number(item.count)||1),0);
    panel.hidden = !errors.length; $('#error-count').textContent = `${errors.filter(item=>!item.resolved).length} 个事件 / ${recordCount} 条记录`;
    for (const item of errors.slice(0, 12)) {
      const card = make('article', 'error-card');
      const when = timeLabel(item.createdAt);
      card.append(make('div', 'error-time', `${item.resolved?'已恢复 · ':''}${when}${item.taskTitle ? ` · ${item.taskTitle}` : ''}`));
      card.append(make('p', '', item.message || '未知错误'));
      if(item.count>1)card.append(make('div','error-time',`同类 ${item.count} 次${item.affectedTasks?` · 涉及 ${item.affectedTasks} 项任务`:''} · ${timeLabel(item.firstSeenAt)} 至 ${when}`));
      list.append(card);
    }
  }
  function artifactName(item) { return item.name || item.filename || item.path || item.title || `文件 ${item.id}`; }
  async function readArtifactIntoChat(item, control) {
    if (!item?.id) return;
    if (control) control.disabled = true;
    try {
      await api('/api/chat', { method: 'POST', body: json({ text: `读 文件 ${item.id}` }) });
      toast(`已把《${artifactName(item)}》读入左侧对话`);
      await loadState();
    } catch (error) { toast(`读取失败：${error.message}`); }
    finally { if (control) control.disabled = false; }
  }
  function renderArtifacts(items, total = items.length, mode = 'search') {
    const list = $('#knowledge-list'); list.replaceChildren();
    $('#archive-count').textContent = mode === 'recent' ? (total > items.length ? `最近 ${items.length} / 共 ${total}` : `${total} 项`) : `${total} 项`;
    if (!items.length) {
      list.append(make('div', 'empty-state', mode === 'recent' ? '归档后文件会显示在这里。' : '没有找到匹配的归档文件。'));
      return;
    }
    for (const item of items) {
      const card = make('article', 'file-card');
      const top = make('div', 'file-topline');
      const name = make('div', 'file-name', item.catalog?.title || artifactName(item)); name.title = artifactName(item);
      const link = make('a', 'download-link', '下载 ↗');
      link.href = `/api/artifacts/${encodeURIComponent(item.id)}/file`; link.setAttribute('download', artifactName(item).split(/[\/]/).pop() || 'archive-file');
      link.rel = 'noopener';
      const read = make('button', 'library-small-button', '读入对话'); read.type = 'button'; read.addEventListener('click', () => readArtifactIntoChat(item, read));
      top.append(name, read, link); card.append(top);
      const info = [taskLabel(item.taskId), item.size != null && `${Number(item.size).toLocaleString()} bytes`, item.mimeType || item.type].filter(Boolean).join(' · ');
      if (info) card.append(make('div', 'file-info', info));
      if(item.catalog?.tags?.length)card.append(make('div','catalog-tags',item.catalog.tags.join(' · ')));
      if (item.catalog?.summary || item.snippet || item.excerpt || item.text) card.append(make('div', 'task-prompt', item.catalog?.summary || item.snippet || item.excerpt || item.text));
      list.append(card);
    }
  }
  function libraryCategory(item) { return String(item?.catalog?.category || item?.category || '').trim() || '未分类'; }
  function extractionLabel(status) {
    const labels = { queued: '待处理', pending: '待处理', running: '处理中', processing: '处理中', completed: '已完成', ready: '已完成', failed: '失败', skipped: '未抽取' };
    return labels[String(status || '').toLowerCase()] || (status ? String(status) : '尚无抽取状态');
  }
  function activeLibraryJobIds() {
    const ids = new Set();
    for (const job of library.jobs) {
      if (!['queued', 'running', 'processing'].includes(String(job.status || '').toLowerCase())) continue;
      for (const id of job.artifactIds || []) ids.add(String(id));
    }
    return ids;
  }
  function renderLibraryWarnings(warnings = [], warningCount = warnings.length) {
    const details = $('#library-warnings'); const list = $('#library-warning-list');
    list.replaceChildren();
    const rows = Array.isArray(warnings) ? warnings : [];
    const count = Math.max(rows.length, Number(warningCount) || 0);
    details.hidden = count === 0;
    if (!count) return;
    $('#library-warnings-summary').textContent = `导入提示 · ${count} 项跳过或未能读取`;
    for (const warning of rows.slice(0, 20)) {
      const row = make('div', 'library-warning-item');
      row.append(make('strong', '', warning?.path || '未命名路径'), make('span', '', warning?.reason || '无法读取'));
      list.append(row);
    }
    if (count > rows.length) list.append(make('div', 'library-warning-item', `另有 ${count - rows.length} 项提示未显示。`));
    if (!rows.length && count) list.append(make('div', 'library-warning-item', '此导入记录暂未保存逐项原因。'));
  }
  function renderLibraryJobs() {
    const jobs = Array.isArray(library.jobs) ? library.jobs : [];
    const list = $('#library-job-list'); list.replaceChildren();
    const labels = { queued: '已排队', pending: '已排队', running: '处理中', processing: '处理中', completed: '已完成', done: '已完成', failed: '失败' };
    const activeCount = jobs.filter(job => ['queued', 'running', 'processing'].includes(String(job.status || '').toLowerCase())).length;
    $('#library-jobs-summary').textContent = jobs.length ? `DSH 分类进度 · ${activeCount} 项进行中` : 'DSH 分类进度';
    if (!jobs.length) { list.append(make('div', 'empty-state', '还没有分类任务。')); return; }
    for (const job of jobs.slice(0, 10)) {
      const status = String(job.status || '').toLowerCase();
      const row = make('article', 'library-job-row');
      const count = Array.isArray(job.artifactIds) ? job.artifactIds.length : 0;
      row.append(make('div', 'library-job-title', `${labels[status] || '处理中'} · ${count} 份资料`));
      const updated = job.updatedAt || job.createdAt;
      if (updated) row.append(make('div', 'library-job-time', timeLabel(updated)));
      if (status === 'failed' && job.error) {
        const shortError = String(job.error).replace(/\s+/g, ' ').trim().slice(0, 180);
        row.append(make('div', 'library-job-error', shortError));
      }
      list.append(row);
    }
  }
  function renderLibrary() {
    const list = $('#library-list');
    if (!list) return;
    const categories = Array.isArray(library.categories) ? library.categories : [];
    const categorySelect = $('#library-category');
    const current = library.category;
    categorySelect.replaceChildren(make('option', '', '全部类别'));
    categorySelect.firstElementChild.value = '';
    for (const item of categories) {
      const name = typeof item === 'string' ? item : item?.name;
      if (!name) continue;
      const option = make('option', '', typeof item === 'string' ? name : `${name}（${item.count ?? 0}）`);
      option.value = name; categorySelect.append(option);
    }
    if (current && !categories.some(item => (typeof item === 'string' ? item : item?.name) === current)) {
      const option = make('option', '', current); option.value = current; categorySelect.append(option);
    }
    categorySelect.value = current;
    const items = Array.isArray(library.artifacts) ? library.artifacts : [];
    const busyIds = activeLibraryJobIds();
    $('#library-count').textContent = `${items.length} 项`;
    list.replaceChildren();
    if (!items.length) {
      list.append(make('div', 'empty-state', library.loading ? '正在读取个人文件库…' : (library.query || library.category ? '没有找到符合条件的文件。' : '导入一个目录后，文件会显示在这里。')));
    }
    const visibleIds = new Set(items.map(item => String(item.id)));
    for (const id of [...library.selected]) if (!visibleIds.has(id)) library.selected.delete(id);
    for (const item of items) {
      const card = make('article', 'library-card');
      const head = make('div', 'library-card-head');
      const selectLabel = make('label', 'library-item-select');
      const id = String(item.id);
      const categorized = libraryCategory(item) !== '未分类';
      const inProgress = busyIds.has(id);
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = library.selected.has(id); checkbox.disabled = categorized || inProgress;
      if (categorized) library.selected.delete(id);
      if (inProgress) library.selected.delete(id);
      if (categorized || inProgress) checkbox.title = categorized ? '已分类的资料不能重复提交' : '该资料正在分类处理中';
      checkbox.setAttribute('aria-label', `选择 ${item.catalog?.title || artifactName(item)}`);
      checkbox.addEventListener('change', () => { checkbox.checked ? library.selected.add(id) : library.selected.delete(id); updateLibraryActions(); });
      selectLabel.append(checkbox);
      const name = make('div', 'file-name', item.catalog?.title || artifactName(item)); name.title = artifactName(item);
      const link = make('a', 'download-link', '打开 ↗'); link.href = `/api/artifacts/${encodeURIComponent(item.id)}/file`; link.rel = 'noopener'; link.target = '_blank';
      const read = make('button', 'library-small-button', '读入对话'); read.type = 'button'; read.addEventListener('click', () => readArtifactIntoChat(item, read));
      head.append(selectLabel, name, read, link); card.append(head);
      const provenance = item.provenance || {};
      const source = provenance.originalPath || item.originalPath || provenance.relativePath || provenance.sourceDirectory || '';
      if (source) { const path = make('div', 'library-source', `来源：${source}`); path.title = source; card.append(path); }
      const meta = make('div', 'library-meta');
      meta.append(make('span', 'library-category-chip', libraryCategory(item)));
      meta.append(make('span', 'file-kind', `内容抽取：${extractionLabel(item.extraction?.status)}`));
      if (inProgress) meta.append(make('span', 'library-processing-label', 'DSH 正在分类'));
      card.append(meta);
      if (item.catalog?.tags?.length) card.append(make('div', 'catalog-tags', item.catalog.tags.join(' · ')));
      if (item.catalog?.summary) card.append(make('div', 'task-prompt', item.catalog.summary));
      const edit = make('div', 'library-category-edit');
      const categoryEdit = document.createElement('input'); categoryEdit.type = 'text'; categoryEdit.maxLength = 80; categoryEdit.value = libraryCategory(item) === '未分类' ? '' : libraryCategory(item); categoryEdit.placeholder = '手动填写类别'; categoryEdit.setAttribute('aria-label', '手动设置类别');
      const save = make('button', 'library-small-button', '保存类别'); save.type = 'button';
      save.addEventListener('click', async () => {
        const category = categoryEdit.value.trim(); if (!category) { toast('请先填写类别'); return; }
        save.disabled = true;
        try { await api(`/api/library/artifacts/${encodeURIComponent(item.id)}/category`, { method: 'POST', body: json({ category }) }); toast('类别已更新'); await loadLibrary(); }
        catch (error) { toast(`保存类别失败：${error.message}`); }
        finally { save.disabled = false; }
      });
      edit.append(categoryEdit, save); card.append(edit);
      list.append(card);
    }
    const selectable = items.filter(item => libraryCategory(item) === '未分类' && !busyIds.has(String(item.id)));
    const all = selectable.length > 0 && selectable.every(item => library.selected.has(String(item.id)));
    $('#library-select-all').disabled = selectable.length === 0;
    $('#library-select-all').checked = all;
    renderLibraryJobs();
    updateLibraryActions();
  }
  function updateLibraryActions() {
    const count = library.selected.size;
    $('#library-classify').disabled = count === 0 || library.loading;
    $('#library-classify').textContent = count ? `交给 DSH 分类（${count}）` : '交给 DSH 分类';
  }
  async function loadLibrary({ query = library.query, category = library.category } = {}) {
    library.query = query; library.category = category; library.loading = true; renderLibrary();
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    try {
      const suffix = params.size ? `?${params}` : '';
      const data = await api(`/api/library${suffix}`);
      library.artifacts = Array.isArray(data) ? data : (data?.artifacts || []);
      library.categories = data?.categories || [];
      library.imports = data?.imports || [];
      library.jobs = data?.jobs || [];
      const recentImport = library.imports[0];
      if (Array.isArray(recentImport?.warnings)) library.lastWarnings = recentImport.warnings;
      renderLibraryWarnings(library.lastWarnings, recentImport?.warningCount ?? library.lastWarnings.length);
      renderLibrary();
    } catch (error) {
      library.artifacts = [];
      renderLibrary();
      $('#library-list').replaceChildren(make('div', 'empty-state', `暂时无法读取个人文件库：${error.message}`));
    } finally { library.loading = false; updateLibraryActions(); }
  }
  function render() {
    renderHealth(); renderCompanionEmotion(); renderDirectSession(); renderChat(); renderApprovals(); renderTasks(); renderErrors(); renderSpecialists();
    renderArtifacts(searchResults, archiveResultCount, activeSearch ? 'search' : 'recent');
    setConnection(true, '已连接');
  }
  function renderSpecialists(){
    const data=state.specialists || {},list=$('#specialist-agents');list.replaceChildren();
    $('#catalog-total').textContent=`${data.catalogEntries || 0} 条整理`;
    for(const agent of data.agents || []){
      const card=make('article','specialist-card');
      card.append(make('strong','',`${agent.name} · ${agent.status==='working'?'处理中':'待命'}`));
      card.append(make('div','file-info',`${agent.engine==='codex'?'Codex':'DSH'} · ${agent.hasSession?'专属会话已接入':'等待首次任务'}`));
      const next=agent.engine==='codex'?'dsh':'codex',swap=make('button','system-check',`改用 ${next==='codex'?'Codex':'DSH'}`);
      swap.type='button';swap.disabled=agent.status==='working';
      swap.addEventListener('click',async()=>{swap.disabled=true;try{await api(`/api/specialists/${agent.kind}/engine`,{method:'POST',body:json({engine:next})});toast(`已切换为 ${next==='codex'?'Codex':'DSH'}，从下个任务开始生效`);await loadState();}catch(error){toast(error.message);swap.disabled=false;}});
      card.append(swap);list.append(card);
    }
    const jobs=$('#specialist-jobs');jobs.replaceChildren();
    const statuses={queued:'排队',running:'处理中',completed:'已完成',failed:'失败',ready:'等待空闲部署',deployed:'已部署'};
    for(const job of (data.jobs || []).slice(0,6)){
      const card=make('article','specialist-card');card.append(make('strong','',`${job.kind==='maintenance'?'维护':'整理'} · ${statuses[job.status] || job.status}`));
      card.append(make('div','task-prompt',job.summary || '处理中。'));jobs.append(card);
      if(job.nextRetryAt)card.append(make('div','file-info','暂时失败，计划重试：'+timeLabel(job.nextRetryAt)));
      if(job.status==='failed' && job.canResume){
        const choices=job.preflightRetryAvailable?[{label:'重新准备隔离仓库',freshSession:false}]:[{label:'在原会话继续',freshSession:false},...(job.freshSessionAvailable?[{label:'新会话接续',freshSession:true}]:[])];
        for(const choice of choices){const retry=make('button','system-check',choice.label);retry.type='button';
          retry.addEventListener('click',async()=>{retry.disabled=true;try{await api(`/api/specialists/jobs/${encodeURIComponent(job.id)}/resume`,{method:'POST',body:json({freshSession:choice.freshSession})});toast(job.preflightRetryAvailable?'已重新排队，将保留旧目录并准备新的隔离仓库':'已恢复专职任务，将检查已有结果后继续');await loadState();}catch(error){toast(error.message);retry.disabled=false;}});card.append(retry);}
      }
    }
  }
  function personaValue(value) {
    return Array.isArray(value) ? value.join('\n') : (value ?? '');
  }
  function personaAvatarFile(persona = {}) {
    return identity.avatarFile(persona);
  }
  let appliedAppAvatar='',appAvatarFlight=Promise.resolve();
  function makePersonaAvatar(persona = {}, decorative = false) {
    const avatar=personaAvatarFile(persona);
    if(/^[a-zA-Z0-9_-]+\.(?:png|webp|jpe?g)$/i.test(avatar)) {
      const avatarClass=avatar==='default-avatar.png'?'persona-avatar-entelechia':avatar==='default-avatar.png'?'persona-avatar-aemeath':avatar==='default-avatar.png'?'persona-avatar-dania':'persona-avatar-mornye';
      const image=document.createElement('img');image.className=`persona-avatar-image ${avatarClass}`;image.src=identity.avatarUrl(persona);
      image.alt=decorative?'':String(persona.name||'人设头像');image.onerror=()=>{image.replaceWith(make('span','persona-avatar-fallback','✦'));};return image;
    }
    return make('span','persona-avatar-fallback',avatar);
  }
  function applyPersonaAppearance(persona = {}) {
    identity.apply(persona);
    const name = String(persona.name || '当前助手');
    $('#active-persona-name').textContent = name;
    $('#active-persona-avatar').replaceChildren(makePersonaAvatar(persona));
    $('#conversation-persona-title').textContent = `和${name}说`;
    $('#chat-input').placeholder = persona.address ? `${persona.address}，想聊什么？` : '想聊些什么？';
    $('#persona-page-title').textContent = `${name}的人设卡与共用记忆`;
    $('#memory-heading').textContent = `${name}的共用记忆`;
    const memoryInput=$('#memory-new-text');if(memoryInput)memoryInput.placeholder=`添加所有人设共用的记忆…`;
    const avatarFile=personaAvatarFile(persona);
    if(window.aiCenterAppearance && appliedAppAvatar!==avatarFile){
      appliedAppAvatar=avatarFile;
      appAvatarFlight=appAvatarFlight.catch(()=>{}).then(()=>window.aiCenterAppearance.setAvatar(avatarFile)).catch(()=>{if(appliedAppAvatar===avatarFile)appliedAppAvatar='';});
    }
    document.querySelector('.conversation')?.setAttribute('aria-label',`和${name}对话`);
  }
  function setPersonaForm(persona = {}) {
    $('#persona-address').value = persona.address ?? '';
    $('#persona-name').value = persona.name ?? '';
    const storedAvatar=String(persona.avatar||'');
    $('#persona-avatar').value=/^[a-zA-Z0-9_-]+\.(?:png|webp|jpe?g)$/i.test(storedAvatar)?storedAvatar:(String(persona.name||'')==='AI 助手'?'default-avatar.png':'default-avatar.png');
    $('#persona-theme-color').value = persona.themeColor || '#5d79b2';
    $('#persona-qq-nickname').value = persona.qqNickname ?? '';
    $('#persona-voice-profile').value = persona.voiceProfileId ?? '';
    $('#persona-style').value = persona.style ?? '';
    $('#persona-report-style').value = persona.reportStyle ?? '';
    $('#persona-report-examples').value = (persona.reportExamples || []).join('\n\n');
    $('#persona-background').value = persona.background ?? '';
    $('#persona-examples').value = Array.isArray(persona.examples) ? persona.examples.join('\n\n') : personaValue(persona.examples);
    $('#persona-form').dataset.dirty = 'false';
    applyPersonaAppearance(persona);
    void loadPersonaVoiceProfiles();
  }
  async function loadPersonaVoiceProfiles() {
    try {
      const data = await api('/api/voice');
      const select = $('#persona-voice-profile');
      const current = String(companion.data.persona?.voiceProfileId ?? '');
      select.replaceChildren(new Option('默认音色（不联动）', ''));
      for (const profile of Array.isArray(data.profiles) ? data.profiles : []) select.append(new Option(String(profile.label ?? profile.id ?? '未命名音色'), String(profile.id ?? '')));
      select.value = current;
    } catch {}
  }
  function renderPersonaIdentity(data = {}) {
    const checkbox = $('#persona-qq-sync'), status = $('#persona-identity-status');
    if (!checkbox || !status) return;
    checkbox.checked = Boolean(data.enabled);
    const label = (item, success, pending) => {
      const value = typeof item === 'string' ? item : String(item?.status || 'unknown').toLowerCase();
      if (value === 'confirmed') return success;
      if (value === 'failed') return `${pending}失败${item?.error ? `：${item.error}` : ''}`;
      if (value === 'syncing') return `${pending}处理中…`;
      if (value === 'disabled') return `${pending}未启用`;
      if (value === 'skipped') return pending === '音色' ? '音色保持手动选择' : `${pending}未设置`;
      return `${pending}需核对`;
    };
    const top = String(data.status || '').toLowerCase();
    if (top === 'disabled' || !data.enabled) { status.textContent = '未启用 QQ 同步'; return; }
    const lines = [
      label(data.nickname, 'QQ 昵称已核验', 'QQ 昵称'),
      label(data.avatar, '头像设置已确认（以 QQ 显示为准）', 'QQ 头像'),
      label(data.voice, '音色已切换', '音色'),
    ];
    if (top === 'syncing') lines.unshift('QQ 同步中…');
    else if (top === 'partial') lines.unshift('部分完成');
    else if (top === 'unknown') lines.unshift('同步状态需核对');
    if (data.error) lines.push(`详情：${data.error}`);
    status.textContent = lines.join('\n');
  }
  async function loadPersonaIdentity() {
    try { renderPersonaIdentity(await api('/api/companion/identity')); }
    catch (error) { $('#persona-identity-status').textContent = `读取失败：${error.message}`; }
  }
  $('#persona-qq-sync')?.addEventListener('change', async event => {
    const checkbox = event.currentTarget;
    checkbox.disabled = true;
    $('#persona-identity-status').textContent = checkbox.checked ? '正在请求 QQ 同步…' : '正在关闭 QQ 同步…';
    try { renderPersonaIdentity(await api('/api/companion/identity', { method: 'POST', body: json({ enabled: checkbox.checked }) })); }
    catch (error) { checkbox.checked = !checkbox.checked; $('#persona-identity-status').textContent = `更新失败：${error.message}`; }
    finally { checkbox.disabled = false; }
  });
  function renderPersonaProfiles() {
    const select = $('#persona-profile-select');
    if (!select) return;
    const profiles = Array.isArray(companion.data.personaProfiles) ? companion.data.personaProfiles : [];
    select.replaceChildren();
    for (const profile of profiles) {
      const option = document.createElement('option');
      option.value = String(profile.id);
      option.textContent = String(profile.label || profile.id);
      select.append(option);
    }
    select.value = companion.data.activePersonaId || profiles.find(item => item.active)?.id || '';
    $('#persona-rename').disabled = !select.value;
    $('#persona-delete').disabled = !select.value || select.value === 'mornye';
  }
  function memoryStatusLabel(status) {
    const value = String(status || 'active').toLowerCase();
    return value === 'archived' || value === 'archive' ? '已归档' : value === 'pending' ? '待确认' : '生效中';
  }
  function renderMemories(drafts = new Map()) {
    const list = $('#memory-list');
    list.replaceChildren();
    const memories = Array.isArray(companion.data.memories) ? companion.data.memories : [];
    if (!memories.length) list.append(make('div', 'empty-state', '还没有记忆条目。'));
    for (const memory of memories) {
      const id = String(memory.id ?? '');
      const archived = ['archived', 'archive'].includes(String(memory.status || '').toLowerCase());
      const card = make('article', `memory-card${archived ? ' is-archived' : ''}`);
      card.dataset.memoryId = id;
      const head = make('div', 'memory-card-head');
      const status = make('span', `memory-state ${archived ? 'archived' : memory.status === 'pending' ? 'pending' : 'active'}`, memoryStatusLabel(memory.status));
      const timestamp = memory.updatedAt || memory.createdAt;
      head.append(status, make('time', 'memory-time', timestamp ? `更新 ${timeLabel(timestamp)}` : ''));
      const editor = document.createElement('textarea');
      editor.className = 'memory-text'; editor.maxLength = 1000; editor.rows = 3; editor.setAttribute('aria-label', '记忆内容');
      const draft = drafts.get(id);
      editor.value = draft?.text ?? memory.text ?? '';
      const controls = make('div', 'memory-controls');
      const stateLabel = make('label', 'memory-status-label', '状态');
      const select = document.createElement('select'); select.className = 'memory-status'; select.setAttribute('aria-label', '记忆状态');
      for (const [value, label] of [['active', '生效'], ['pending', '待确认']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
      }
      select.value = draft?.status ?? (memory.status === 'pending' ? 'pending' : 'active');
      stateLabel.append(select);
      const feedback = make('span', 'memory-feedback', ''); feedback.setAttribute('role', 'status');
      const save = make('button', 'memory-save', '保存'); save.type = 'button';
      save.addEventListener('click', () => saveMemory(memory, editor.value.trim(), select.value, save));
      controls.append(stateLabel, feedback, save);
      if (archived) {
        const restore = make('button', 'memory-restore', '恢复'); restore.type = 'button';
        restore.addEventListener('click', () => saveMemory(memory, editor.value.trim(), select.value, restore));
        controls.append(restore);
      } else {
        const archive = make('button', 'memory-archive', '归档'); archive.type = 'button';
        archive.addEventListener('click', () => archiveMemory(memory, archive));
        controls.append(archive);
      }
      card.append(head, editor, controls); list.append(card);
    }
    const facts=Array.isArray(companion.data.facts)?companion.data.facts:[];
    if(facts.length) {
      list.append(make('h3','memory-section-title','结构化事实（修改后保留旧版本）'));
      for(const fact of facts) {
        const card=make('article',`memory-card${fact.status==='superseded'?' is-archived':''}`);
        const head=make('div','memory-card-head');
        head.append(make('span',`memory-state ${fact.status==='active'?'active':'archived'}`,fact.status==='active'?'当前有效':'历史版本'));
        head.append(make('time','memory-time',fact.validFrom?`生效 ${timeLabel(fact.validFrom)}`:''));
        const key=document.createElement('input');key.className='memory-text';key.maxLength=120;key.value=fact.key||'';key.setAttribute('aria-label','事实名称');
        const value=document.createElement('textarea');value.className='memory-text';value.maxLength=1000;value.rows=2;value.value=fact.value||'';value.setAttribute('aria-label','事实内容');
        const controls=make('div','memory-controls');const feedback=make('span','memory-feedback','');feedback.setAttribute('role','status');
        const save=make('button','memory-save',fact.status==='active'?'更正':'新增当前版本');save.type='button';
        save.addEventListener('click',async()=>{save.disabled=true;feedback.textContent='保存中…';try{await api('/api/companion/facts',{method:'POST',body:json({key:key.value.trim(),value:value.value.trim(),source:'memory-panel',confidence:1})});toast('事实已更新，旧版本仍保留');await loadCompanion({preserveDrafts:true});}catch(error){feedback.textContent=`保存失败：${error.message}`;}finally{save.disabled=false;}});
        controls.append(feedback,save);card.append(head,key,value,controls);list.append(card);
      }
    }
  }
  function renderProactiveSettings(settings = {}) {
    const toggle = $('#proactive-enabled');
    const status = $('#proactive-status');
    if (!toggle || !status) return;
    toggle.checked = settings.enabled !== false;
    const phoneToggle = $('#phone-autonomy-enabled');
    if (phoneToggle) phoneToggle.checked = settings.phoneAutonomyEnabled === true;
    const activeName=companion.data.persona?.name||'当前助手';
    const labels = {
      waiting: '等你安静一段时间后再考虑。',
      considering: `${activeName}正在判断有没有自然的话题。`,
      phone_exploring: `${activeName}正在手机上看看有趣的内容。`,
      sent: '最近已经联系过，会留出一些间隔。',
      no_message: '暂时没有合适的话题，所以没有发消息。',
      quiet_hours: '现在是安静时段，之后再考虑。',
      cooldown: '还在两次联系之间的间隔里。',
      busy: '正在处理当前对话，稍后再接着聊；后台工作不会挡住闲聊。',
      queued: '想说的话已进入 QQ 队列；你接话后会停下旧补充。',
      delivery_pending: '上一组消息还在发送，先等它送达。',
      delivery_uncertain: '上一组发送结果待核对，暂不追加以免重复。',
      offline: 'QQ 或 DSH 暂不可用，连接恢复后再考虑。',
      direct_mode: '当前正在直连会话，暂不发起闲聊。',
      retry_later: '刚才没有完成这次判断，稍后会再试。',
      disabled: '主动联系已关闭。',
    };
    status.textContent = labels[settings.status] || '主动联系已开启，会根据近期对话决定是否联系。';
  }
  function renderNewsSettings(settings = {}) {
    const morning = $('#news-morning-enabled');
    const time = $('#news-morning-time');
    const breaking = $('#news-breaking-enabled');
    const status = $('#news-status');
    if (!morning || !time || !breaking || !status) return;
    morning.checked = settings.morningEnabled !== false;
    time.value = settings.morningTime || '08:30';
    breaking.checked = settings.breakingEnabled !== false;
    const activeName=companion.data.persona?.name||'当前助手';
    const labels = {
      waiting: '晨报按设定时间送达；重要消息约每两小时筛查一次。',
      morning_research: `${activeName}正在整理今天的晨报。`,
      morning_sent: '今天的晨报已经送到。',
      morning_missed_window: '今天错过了晨报时间段，明天会继续。',
      breaking_research: `${activeName}正在核对最新消息和来源。`,
      breaking_sent: '刚才有一条重要消息已经分享给你。',
      watching: '新闻来源已检查；目前没有达到提醒门槛的消息。',
      no_verified_breaking: '暂时没有足够新、且来源相互印证的重大新闻。',
      daily_limit: '今天的重要新闻提醒已到上限，避免刷屏。',
      alert_cooldown: '刚分享过重要消息，会留出间隔。',
      busy: '现在有任务或另一条分享正在处理，之后会再试。',
      offline: 'QQ 或 DSH 暂不可用，连接恢复后会继续。',
      direct_mode: '当前正在直连会话，暂缓新闻分享。',
      retry_later: '刚才的新闻检索或整理没有完成，稍后会再试。',
      disabled: '主动联系已关闭，新闻分享会一并暂停。',
    };
    const alerts = Number(settings.alertsToday || 0);
    status.textContent = `${labels[settings.status] || '新闻分享已开启。'}${settings.breakingEnabled !== false ? ` 今日重要提醒 ${alerts}/${settings.maxAlertsPerDay || 2}。` : ''}`;
  }
  function renderDiary(data = {}) {
    if (data.dailyReview) renderDailyReview(data.dailyReview);
    const settings = data.settings || {};
    const toggle = $('#diary-enabled');
    if (toggle) toggle.checked = settings.enabled !== false;
    const status = $('#diary-status');
    if (status) status.textContent = settings.running ? '正在整理今天的对话…' : settings.lastGeneratedDay ? `最近生成：${settings.lastGeneratedDay} · 每天 22:30（上海）` : '每天 22:30（上海）检查；只用现有主管会话生成';
    const list = $('#diary-list');
    if (!list) return;
    list.replaceChildren();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) { list.append(make('div', 'empty-state', '还没有日记；有当天对话时会自动生成。')); return; }
    for (const entry of entries) {
      const card = make('article', 'diary-entry');
      card.append(make('time', 'memory-time', String(entry.day || '')), make('h3', 'diary-title', String(entry.title || '')), make('p', 'diary-content', String(entry.content || '')));
      list.append(card);
    }
  }
  async function loadDiary() {
    try { renderDiary(await api('/api/companion/diary?limit=30')); }
    catch (error) { const status = $('#diary-status'); if (status) status.textContent = `日记读取失败：${error.message}`; }
  }
  function renderDailyReview(data = {}) {
    const toggle = $('#daily-review-enabled'); if (toggle) toggle.checked = data.enabled !== false;
    const status = $('#daily-review-status');
    const delivery = {sent:'QQ 已发送',pending:'等待 QQ 发送',sending:'QQ 发送中',uncertain:'发送结果待核对，不自动重发'}[data.delivery?.status] || '尚未推送';
    if (status) status.textContent = `每天 23:00（上海） · ${data.running ? '正在自动整理' : data.last?.error ? '整理失败，稍后自动重试' : delivery}${data.last ? ` · ${data.last.day}` : ''}`;
    const preview = $('#daily-review-preview'); if (preview) preview.textContent = data.last?.summary || '';
  }
  function renderCognition(data={}) {
    const s=data.settings||data;
    const labels={score:'评估记忆重要性',questions:'形成反思问题',reflect:'生成有依据的反思',plan:'整理与调整交流计划',completed:'本轮已完成'};
    const status=$('#cognition-status');if(status)status.textContent=`${s.enabled?'已开启':'已暂停'} · 重要性积累 ${s.accumulatedImportance||0}/${s.reflectionThreshold||150} · ${labels[s.lastCycle?.phase]||'等待新交流'}${s.lastCycle?.error?' · 暂未完成，保留进度后重试':''}`;
    const panel=$('#cognition-panel');if(!panel?.contains(document.activeElement)) {
      const enabled=$('#cognition-enabled');if(enabled)enabled.checked=s.enabled!==false;
      for(const k of ['recency','relevance','importance']){const input=$('#cognition-'+k);if(input)input.value=String(s.weights?.[k]??1);}
      const threshold=$('#cognition-threshold');if(threshold)threshold.value=String(s.reflectionThreshold||150);
    }
    if(Array.isArray(data.reflections)) {
      const box=$('#cognition-reflections');if(box){box.replaceChildren(make('h4','','有依据的反思'));
        if(!data.reflections.length)box.append(make('p','','尚未积累出可支持的反思。'));
        for(const r of data.reflections.slice(0,6)){const item=make('article','diary-entry');item.append(make('p','',r.text),make('small','',`推断 · ${r.evidence.length}条有效来源 · ${r.personaId?'当前人设':'共用'} · ${String(r.createdAt).slice(0,10)}`));box.append(item);}}
    }
    const box=$('#cognition-plans');if(box){box.replaceChildren(make('h4','','当前交流计划'));
      for(const p of s.plans||[]){const card=make('article','diary-entry');card.append(make('p','',p.goal),make('small','',p.needsReplan?'新交流或来源变化后，等待重新规划':'计划可随当前交流调整'));
        for(const step of p.steps||[])card.append(make('p','',`${step.status==='offered'?'已提过':step.status==='waited'?'已选择等待':'待考虑'} · ${step.text}`));box.append(card);}
      if(!s.plans?.length)box.append(make('p','','等待形成有依据的计划。'));
    }
  }
  async function loadCognition(){try{renderCognition(await api('/api/companion/cognition'));}catch(error){const status=$('#cognition-status');if(status)status.textContent=`读取失败：${error.message}`;}}
  $('#cognition-panel')?.addEventListener('toggle',()=>{if($('#cognition-panel').open)void loadCognition();});
  $('#cognition-save')?.addEventListener('click',async()=>{try{const weights={};for(const k of ['recency','relevance','importance'])weights[k]=Number($('#cognition-'+k).value);
    renderCognition(await api('/api/companion/cognition',{method:'POST',body:json({enabled:$('#cognition-enabled').checked,weights,reflectionThreshold:Number($('#cognition-threshold').value)})}));toast('记忆评分与反思设置已保存');}catch(error){toast(error.message);}});
  $('#daily-review-enabled')?.addEventListener('change', async event => {
    const enabled = event.target.checked;
    try { renderDailyReview(await api('/api/companion/daily-review', {method:'POST',body:json({enabled})})); }
    catch (error) { event.target.checked = !enabled; toast(`更新每日总结失败：${error.message}`); }
  });
  async function loadCompanion({ preserveDrafts = false } = {}) {
    if (companion.loading) return;
    companion.loading = true;
    const drafts = new Map();
    if (preserveDrafts) {
      for (const card of document.querySelectorAll('.memory-card')) {
        drafts.set(card.dataset.memoryId, { text: $('.memory-text', card).value, status: $('.memory-status', card).value });
      }
    }
    const errorBox = $('#companion-error');
    try {
      const data = await api('/api/companion');
      companion.data = { persona: data?.persona || {}, personaProfiles: Array.isArray(data?.personaProfiles) ? data.personaProfiles : [], activePersonaId: data?.activePersonaId || 'mornye', memories: Array.isArray(data?.memories) ? data.memories : [], facts: Array.isArray(data?.facts) ? data.facts : [], revisions: data?.revisions || [], proactive: data?.proactive || {}, news: data?.news || {}, behavior: data?.behavior || {} };
      setPersonaForm(companion.data.persona);
      renderPersonaIdentity(data.identity || state.companion?.identity || {});
      void loadPersonaIdentity();
      renderPersonaProfiles();
      renderProactiveSettings(companion.data.proactive);
      renderNewsSettings(companion.data.news);
      await loadDiary();
      renderBehaviorSettings(companion.data.behavior);
      renderMemories(drafts);
      companion.loaded = true;
      renderCompanionEmotion();
      renderChat();
      errorBox.hidden = true; errorBox.textContent = '';
    } catch (error) {
      errorBox.hidden = false; errorBox.textContent = `无法读取当前人设与记忆：${error.message}。请检查本机中控服务后重试。`;
      $('#memory-list').replaceChildren(make('div', 'empty-state', '记忆暂时无法读取。'));
    } finally { companion.loading = false; }
  }
  function renderBehaviorSettings(value = {}) {
    const panel = $('.behavior-window');
    if (panel) panel.hidden = !Object.keys(value || {}).length;
    for (const key of ['conversation','memory','tasks','reports']) {
      const field = $(`#behavior-${key}`);
      if (field && document.activeElement !== field) field.value = String(value[key] || '');
    }
  }
  $('#behavior-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('.companion-save', event.currentTarget), feedback = $('#behavior-feedback');
    const patch = Object.fromEntries(['conversation','memory','tasks','reports'].map(key => [key, $(`#behavior-${key}`).value]));
    button.disabled = true; feedback.className = 'form-feedback'; feedback.textContent = '正在保存并同步…';
    try {
      const data = await api('/api/companion/behavior', { method: 'POST', body: json(patch) });
      companion.data.behavior = data?.behavior || patch; renderBehaviorSettings(companion.data.behavior);
      feedback.textContent = '已保存；主管和汇报会话从下一轮开始使用。'; toast('中枢行为规则已保存并同步到项目文档');
    } catch (error) { feedback.className = 'form-feedback error'; feedback.textContent = `保存失败：${error.message}`; }
    finally { button.disabled = false; }
  });
  $('#behavior-reset')?.addEventListener('click', () => {
    const button = $('#behavior-reset'), feedback = $('#behavior-feedback');
    button.disabled = true;
    void api('/api/companion/behavior', { method: 'POST', body: json({
      conversation: '自然、具体地回应眼前的话题，允许表达偏好、好奇和情绪。避免客服腔、固定开场、空泛赞美和重复追问；复杂问题先说结论。',
      memory: '记忆跨人设共用。只在相关时引用已记录的经历和偏好；短期细节不要反复提，长期重要信息要稳定保留。用户纠正后以最新说法为准，推测不能说成事实。',
      tasks: '先判断用户是在闲聊、提问还是要求执行。明确任务及时处理并智能路由；只简短说明目标，不编造已派发或已完成状态。',
      reports: '汇报由当前人设结合进度、结果和情境自然组织，不用固定模板。先说最有用的结论；失败、延迟和不确定之处讲清楚，不暴露内部编号、日志和无关附件。',
    }) }).then(data => { companion.data.behavior = data?.behavior || {}; renderBehaviorSettings(companion.data.behavior); feedback.className = 'form-feedback'; feedback.textContent = '已恢复默认行为规则。'; toast('中枢行为规则已恢复默认'); }).catch(error => { feedback.className = 'form-feedback error'; feedback.textContent = `恢复失败：${error.message}`; }).finally(() => { button.disabled = false; });
  });
  async function loadWorkerPool(){
    try{const data=await api('/api/workers'),list=$('#worker-pool-list');list.replaceChildren();
      for(const worker of data.workers){const card=make('article','memory-card');card.append(make('strong','',worker.name));
        card.append(make('p','',worker.running?`工作中 · ${worker.queued} 个任务等待`:worker.queued?`${worker.queued} 个任务等待`:`空闲${worker.hasSession?'':' · 首次派单时建立'}`));
        if(worker.lastTopic)card.append(make('small','',`近期工作：${worker.lastTopic}`));
        if(worker.sessionUrl){const link=make('a','','查看 DSH 会话');link.href=worker.sessionUrl;link.target='_blank';link.rel='noopener';card.append(link);}list.append(card);
      }$('#worker-pool-status').textContent=data.policy;
    }catch(error){$('#worker-pool-status').textContent=error.message;}
  }
  $('#worker-pool-window')?.addEventListener('toggle',event=>{if(event.target.open)void loadWorkerPool();});
  $('#worker-pool-refresh')?.addEventListener('click',()=>void loadWorkerPool());
  setInterval(()=>{if($('#worker-pool-window')?.open)void loadWorkerPool();},15000);
  const tokenCount=value=>value===null||value===undefined?'未知':Number(value).toLocaleString('zh-CN');
  let dailyTokensLoading=false;
  async function loadDailyTokens(){
    if(dailyTokensLoading)return;dailyTokensLoading=true;
    const status=$('#daily-token-status');
    try{
      const date=$('#daily-token-date').value;
      const data=await api('/api/usage/daily'+(date?'?date='+encodeURIComponent(date):''));
      $('#daily-token-date').value=data.date;$('#daily-token-budget').value=data.settings.dailyBudget;
      $('#daily-token-export').href='/api/usage/daily/export?date='+encodeURIComponent(data.date);
      const t=data.totals;$('#daily-token-totals').replaceChildren();
      for(const [name,key] of [['已采集总量','totalTokens'],['输入（含缓存）','inputTokens'],['输出','outputTokens'],['缓存命中（已含在输入内）','cacheReadTokens']])$('#daily-token-totals').append(make('p','',`${name}：${tokenCount(t[key].total)} Token`));
      const lines=(selector,rows)=>{const host=$(selector);host.replaceChildren();for(const row of rows)host.append(make('p','',row));if(!rows.length)host.append(make('p','','尚无采集记录。'));};
      lines('#daily-token-groups',data.groups.map(g=>`${g.engine.toUpperCase()} · ${g.role}：${tokenCount(g.totalTokens.total)} Token`));
      lines('#daily-token-sessions',data.sessions.map(s=>`${s.name}：${tokenCount(s.totalTokens.total)} Token`));
      lines('#daily-token-history',data.history.map(d=>`${d.day}：${tokenCount(d.totalTokens)} Token${d.unknownEntries?'（部分条目缺失用量）':''}`));
      status.textContent=`上海时间统计 · ${t.entries} 条用量记录；${data.coverage.withoutUsage||0} 次运行尚无用量回传；${data.quality.unidentifiedEntries} 条缺少可靠去重标识。${data.budget.exceeded?'已达到每日用量提醒线。':''}`;
      status.className=data.budget.exceeded?'form-feedback error':'form-feedback';
      const old=data.historicalReference;$('#daily-token-reference').textContent=old&&old.entries?`历史日志参考：${tokenCount(old.totalTokens)} Token。${old.note}${old.truncated?'旧日志样本已截断。':''}`:'';
      $('#daily-token-scope').textContent=`${data.scope} ${data.quality.note} 采集启用时间：${new Date(data.settings.collectionStartedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。`;
    }catch(error){status.textContent=error.message;}finally{dailyTokensLoading=false;}
  }
  $('#daily-token-window')?.addEventListener('toggle',event=>{if(event.target.open)void loadDailyTokens();});
  $('#daily-token-form')?.addEventListener('submit',event=>{event.preventDefault();void loadDailyTokens();});
  $('#daily-token-refresh')?.addEventListener('click',()=>void loadDailyTokens());
  $('#daily-token-budget-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
    try{await api('/api/usage/daily/settings',{method:'POST',body:json({dailyBudget:Number($('#daily-token-budget').value)})});await loadDailyTokens();}
    catch(error){$('#daily-token-status').textContent=error.message;}finally{button.disabled=false;}
  });
  setInterval(()=>{if($('#daily-token-window')?.open)void loadDailyTokens();},60000);
  function renderStickers(items) {
    const list=$('#sticker-list');list.replaceChildren();
    for(const item of items){
      const card=make('article','sticker-card'),image=document.createElement('img');
      image.src=item.preview;image.alt=item.title;image.loading='lazy';card.append(image,make('small','',item.title));
      const link=make('a','','来源');link.href=item.source;link.target='_blank';link.rel='noopener noreferrer';card.append(link);
      card.append(make('small','',item.reviewStatus==='favorite'?'已收藏':item.reviewStatus==='approved'?'已审核':'待看图挑选'));
      for(const [decision,label] of [['favorite','喜欢这张'],['rejected','不好看，不再用']]){
        const feedback=make('button','',label);feedback.type='button';feedback.addEventListener('click',async()=>{
          feedback.disabled=true;
          try{await api(`/api/companion/stickers/${encodeURIComponent(item.id)}/review`,{method:'POST',body:json({decision,score:decision==='favorite'?5:0,source:'user'})});const r=await api('/api/companion/stickers');renderStickers(r.items);$('#sticker-status').textContent=decision==='favorite'?'已收藏，今后优先选这类画风。':'已移出可用图库，不会再发送这张。';}
          catch(error){$('#sticker-status').textContent=error.message;feedback.disabled=false;}
        });card.append(feedback);
      }
      const send=make('button','','发到 QQ');send.type='button';send.addEventListener('click',async()=>{
        send.disabled=true;
        try{const r=await api(`/api/companion/stickers/${encodeURIComponent(item.id)}/send`,{method:'POST',body:'{}'});$('#sticker-status').textContent=r.message;}
        catch(error){$('#sticker-status').textContent=error.message;}finally{send.disabled=false;}
      });send.disabled=!['approved','favorite'].includes(item.reviewStatus);card.append(send);list.append(card);
    }
  }
  $('#sticker-window')?.addEventListener('toggle',async event=>{
    if(!event.target.open)return;
    try{const r=await api('/api/companion/stickers');$('#stickers-enabled').checked=r.settings.enabled;$('#stickers-auto-collect').checked=r.settings.autoCollect;renderStickers(r.items);}
    catch(error){$('#sticker-status').textContent=error.message;}
  });
  $('#stickers-enabled')?.addEventListener('change',async event=>{
    const toggle=event.target;toggle.disabled=true;
    try{await api('/api/companion/stickers/settings',{method:'POST',body:json({enabled:toggle.checked})});}
    catch(error){toggle.checked=!toggle.checked;$('#sticker-status').textContent=error.message;}finally{toggle.disabled=false;}
  });
  $('#stickers-auto-collect')?.addEventListener('change',async event=>{
    const toggle=event.target;toggle.disabled=true;try{await api('/api/companion/stickers/settings',{method:'POST',body:json({autoCollect:toggle.checked})});}catch(error){toggle.checked=!toggle.checked;$('#sticker-status').textContent=error.message;}finally{toggle.disabled=false;}
  });
  $('#sticker-search-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;$('#sticker-status').textContent='正在找表情并检查图片…';
    try{const r=await api('/api/companion/stickers/search',{method:'POST',body:json({query:$('#sticker-query').value.trim()})});renderStickers(r.items);$('#sticker-status').textContent=r.message||`找到 ${r.items.length} 张${r.cached?'，来自本机缓存':''}。`;}
    catch(error){$('#sticker-status').textContent=error.message;}finally{button.disabled=false;}
  });
  async function loadTimeline() {
    const status = $('#timeline-status'), list = $('#timeline-list');
    if (!status || !list) return;
    status.textContent = '读取时间线…';
    try {
      const query = $('#timeline-search')?.value.trim() || '';
      const data = await api('/api/companion/timeline?q=' + encodeURIComponent(query));
      list.replaceChildren();
      for (const entry of data.entries || []) {
        const card = make('article', 'memory-card');
        card.append(make('strong', '', `${entry.occurredAt || '日期待确定'} · ${entry.title}`));
        card.append(make('small', '', `${entry.dateBasis} · ${entry.sourceLabel}`));
        if (entry.sourceRefs?.length > 1) card.append(make('small', '', `同内容记录合并展示，共 ${entry.sourceRefs.length} 个来源，原文均保留。`));
        if (entry.relatedIds?.length) card.append(make('small', '', `有 ${entry.relatedIds.length} 条相近记录，原文独立保留。`));
        card.append(make('p', '', entry.text.slice(0, 1000)));
        list.append(card);
      }
      status.textContent = `显示 ${(data.entries || []).length} 条。每分钟自动整理；日期不明的记录排在后面。`;
    } catch (error) { status.textContent = `读取失败：${error.message}`; }
  }
  $('#timeline-window')?.addEventListener('toggle', event => { if (event.target.open) void loadTimeline(); });
  $('#timeline-search-form')?.addEventListener('submit', event => { event.preventDefault(); void loadTimeline(); });
  $('#timeline-refresh')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try { await api('/api/companion/timeline/refresh', { method: 'POST', body: '{}' }); await loadTimeline(); }
    catch (error) { $('#timeline-status').textContent = error.message; }
    finally { event.target.disabled = false; }
  });
  $('#timeline-note-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try {
      await api('/api/companion/timeline/notes', { method: 'POST', body: json({ text: $('#timeline-note').value, title: $('#timeline-title').value, occurredAt: $('#timeline-date').value || undefined }) });
      event.target.reset(); await loadTimeline(); toast('笔记已保存并加入时间线');
    } catch (error) { $('#timeline-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  async function loadPhoneSocial(){
    const status=$('#phone-social-status'),list=$('#phone-social-drafts');if(!status||!list)return;
    try{const data=await api('/api/companion/social');status.textContent=data.phone?.connected?`手机已连接 · ${(data.phone.apps||[]).map(app=>app.name+(app.installed?'已安装':'未安装')).join(' · ')}`:data.phone?.message||'手机未连接';
      list.replaceChildren();const labels={pending:'待你确认',approved:'已确认，等待手机工作席位',submitting:'正在提交，请勿重复',posted:'已核对到评论',uncertain:'结果待核对，不自动重发',cancelled:'已取消',expired:'已过期',needs_attention:'需要处理'};
      for(const draft of data.drafts.slice(0,8)){const card=make('article','memory-card');card.append(make('strong','',`${draft.platform} · ${draft.title}`),make('p','',draft.content),make('small','',labels[draft.status]||draft.status));
        if(draft.error)card.append(make('p','',draft.error));
        if(draft.status==='pending')for(const approve of [true,false]){const button=make('button','system-check',approve?'发布这条评论':'取消草稿');button.type='button';button.addEventListener('click',async()=>{button.disabled=true;try{await api(`/api/companion/social/drafts/${encodeURIComponent(draft.id)}`,{method:'POST',body:json({approve})});await loadPhoneSocial();}catch(error){toast(error.message);button.disabled=false;}});card.append(button);}list.append(card);}
      if(!data.drafts.length)list.append(make('p','empty-state','还没有评论草稿。'));
    }catch(error){status.textContent=`读取失败：${error.message}`;}
  }
  $('#phone-social-window')?.addEventListener('toggle',()=>{if($('#phone-social-window').open)void loadPhoneSocial();});
  setInterval(()=>{if($('#phone-social-window')?.open)void loadPhoneSocial();},15000);
  $('#phone-social-form')?.addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{const result=await api('/api/companion/social/browse',{method:'POST',body:json({platform:$('#phone-social-platform').value,goal:$('#phone-social-goal').value,requestKey:crypto.randomUUID()})});toast(`已交给「${result.sessionTitle}」浏览`);await loadPhoneSocial();}catch(error){$('#phone-social-status').textContent=error.message;}finally{button.disabled=false;}});
  $('#phone-autonomy-enabled')?.addEventListener('change', async event => {
    const toggle = event.target, requested = toggle.checked;
    toggle.disabled = true;
    try {
      const data = await api('/api/companion/proactive', { method: 'POST', body: json({ phoneAutonomyEnabled: requested }) });
      companion.data.proactive = data.proactive;
      renderProactiveSettings(data.proactive);
      toast(requested ? '已允许空闲时自主使用手机' : '已暂停新的手机自主探索，当前任务继续完成');
    } catch (error) { toggle.checked = !requested; toast(`更新手机自主使用设置失败：${error.message}`); }
    finally { toggle.disabled = false; }
  });
  $('#proactive-enabled')?.addEventListener('change', async event => {
    const toggle = event.currentTarget;
    const requested = toggle.checked;
    toggle.disabled = true;
    try {
      const data = await api('/api/companion/proactive', { method: 'POST', body: json({ enabled: requested }) });
      companion.data.proactive = data?.proactive || { enabled: requested };
      renderProactiveSettings(companion.data.proactive);
      toast(requested ? `${companion.data.persona?.name||'当前人设'}会在合适的时候自然联系你` : '已关闭主动联系');
    } catch (error) {
      toggle.checked = !requested;
      toast(`更新主动联系设置失败：${error.message}`);
    } finally { toggle.disabled = false; }
  });
  $('#diary-enabled')?.addEventListener('change', async event => {
    const toggle = event.currentTarget, requested = toggle.checked;
    toggle.disabled = true;
    try { renderDiary(await api('/api/companion/diary', { method: 'POST', body: json({ enabled: requested }) })); toast(requested ? '已开启每日自动日记' : '已暂停自动日记'); }
    catch (error) { toggle.checked = !requested; toast(`更新自动日记失败：${error.message}`); }
    finally { toggle.disabled = false; }
  });
  $('#news-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('.news-save');
    if (!button) return;
    const patch = {
      morningEnabled: $('#news-morning-enabled').checked,
      morningTime: $('#news-morning-time').value,
      breakingEnabled: $('#news-breaking-enabled').checked,
    };
    button.disabled = true;
    try {
      const data = await api('/api/companion/news', { method: 'POST', body: json(patch) });
      companion.data.news = data?.news || patch;
      renderNewsSettings(companion.data.news);
      toast('新闻晨报与提醒设置已保存');
    } catch (error) {
      toast(`保存新闻设置失败：${error.message}`);
      await loadCompanion({ preserveDrafts: true });
    } finally { button.disabled = false; }
  });
  $('#persona-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('.companion-save'); const feedback = $('#persona-feedback');
    button.disabled = true; feedback.className = 'form-feedback'; feedback.textContent = '正在保存…';
    const patch = {
      address: $('#persona-address').value.trim(), name: $('#persona-name').value.trim(),
      avatar: $('#persona-avatar').value, themeColor: $('#persona-theme-color').value,
      qqNickname: $('#persona-qq-nickname').value.trim(), voiceProfileId: $('#persona-voice-profile').value || null,
      reportStyle: $('#persona-report-style').value.trim(),
      reportExamples: $('#persona-report-examples').value.trim().split(/\r?\n\s*\r?\n/).map(group=>group.trim()).filter(Boolean),
      style: $('#persona-style').value.trim(), background: $('#persona-background').value.trim(),
      examples: $('#persona-examples').value.trim().split(/\r?\n\s*\r?\n/).map(group=>group.trim()).filter(Boolean),
    };
    try {
      await api('/api/companion/persona', { method: 'POST', body: json(patch) });
      $('#persona-form').dataset.dirty = 'false';
      feedback.textContent = '人设已保存，QQ同步中/未完成。称呼、风格和表达会从下一条聊天开始生效。';
      toast('人设已保存，下一条聊天开始生效');
      await loadCompanion({ preserveDrafts: true });
      await Promise.all([loadPersonaIdentity(), loadPersonaVoiceProfiles()]);
    } catch (error) { feedback.className = 'form-feedback error'; feedback.textContent = `保存人设失败：${error.message}`; }
    finally { button.disabled = false; }
  });
  $('#persona-form').addEventListener('input', event => {
    if (['persona-report-style','persona-report-examples','persona-address','persona-name','persona-avatar','persona-theme-color','persona-style','persona-background','persona-examples','persona-qq-nickname','persona-voice-profile'].includes(event.target.id)) {
      $('#persona-form').dataset.dirty = 'true';
      if(event.target.id==='persona-avatar'||event.target.id==='persona-theme-color'||event.target.id==='persona-name') {
        applyPersonaAppearance({name:$('#persona-name').value,avatar:$('#persona-avatar').value,themeColor:$('#persona-theme-color').value});
      }
    }
  });
  $('#persona-profile-select')?.addEventListener('change', async event => {
    const select = event.currentTarget;
    if ($('#persona-form').dataset.dirty === 'true' && !window.confirm('当前人设有未保存的修改。切换会丢弃这些修改，继续吗？')) {
      select.value = companion.data.activePersonaId; return;
    }
    select.disabled = true;
    try {
      const data = await api('/api/companion/persona/switch', { method: 'POST', body: json({ id: select.value }) });
      companion.data = { ...companion.data, ...data };
      setPersonaForm(companion.data.persona); renderPersonaProfiles(); renderChat();
      renderPersonaIdentity(data.identity || state.companion?.identity || {});
      await Promise.all([loadPersonaIdentity(), loadPersonaVoiceProfiles()]);
      toast(`已切换到「${companion.data.personaProfiles.find(item => item.id === companion.data.activePersonaId)?.label || '当前人设'}」；记忆保持共用`);
    } catch (error) { toast(`切换人设失败：${error.message}`); await loadCompanion(); }
    finally { select.disabled = false; }
  });
  $('#persona-create')?.addEventListener('click', async () => {
    const label = window.prompt('给新的人设档案起个名字：', '新的人设');
    if (!label?.trim()) return;
    try {
      const data = await api('/api/companion/persona/create', { method: 'POST', body: json({ label: label.trim() }) });
      companion.data = { ...companion.data, ...data }; setPersonaForm(companion.data.persona); renderPersonaProfiles();
      toast('已创建并切换到新档案；长期记忆仍与其他人设共用');
    } catch (error) { toast(`新建人设失败：${error.message}`); }
  });
  $('#persona-rename')?.addEventListener('click', async () => {
    const current = companion.data.personaProfiles.find(item => item.id === companion.data.activePersonaId);
    const label = window.prompt('修改当前人设档案名称：', current?.label || '');
    if (!label?.trim()) return;
    try {
      const data = await api('/api/companion/persona/rename', { method: 'POST', body: json({ label: label.trim() }) });
      companion.data = { ...companion.data, ...data }; renderPersonaProfiles(); toast('档案名称已更新');
    } catch (error) { toast(`重命名失败：${error.message}`); }
  });
  $('#persona-delete')?.addEventListener('click', async () => {
    const current = companion.data.personaProfiles.find(item => item.id === companion.data.activePersonaId);
    if (!current || current.id === 'mornye' || !window.confirm(`删除人设档案「${current.label}」？共享记忆不会删除。`)) return;
    try {
      const data = await api('/api/companion/persona/delete', { method: 'POST', body: json({ id: current.id }) });
      companion.data = { ...companion.data, ...data }; setPersonaForm(companion.data.persona); renderPersonaProfiles(); toast('人设档案已删除，记忆保持不变');
    } catch (error) { toast(`删除人设失败：${error.message}`); }
  });
  $('#persona-reload')?.addEventListener('click', async event => {
    const button=event.currentTarget,feedback=$('#persona-feedback');button.disabled=true;feedback.className='form-feedback';feedback.textContent='正在安全重载中枢…';
    try { await api('/api/system/reload',{method:'POST',body:json({})});feedback.textContent='重载请求已接受；中枢恢复后会沿用当前人设与共用记忆。';toast('中枢正在重载'); }
    catch(error){feedback.className='form-feedback error';feedback.textContent=`重载未开始：${error.message}`;button.disabled=false;}
  });
  async function loadMemoryAudit(result=null) {
    const data=result||await api('/api/companion/memory/audit');
    $('#memory-audit-status').textContent=`整理进度已保存，${data.pending} 条资料需核对。`;
    const list=$('#memory-audit-list');list.replaceChildren();
    for(const item of data.items||[]) {
      const card=make('div','memory-card');card.append(make('p','','历史原话：'+item.quote),make('p','small-note','现有资料：'+(item.conflictWith||'尚无')));
      for(const [action,label] of [['keep-current','保留现有资料'],['review-quote','加入待确认记忆']]) {
        const button=make('button','',label);button.type='button';button.addEventListener('click',async()=>{
          button.disabled=true;
          try{await api(`/api/companion/memory/audit/${encodeURIComponent(item.id)}/resolve`,{method:'POST',body:json({action})});await loadMemoryAudit();await loadCompanion({preserveDrafts:true});}
          catch(error){toast(error.message);button.disabled=false;}
        });card.append(button);
      }
      list.append(card);
    }
    if(!list.childNodes.length)list.append(make('p','small-note','没有待核对的冲突。'));
  }
  $('#memory-audit-window').addEventListener('toggle',()=>{if($('#memory-audit-window').open)void loadMemoryAudit().catch(error=>toast(error.message));});
  $('#memory-audit-scan').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{const result=await api('/api/companion/memory/audit',{method:'POST',body:json({budget:100})});await loadMemoryAudit(result);await loadCompanion({preserveDrafts:true});toast(`本批找到 ${result.candidates} 条候选、${result.conflicts} 条待核对冲突。`);}
    catch(error){toast(error.message);}finally{button.disabled=false;}
  });
  $('#memory-create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#memory-new-text'); const button = $('.memory-add-button'); const text = input.value.trim();
    if (!text) return;
    button.disabled = true;
    try {
      await api('/api/companion/memories', { method: 'POST', body: json({ text, status: $('#memory-new-status').value }) });
      input.value = ''; toast('记忆已添加，下一条聊天开始生效'); await loadCompanion({ preserveDrafts: true });
    } catch (error) { toast(`添加记忆失败：${error.message}`); }
    finally { button.disabled = false; }
  });
  async function saveMemory(memory, text, status, button) {
    if (!text) { toast('记忆内容不能为空'); return; }
    button.disabled = true;
    try {
      await api('/api/companion/memories', { method: 'POST', body: json({ id: memory.id, text, status }) });
      toast('记忆已保存，下一条聊天开始生效'); await loadCompanion({ preserveDrafts: true });
    } catch (error) { toast(`保存记忆失败：${error.message}`); }
    finally { button.disabled = false; }
  }
  async function archiveMemory(memory, button) {
    if (!window.confirm('归档这条记忆？它不会再用于新的聊天，你之后可以随时恢复。')) return;
    button.disabled = true;
    try {
      await api(`/api/companion/memories/${encodeURIComponent(memory.id)}/archive`, { method: 'POST', body: '{}' });
      toast('记忆已归档，可以在这里恢复'); await loadCompanion({ preserveDrafts: true });
    } catch (error) { toast(`归档失败：${error.message}`); }
    finally { button.disabled = false; }
  }
  let stateLoading=null,stateReloadRequested=false,stateReloadTimer=null,lastStateLoad=0;
  function scheduleStateReload() {
    if(stateReloadTimer)return;
    const interval=document.hidden?5000:1000;
    stateReloadTimer=setTimeout(()=>{stateReloadTimer=null;void loadState();if(document.querySelector('[data-page-content="system"].active'))void loadComputerActions();},Math.max(0,lastStateLoad+interval-Date.now()));
  }
  async function loadState() {
    if(stateLoading){stateReloadRequested=true;return stateLoading;}
    lastStateLoad=Date.now();
    stateLoading=refreshState();
    try{return await stateLoading;}finally{stateLoading=null;if(stateReloadRequested){stateReloadRequested=false;scheduleStateReload();}}
  }
  async function refreshState() {
    try {
      const data = await api('/api/state?view=compact');
      for (const key of ['tasks', 'approvals', 'artifacts', 'errors', 'chat', 'health']) state[key] = Array.isArray(data?.[key]) ? data[key] : (data?.[key] || (['health'].includes(key) ? {} : []));
      state.taskCount=data.taskCount;
      if(!taskHistoryStarted)taskHistoryCursor=data.taskCursor||null;
      state.tasks=[...new Map([...taskHistoryPage,...state.tasks].map(task=>[task.id,task])).values()];
      if($('#task-history-more'))$('#task-history-more').hidden=!taskHistoryCursor;
      state.artifactCount = Number.isInteger(data?.artifactCount)?data.artifactCount:state.artifacts.length;
      state.companion = data?.companion || state.companion || {};
      if (companion.loaded && state.companion.proactive) {
        companion.data.proactive = state.companion.proactive;
        renderProactiveSettings(companion.data.proactive);
      }
      if (companion.loaded && state.companion.news) {
        companion.data.news = state.companion.news;
        renderNewsSettings(companion.data.news);
      }
      if (companion.loaded && state.companion.diary && !data.compact) renderDiary({ settings: state.companion.diary, dailyReview: state.companion.dailyReview, entries: state.companion.diary.entries || [] });
      if (companion.loaded && state.companion.cognition) renderCognition({settings:state.companion.cognition});
      if (companion.loaded && state.companion.identity) renderPersonaIdentity(state.companion.identity);
      state.directSession=data?.directSession || {enabled:false,title:'',connected:false};
      state.specialists=data.specialists || {};
      $('#state-error').hidden = true;
      $('#state-error').textContent = '';
      render();
      if (selectedTaskId) void loadTaskEvents(selectedTaskId);
      if ($('#page-archive').classList.contains('active')&&!$('#library-workspace')?.hidden) void loadLibrary();
    } catch (error) {
      setConnection(false, '连接失败');
      $('#state-error').hidden = false; $('#state-error').textContent = `无法读取中控状态：${error.message}`;
    }
  }
  async function loadSystem() {
    try {
      const data = await api('/api/system');
      const guardian = data?.guardian || {};
      const supervisor = guardian.guardian || {};
      const services = guardian.services || {};
      $('#system-primary').textContent = data?.primary ? '主控在线' : '主控状态';
      const parts = [];
      if (supervisor.status) parts.push(`守护进程：${supervisor.status === 'running' ? '运行中' : supervisor.status}`);
      for (const [key, label] of [['hub', '中控'], ['dsh', 'DSH'], ['snowluma', 'SnowLuma'], ['qq-login', 'QQ 登录']]) {
        const service = services[key];
        if (service?.status) parts.push(`${label}：${service.status === 'healthy' ? '正常' : service.status === 'degraded' ? '异常' : service.status}`);
      }
      if (data?.qqMode) parts.push(`QQ 模式：${data.qqMode === 'all' ? '自然消息' : data.qqMode}`);
      if (guardian.updatedAt) parts.push(`心跳：${timeLabel(guardian.updatedAt)}`);
      if (guardian.stale) parts.push('守护心跳已过期');
      if (data?.primary !== undefined) parts.push(`本实例${data.primary ? '为' : '非'}当前主控`);
      $('#system-summary').textContent = parts.join(' · ') || '系统状态已连接。';
      $('#system-check').disabled = false;
      const directorEngine=data?.directorEngine==='codex'?'codex':'dsh';
      const engineSelect=$('#director-engine-select'),engineSave=$('#director-engine-save'),engineFeedback=$('#director-engine-feedback');
      if(engineSelect && document.activeElement!==engineSelect)engineSelect.value=directorEngine;
      if(engineSave)engineSave.disabled=data?.directorBusy===true;
      if(engineSelect)engineSelect.disabled=data?.directorBusy===true;
      if(engineFeedback)engineFeedback.textContent=data?.directorBusy?'主管正在处理这轮对话，完成后可以切换。':`当前接入：${directorEngine==='codex'?'Codex':'DSH 3080'}`;
      const workerSelect=$('#worker-engine-select'),workerFeedback=$('#worker-engine-feedback');
      const workerEngine=['dsh','codex','auto'].includes(data?.workerEngine)?data.workerEngine:'dsh';
      if(workerSelect&&document.activeElement!==workerSelect&&!workerSelect.dataset.dirty)workerSelect.value=workerEngine;
      if(workerFeedback&&!workerSelect?.dataset.dirty)workerFeedback.textContent=`当前任务执行：${workerEngine==='auto'?'自动选择':workerEngine==='codex'?'固定 Codex':'固定 DSH 3080'}`;
      if($('#worker-engine-save'))$('#worker-engine-save').disabled=false;
    } catch (error) {
      $('#system-primary').textContent = '暂不可用';
      $('#system-summary').textContent = `守护状态暂不可用：${error.message}`;
      $('#system-check').disabled = true;
      $('#director-engine-save').disabled = true;
      $('#director-engine-select').disabled = true;
      if($('#worker-engine-save'))$('#worker-engine-save').disabled=true;
    }
  }
  async function loadAgentCompletions(){try{
    const data=await api('/api/agents/completions');$('#agent-completion-enabled').checked=data.enabled;
    $('#agent-completion-status').textContent=`${data.enabled?'已启用':'已暂停'} · 从 ${timeLabel(data.since)} 接收新结果 · ${data.pending} 条待整理${data.lastScan?' · 最近扫描 '+timeLabel(data.lastScan):''}${data.lastError?' · 最近问题：'+data.lastError:''}`;
    const sources=$('#agent-completion-sources');sources.replaceChildren();for(const source of data.sources)sources.append(make('p','',`${source.engine}：${source.mode}`));
    const recent=$('#agent-completion-recent');recent.replaceChildren();for(const row of data.recent){const status=row.status==='completed'?'本轮已完成':row.status==='failed'?'本轮失败':'本轮中断';recent.append(make('p','',`「${row.title}」 · ${status} · ${row.delivery==='sent'?'QQ 已发送':row.delivery==='uncertain'?'发送结果待核对':row.state==='pending'?'待助手整理':'汇报处理中'}`));}
  }catch(error){$('#agent-completion-status').textContent=`读取失败：${error.message}`;}}
  $('#agent-completion-window')?.addEventListener('toggle',()=>{if($('#agent-completion-window').open)void loadAgentCompletions();});
  setInterval(()=>{if($('#agent-completion-window')?.open)void loadAgentCompletions();},15000);
  $('#agent-completion-enabled')?.addEventListener('change',async event=>{const toggle=event.target;toggle.disabled=true;try{await api('/api/agents/completions/settings',{method:'POST',body:json({enabled:toggle.checked})});await loadAgentCompletions();}catch(error){toggle.checked=!toggle.checked;toast(error.message);}finally{toggle.disabled=false;}});
  $('#worker-engine-select')?.addEventListener('change',event=>{event.target.dataset.dirty='true';$('#worker-engine-feedback').textContent='尚未保存，点击“保存任务引擎”后生效。';});
  $('#worker-engine-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const select=$('#worker-engine-select'),button=$('#worker-engine-save'),feedback=$('#worker-engine-feedback');button.disabled=true;
    try{const result=await api('/api/system/worker-engine',{method:'POST',body:json({engine:select.value})});delete select.dataset.dirty;select.value=result.engine;await loadSystem();toast('任务执行引擎已保存，从下一条消息生效');}
    catch(error){feedback.textContent=`保存失败：${error.message}`;}finally{button.disabled=false;}
  });
  $('#director-engine-form')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const select=$('#director-engine-select'),button=$('#director-engine-save'),feedback=$('#director-engine-feedback');
    const requested=select.value;button.disabled=true;feedback.textContent='正在保存主管接入…';
    try {
      const result=await api('/api/system/director-engine',{method:'POST',body:json({engine:requested})});
      select.value=result.engine;
      feedback.textContent=result.changed
        ? result.continuityPending?'已保存；下一条对话会在新引擎接上本地记忆和接续记录。':'已保存；下一条对话会使用所选引擎。'
        : '当前已经使用这个引擎。';
      toast(`主管会话已设为 ${result.engine==='codex'?'Codex':'DSH 3080'}`);
    } catch(error) {
      await loadSystem();
      feedback.textContent=`切换失败：${error.message}`;
      return;
    }
    await loadSystem();
  });
  const computerStatus = value => ({ awaiting_approval: '待你批准', invoking: '正在检查', verification_required: '等待安全确认', verified: '已完成', recovered: '已人工恢复', failed: '检查未成功', denied: '已拒绝', blocked: '暂不可执行', cancelled: '已取消', uncertain: '结果不确定' }[value] || '状态未知');
  function renderComputerActions() {
    const list = $('#computer-action-list'); if (!list) return;
    list.replaceChildren();
    if (!computer.actions.length) { list.append(make('div', 'empty-state', computer.loading ? '正在读取检查状态…' : '还没有电脑检查申请。')); return; }
    for (const action of computer.actions.slice(0, 10)) {
      const card = make('article', `computer-action-card status-${action.status || 'unknown'}`);
      const head = make('div', 'computer-action-head');
      const name = ({ list_apps: '应用列表', list_windows: '窗口列表', get_window_state: '窗口状态与截图', type_text: 'Notepad 文本输入' })[action.tool] || '电脑检查';
      head.append(make('strong', '', name), make('span', 'computer-action-status', computerStatus(action.status)));
      card.append(head, make('p', 'computer-action-summary', action.summary || '操作摘要不可用。'));
      if (action.status === 'awaiting_approval' && action.expiresAt) {
        const expiry = new Date(action.expiresAt);
        card.append(make('p', 'computer-action-hint', Number.isNaN(expiry.valueOf()) ? '这项审批很快会过期。' : `审批有效至 ${expiry.toLocaleTimeString()}`));
      }
      if (action.outcome) card.append(make('p', 'computer-action-outcome', action.outcome));
      if (action.status === 'awaiting_approval') {
        const buttons = make('div', 'computer-action-buttons');
        const approve = make('button', 'system-check computer-approve', '批准'); approve.type = 'button';
        const deny = make('button', 'system-check computer-deny', '拒绝'); deny.type = 'button';
        approve.addEventListener('click', () => answerComputerAction(action.id, 'approve', approve, deny));
        deny.addEventListener('click', () => answerComputerAction(action.id, 'deny', approve, deny));
        buttons.append(approve, deny); card.append(buttons);
      } else if (action.status === 'verification_required') {
        card.append(make('p', 'computer-action-hint', '请检查目标窗口的实际状态。只有确认结果后才会释放桌面操作锁。'));
        const buttons = make('div', 'computer-action-buttons');
        const verified = make('button', 'system-check computer-approve', '确认已完成'); verified.type = 'button';
        const uncertain = make('button', 'system-check computer-deny', '无法确认'); uncertain.type = 'button';
        verified.addEventListener('click', () => verifyComputerAction(action.id, true, verified, uncertain));
        uncertain.addEventListener('click', () => verifyComputerAction(action.id, false, verified, uncertain));
        buttons.append(verified, uncertain); card.append(buttons);
      } else if (action.status === 'uncertain') {
        card.append(make('p', 'computer-action-hint', '结果不确定时桌面保持锁定。请先亲自检查目标窗口和桌面，确认没有操作仍在进行后再解除锁定。'));
        const buttons = make('div', 'computer-action-buttons');
        const recover = make('button', 'system-check computer-deny', '已检查桌面空闲，解除锁定'); recover.type = 'button';
        recover.addEventListener('click', () => recoverComputerAction(action.id, recover));
        buttons.append(recover); card.append(buttons);
      } else if (action.status === 'verified') {
        card.append(make('p', 'computer-action-hint', '检查结果已交给本机视觉会话，分析会出现在对话中。'));
      }
      list.append(card);
    }
  }
  async function loadComputerActions() {
    if (!$('#computer-action-list')) return;
    computer.loading = true; renderComputerActions();
    try {
      const readiness = await api('/api/computer/status');
      const data = await api('/api/computer/actions');
      computer.actions = Array.isArray(data?.actions) ? data.actions : [];
      $('#computer-availability').textContent = data?.mode === 'interactive' ? '已审核控件操作，逐次批准' : data?.mode === 'readonly' ? '本机只读' : '已停用';
      $('#computer-feedback').textContent = '';
    } catch (error) {
      computer.actions = [];
      $('#computer-availability').textContent = error.message.includes('未启用') ? '未启用' : '暂不可用';
      $('#computer-feedback').textContent = error.message;
    } finally { computer.loading = false; renderComputerActions(); }
  }
  async function submitComputerAction(tool, args, conditions={}) {
    const feedback = $('#computer-feedback');
    for (const button of [$('#computer-list-windows'), $('#computer-window-form button')]) button.disabled = true;
    feedback.textContent = '正在提交只读检查申请…';
    try {
      const result = await api('/api/computer/actions', { method: 'POST', body: json({ taskId: 'desktop-inspection', tool, args, ...conditions }) });
      if (result?.action) computer.actions = [result.action, ...computer.actions.filter(item => item.id !== result.action.id)].slice(0, 10);
      feedback.textContent = '申请已提交。请核对下面的实际操作摘要，再明确选择批准或拒绝。';
      renderComputerActions();
    } catch (error) { feedback.textContent = `申请未提交：${error.message}`; }
    finally { for (const button of [$('#computer-list-windows'), $('#computer-window-form button')]) button.disabled = false; }
  }
  async function answerComputerAction(id, op, approve, deny) {
    approve.disabled = true; deny.disabled = true;
    $('#computer-feedback').textContent = op === 'approve' ? '正在执行你批准的操作…' : '正在记录拒绝…';
    try {
      const result = await api(`/api/computer/actions/${encodeURIComponent(id)}/${op}`, { method: 'POST', body: '{}' });
      if (result?.action) computer.actions = computer.actions.map(item => item.id === id ? result.action : item);
      $('#computer-feedback').textContent = op === 'approve' ? (['type_text','click','press_key','scroll'].includes(result.action?.tool) ? '操作已返回并重新读取目标窗口，请检查复核结果后再确认。' : '检查已返回；页面仅显示安全状态，结果会交给本机视觉会话。') : '已拒绝，这项操作没有执行。';
      if(op==='approve'&&result.action?.tool==='get_window_state'){const view=await api(`/api/computer/actions/${encodeURIComponent(id)}/targets`);const select=$('#computer-control-target');select.replaceChildren(new Option('选择刚观察到的控件',''));for(const snapshot of view.targets||[])for(const e of snapshot.elements||[]){select.add(new Option([e.role,e.label].filter(Boolean).join(' · ')||'未命名控件',json({pid:snapshot.pid,window_id:snapshot.window_id,element_token:e.element_token,observationActionId:id})));}}
      renderComputerActions();
    } catch (error) { $('#computer-feedback').textContent = `操作未完成：${error.message}`; approve.disabled = false; deny.disabled = false; }
  }
  async function verifyComputerAction(id, verified, confirmButton, uncertainButton) {
    confirmButton.disabled = true; uncertainButton.disabled = true;
    $('#computer-feedback').textContent = verified ? '正在记录你对实际结果的确认…' : '结果无法确认，正在锁住桌面避免重复操作…';
    try {
      const result = await api(`/api/computer/actions/${encodeURIComponent(id)}/verify`, { method: 'POST', body: json({ verified }) });
      if (result?.action) computer.actions = computer.actions.map(item => item.id === id ? result.action : item);
      $('#computer-feedback').textContent = verified ? '已确认，桌面操作锁已释放。' : '结果仍不确定，桌面暂时保持锁定；请先人工检查。';
      renderComputerActions();
    } catch (error) { $('#computer-feedback').textContent = `验证未完成：${error.message}`; confirmButton.disabled = false; uncertainButton.disabled = false; }
  }
  async function recoverComputerAction(id, button) {
    button.disabled = true;
    $('#computer-feedback').textContent = '正在记录你的人工空闲确认…原动作不会重试。';
    try {
      const result = await api(`/api/computer/actions/${encodeURIComponent(id)}/recover`, { method: 'POST', body: json({ confirmed: true }) });
      if (result?.action) computer.actions = computer.actions.map(item => item.id === id ? result.action : item);
      $('#computer-feedback').textContent = '已按你的人工检查解除桌面锁定，原动作不会自动重试。';
      renderComputerActions();
    } catch (error) { $('#computer-feedback').textContent = `尚未解除桌面锁定：${error.message}`; button.disabled = false; }
  }
  async function searchKnowledge(query) {
    activeSearch = query;
    const submit = $('#search-form button'); submit.disabled = true;
    $('#archive-count').textContent = '搜索中…';
    $('#knowledge-list').replaceChildren(make('div', 'empty-state', '正在搜索…'));
    try {
      const data = await api(`/api/files/results?q=${encodeURIComponent(query)}`);
      searchResults = Array.isArray(data) ? data : (data?.artifacts || data?.records || []);
      archiveResultCount = data.total ?? searchResults.length;
      renderArtifacts(searchResults, archiveResultCount, query ? 'search' : 'recent');
    } catch (error) { $('#archive-count').textContent = '搜索失败'; $('#knowledge-list').replaceChildren(make('div', 'empty-state', `搜索失败：${error.message}`)); }
    finally { submit.disabled = false; }
  }
  $('#chat-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#chat-input'); const text = input.value.trim();
    if (!text) return;
    const button = $('#chat-send'); button.disabled = true; input.disabled = true;
    $('#chat-error').hidden = true;
    try { await api('/api/chat', { method: 'POST', body: json({ text }) }); input.value = ''; await loadState(); }
    catch (error) { $('#chat-error').hidden = false; $('#chat-error').textContent = `消息发送失败：${error.message}`; }
    finally { button.disabled = false; input.disabled = false; input.focus(); }
  });
  let drawingTimer=null,drawingKey=null;
  const drawingLabels={queued:'等待开始',submitting:'正在交接',running:'正在画图',completed:'已完成',failed:'生成失败',uncertain:'结果待核对'};
  async function loadDrawings(initial=false){
    const data=await api('/api/companion/drawings');
    if(!Array.isArray(data.options)){$('#drawing-submit').disabled=true;throw Error('生图新入口等待安全重载；处理现有待选事项后会自动加载更新。');}
    if(initial){$('#drawing-engine').value=data.engine;$('#drawing-submit').disabled=false;for(const option of $('#drawing-engine').options)option.disabled=data.options?.find(x=>x.value===option.value)?.available===false;}
    const list=$('#drawing-list');list.replaceChildren();
    for(const item of data.items||[]){const card=make('article','diary-entry');card.append(make('strong','',item.title),make('p','',`${item.engine==='codex'?'Codex · 生图':'本机生图'} · ${item.phaseLabel||drawingLabels[item.status]||item.status}`));
      if(item.error)card.append(make('p','inline-error',item.error));
      if(item.image){const image=document.createElement('img');image.src=item.image;image.alt=item.title;image.loading='lazy';image.style.maxWidth='100%';card.append(image);card.append(make('small','',item.delivery==='sent'?'QQ 发送接口已确认':item.delivery==='pending'?'等待发送到 QQ':item.delivery==='uncertain'?'QQ 发送结果未知':'尚未发送到 QQ'));}
      list.append(card);
    }
  }
  $('#drawing-open').addEventListener('click',()=>{const dialog=$('#drawing-dialog');if(!dialog.open)dialog.showModal();void loadDrawings(true).catch(e=>{$('#drawing-feedback').textContent=e.message;});clearInterval(drawingTimer);drawingTimer=setInterval(()=>{if(dialog.open)void loadDrawings().catch(()=>{});},5000);});
  $('#drawing-dialog').addEventListener('close',()=>clearInterval(drawingTimer));
  $('#drawing-engine').addEventListener('change',async()=>{try{await api('/api/companion/drawings/settings',{method:'POST',body:json({engine:$('#drawing-engine').value})});$('#drawing-feedback').textContent='已设为默认生图方式，也可以在每次画图时切换。';}catch(e){$('#drawing-feedback').textContent=e.message;await loadDrawings(true);}});
  $('#drawing-form').addEventListener('submit',async event=>{event.preventDefault();const button=$('#drawing-submit');button.disabled=true;drawingKey||=crypto.randomUUID();
    try{const item=await api('/api/companion/drawings',{method:'POST',body:json({title:$('#drawing-name').value,prompt:$('#drawing-prompt').value,engine:$('#drawing-engine').value,share:$('#drawing-share').checked,key:drawingKey})});drawingKey=null;$('#drawing-feedback').textContent=`已交给${item.engine==='codex'?' Codex「生图」会话':'本机生图'}，完成后会显示在这里。`;await loadDrawings();}
    catch(e){$('#drawing-feedback').textContent=`尚未确认提交：${e.message}`;}finally{button.disabled=false;}
  });
  let voiceSettings = null;
  const renderVoiceSettings = data => {
    voiceSettings = data;
    const select = $('#voice-profile');
    select.replaceChildren();
    for (const profile of Array.isArray(data.profiles) ? data.profiles : []) {
      const option = document.createElement('option');
      option.value = String(profile.id ?? '');
      option.textContent = String(profile.label ?? profile.id ?? '未命名音色');
      select.append(option);
    }
    select.value = String(data.profileId ?? '');
    select.disabled = !data.configured || !select.options.length;
    $('#voice-profile-save').disabled = select.disabled;
    $('#voice-enabled').checked = Boolean(data.enabled);
    $('#voice-enabled').disabled = !data.configured;
  };
  $('#voice-settings-open').addEventListener('click', async () => {
    const dialog = $('#voice-settings-dialog');
    $('#voice-settings-feedback').textContent = '正在读取语音设置…';
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api('/api/voice');
      renderVoiceSettings(data);
      $('#voice-settings-feedback').textContent = data.configured ? (data.enabled ? '当前使用语音回复。' : '当前使用文字回复。') : '语音服务尚未配置。';
    } catch (error) { $('#voice-settings-feedback').textContent = `读取失败：${error.message}`; }
  });
  $('#voice-profile-save').addEventListener('click', async () => {
    if (!voiceSettings) return;
    const select = $('#voice-profile'), button = $('#voice-profile-save'), previous = String(voiceSettings.profileId ?? '');
    const requested = select.value;
    button.disabled = true; select.disabled = true; $('#voice-enabled').disabled = true;
    $('#voice-settings-feedback').textContent = '正在切换音色…';
    try {
      const data = await api('/api/voice', { method: 'POST', body: json({ profileId: requested }) });
      renderVoiceSettings(data);
      $('#voice-settings-feedback').textContent = '音色已切换。';
    } catch (error) {
      select.value = previous;
      $('#voice-settings-feedback').textContent = `切换失败：${error.message}`;
    } finally {
      button.disabled = !voiceSettings?.configured || !select.options.length;
      select.disabled = !voiceSettings?.configured || !select.options.length;
      $('#voice-enabled').disabled = !voiceSettings?.configured;
    }
  });
  $('#voice-enabled').addEventListener('change', async event => {
    if (!voiceSettings) return;
    const input = event.currentTarget, previous = Boolean(voiceSettings.enabled), requested = input.checked;
    input.disabled = true; $('#voice-profile').disabled = true; $('#voice-profile-save').disabled = true;
    $('#voice-settings-feedback').textContent = requested ? '正在启用语音回复…' : '正在切换文字回复…';
    try {
      const data = await api('/api/voice', { method: 'POST', body: json({ enabled: requested }) });
      renderVoiceSettings(data);
      $('#voice-settings-feedback').textContent = data.enabled ? '已切换为语音回复。' : '已切换为文字回复。';
    } catch (error) {
      input.checked = previous;
      $('#voice-settings-feedback').textContent = `切换失败：${error.message}`;
    } finally {
      input.disabled = !voiceSettings?.configured;
      $('#voice-profile').disabled = !voiceSettings?.configured || !$('#voice-profile').options.length;
      $('#voice-profile-save').disabled = !voiceSettings?.configured || !$('#voice-profile').options.length;
    }
  });
  $('#direct-session-open').addEventListener('click',()=>{
    const dialog=$('#direct-session-dialog');
    $('#direct-session-feedback').textContent='';
    const search=$('#direct-session-search');
    if(!search.value)search.value='AI助手';
    if(!dialog.open)dialog.showModal();
    void loadDirectSessions(search.value.trim());
  });
  $('#direct-session-cleanup-open').addEventListener('click',()=>{
    $('#direct-session-dialog').close();$('#session-cleanup-dialog').showModal();void loadCleanupSessions();
  });
  $('#session-retention-enabled').addEventListener('change',async event=>{
    const input=event.target;input.disabled=true;
    try{await api('/api/dsh/sessions/retention',{method:'POST',body:json({enabled:input.checked})});await loadCleanupSessions();}
    catch(error){input.checked=!input.checked;$('#session-cleanup-feedback').textContent=error.message;}
    finally{input.disabled=false;}
  });
  $('#session-cleanup-confirm').addEventListener('click',async()=>{
    const button=$('#session-cleanup-confirm'),list=$('#session-cleanup-list');
    const checked=[...list.querySelectorAll('input:checked')],sessionIds=checked.map(item=>item.dataset.sessionId);
    if(!sessionIds.length)return;
    if(!window.confirm(`将 ${sessionIds.length} 个已勾选的 DSH 旧自动会话收纳到归档区，历史仍可恢复。确认继续？`))return;
    button.disabled=true;$('#session-cleanup-feedback').textContent='正在收纳所选会话…';
    try {
      const result=await api('/api/dsh/sessions/cleanup',{method:'POST',body:json({sessionIds})});
      $('#session-cleanup-feedback').textContent=`已收纳 ${result.archived.length} 个旧自动会话。`;
      toast(`已收纳 ${result.archived.length} 个旧自动会话`);await loadCleanupSessions();
    } catch(error){$('#session-cleanup-feedback').textContent=`清理失败：${error.message}`;button.disabled=false;}
  });
  let directSearchTimer;
  $('#direct-session-search').addEventListener('input',()=>{
    clearTimeout(directSearchTimer);directSearchTimer=setTimeout(()=>void loadDirectSessions($('#direct-session-search').value.trim()),220);
  });
  $('#direct-session-exit').addEventListener('click',async()=>{
    const sessionName=state.directSession?.title||'当前 DSH 会话';
    if(!window.confirm(`确定退出 DSH 直连会话“${sessionName}”吗？之后发送的消息会交给主管中枢处理。`))return;
    const button=$('#direct-session-exit');button.disabled=true;
    try{await api('/api/direct-session/exit',{method:'POST',body:'{}'});state.directSession={enabled:false,title:'',connected:false};renderDirectSession();$('#direct-session-feedback').textContent='已退出直连，之后的消息会交给主管中枢。';toast('已退出 DSH 直连');}
    catch(error){$('#direct-session-feedback').textContent=`退出失败：${error.message}`;}
    finally{button.disabled=false;}
  });
  $('#chat-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('input[name="engine"][value="codex"]').addEventListener('change', () => { $('#model-field').hidden = false; });
  $('input[name="engine"][value="dsh"]').addEventListener('change', () => { $('#model-field').hidden = true; });
  $('input[name="engine"][value="workbuddy"]').addEventListener('change', () => { $('#model-field').hidden = true; });
  $('#task-form').addEventListener('submit', async event => {
    event.preventDefault();
    const prompt = $('#task-prompt').value.trim(); if (!prompt) return;
    const engine = $('input[name="engine"]:checked').value;
    const button = $('#task-submit'); const feedback = $('#task-feedback');
    button.disabled = true; feedback.className = 'form-feedback'; feedback.textContent = '正在创建任务…';
    const payload = { engine, prompt };
    if (engine === 'codex' && $('#model-select').value.trim()) payload.model = $('#model-select').value.trim();
    try {
      await api('/api/tasks', { method: 'POST', body: json(payload) });
      $('#task-prompt').value = ''; feedback.textContent = '任务已提交，进度会显示在任务记录中。'; await loadState();
    } catch (error) { feedback.className = 'form-feedback error'; feedback.textContent = `提交失败：${error.message}`; }
    finally { button.disabled = false; }
  });
  $('#search-form').addEventListener('submit', event => { event.preventDefault(); searchKnowledge($('#search-input').value.trim()); });
  document.addEventListener('ai-center:archive-open', () => { void searchKnowledge($('#search-input').value.trim()); });
  $('#library-import-form').addEventListener('submit', async event => {
    event.preventDefault();
    const directory = $('#library-directory').value.trim();
    if (!directory) return;
    const button = $('.library-import-button'); const feedback = $('#library-import-feedback');
    button.disabled = true; feedback.className = 'form-feedback'; feedback.textContent = '正在提交目录导入…';
    renderLibraryWarnings([]);
    try {
      const result = await api('/api/library/import', { method: 'POST', body: json({ directory, recursive: $('#library-recursive').checked }) });
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      library.lastWarnings = warnings;
      const importedCount = Array.isArray(result?.artifacts) ? result.artifacts.length : null;
      feedback.textContent = result?.message || `目录导入完成${importedCount === null ? '' : `：收录 ${importedCount} 份`}；原文件仍保留在原位置。`;
      renderLibraryWarnings(warnings, warnings.length);
      $('#library-directory').value = '';
      await loadLibrary({ query: library.query, category: library.category });
    } catch (error) { feedback.className = 'form-feedback error'; feedback.textContent = `导入失败：${error.message}`; }
    finally { button.disabled = false; }
  });
  $('#library-search-form').addEventListener('submit', event => { event.preventDefault(); loadLibrary({ query: $('#library-search-input').value.trim(), category: library.category }); });
  $('#library-category').addEventListener('change', () => loadLibrary({ query: library.query, category: $('#library-category').value }));
  $('#library-select-all').addEventListener('change', event => {
    const busyIds = activeLibraryJobIds();
    for (const item of library.artifacts) {
      const id = String(item.id);
      if (event.target.checked && libraryCategory(item) === '未分类' && !busyIds.has(id)) library.selected.add(id);
      else library.selected.delete(id);
    }
    renderLibrary();
  });
  $('#library-classify').addEventListener('click', async () => {
    if (!library.selected.size) return;
    const button = $('#library-classify'); const status = $('#library-job-status');
    button.disabled = true; status.textContent = '正在提交给 DSH…';
    try {
      const result = await api('/api/library/classify', { method: 'POST', body: json({ artifactIds: [...library.selected] }) });
      const labels = { queued: '已排队', pending: '已排队', running: '处理中', processing: '处理中', completed: '已完成', failed: '失败' };
      const stateLabel = labels[String(result?.status || '').toLowerCase()];
      status.textContent = stateLabel ? `分类${stateLabel}${result?.jobId || result?.id ? ` · ${result.jobId || result.id}` : ''}` : `分类任务已提交${result?.jobId || result?.id ? ` · ${result.jobId || result.id}` : ''}`;
      library.selected.clear(); await loadLibrary();
    } catch (error) { status.textContent = `提交失败：${error.message}`; }
    finally { updateLibraryActions(); }
  });
  $('#system-check').addEventListener('click', async () => {
    const button = $('#system-check'); const feedback = $('#system-feedback');
    button.disabled = true; feedback.textContent = '正在检查本机服务…';
    try { await api('/api/system/check', { method: 'POST', body: '{}' }); feedback.textContent = '检查请求已完成。'; await loadSystem(); await loadState(); }
    catch (error) { feedback.textContent = `检查失败：${error.message}`; }
    finally { button.disabled = false; }
  });
  $('#computer-list-windows').addEventListener('click', () => submitComputerAction('list_windows', { on_screen_only: true }));
  $('#computer-window-form').addEventListener('submit', event => {
    event.preventDefault();
    const pid = Number($('#computer-pid').value), window_id = Number($('#computer-window-id').value);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(window_id) || window_id < 1) {
      $('#computer-feedback').textContent = 'PID 和窗口 ID 都必须是正整数。'; return;
    }
    void submitComputerAction('get_window_state', { pid, window_id });
  });
  for(const op of ['yield','resume'])$('#computer-'+op).addEventListener('click',async()=>{
    if(op==='resume'&&!confirm('确认桌面已空闲，并允许继续？结果未确认的旧动作仍需单独核验。'))return;
    try{await api('/api/computer/desktop/'+op,{method:'POST',body:json({deviceId:'local',...(op==='resume'?{operatorConfirmedQuiescent:true,userContinues:true}:{})})});$('#computer-lease-state').textContent=op==='yield'?'桌面动作已暂停，业务任务继续':'已允许新动作；旧动作仍按核验状态处理';await loadComputerActions();}catch(error){$('#computer-feedback').textContent=error.message;}
  });
  $('#computer-control-form').addEventListener('submit',event=>{
    event.preventDefault();try{
      const selected=JSON.parse($('#computer-control-target').value),tool=$('#computer-control-tool').value;
      const args={pid:selected.pid,window_id:selected.window_id,element_token:selected.element_token};
      if(tool==='type_text')args.text=$('#computer-control-text').value;
      if(tool==='press_key')args.key=$('#computer-control-text').value;
      if(tool==='scroll'){args.direction='down';args.amount=3;args.by='line';}
      const expected=$('#computer-control-expected').value;
      void submitComputerAction(tool,args,{observationActionId:selected.observationActionId,...(expected?{postcondition:{textContains:expected}}:{})});
    }catch{$('#computer-feedback').textContent='请先读取窗口并选择有效控件。';}
  });
  for(const [id,kind,text] of [['maintenance-run','maintenance','检查中控目前的运行状态；只有真实中控源码缺陷才在隔离仓库修复，外部额度、网络或登录问题报告事实。'],['librarian-run','librarian','整理已有归档文件，更新中文摘要、标签和关联。']]){
    $('#'+id).addEventListener('click',async()=>{
      const button=$('#'+id);button.disabled=true;
      try{await api(`/api/specialists/${kind}/run`,{method:'POST',body:json({text})});toast('已交给专职会话，结果会回到任务记录与 QQ');await loadState();}
      catch(error){toast(error.message);}finally{button.disabled=false;}
    });
  }
  const tabs = [...document.querySelectorAll('.side-tab')];
  function selectPage(target) {
    for (const tab of tabs) {
      const selected = tab.dataset.page === target;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
    for (const page of document.querySelectorAll('.side-page')) {
      const visible = page.dataset.pageContent === target;
      page.hidden = !visible;
      page.classList.toggle('active', visible);
    }
    if (target === 'companion' && !companion.loaded) loadCompanion();
    if (target === 'archive') {if(!$('#library-workspace')?.hidden)loadLibrary();document.dispatchEvent(new Event('ai-center:files-open'));}
    if (target === 'system') { void loadSystem(); void loadComputerActions(); }
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectPage(tab.dataset.page));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      tabs[nextIndex].focus();
      selectPage(tabs[nextIndex].dataset.page);
    });
  }
  $('#menu-toggle').addEventListener('click', () => {
    const open = $('#side-panel').classList.toggle('open'); $('#mobile-backdrop').classList.toggle('show', open); $('#menu-toggle').setAttribute('aria-expanded', String(open));
  });
  $('#mobile-backdrop').addEventListener('click', () => { $('#side-panel').classList.remove('open'); $('#mobile-backdrop').classList.remove('show'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#side-panel').classList.remove('open'); $('#mobile-backdrop').classList.remove('show'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); } });

  loadState();
  loadCompanion();
  loadSystem();
  loadComputerActions();
  const events = new EventSource('/api/events');
  events.addEventListener('update', scheduleStateReload);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleStateReload();});
  events.onerror = () => setConnection(false, '实时连接重连中');
  $('#task-history-more')?.addEventListener('click',async event=>{
    const button=event.target;button.disabled=true;
    try{const page=await api(`/api/tasks/history?limit=40&before=${encodeURIComponent(taskHistoryCursor)}`);taskHistoryStarted=true;taskHistoryPage=page.tasks;taskHistoryCursor=page.nextCursor;showAllTasks=true;$('#task-history-status').textContent='已按需读取一页；原任务记录保留。';await loadState();}
    catch(error){$('#task-history-status').textContent=error.message;}finally{button.disabled=false;}
  });
  setInterval(() => { if (!document.hidden&&events.readyState !== EventSource.OPEN) { loadState(); loadSystem(); } }, 12000);
})();

// Voice playback shares the existing public entry so old running servers do not leave a dead button.
(() => {
  'use strict';
  const $=selector=>document.querySelector(selector),dialog=$('#voice-history-dialog'),list=$('#voice-history-list');
  const audio=$('#voice-player-audio'),player=$('#voice-player'),feedback=$('#voice-history-feedback'),status=$('#voice-player-status');
  if(!dialog||!list||!audio)return;
  let playlist=[],position=0;
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const date=value=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  function playPart(){
    const part=playlist[position];if(!part)return;
    status.textContent=`第 ${position+1} / ${playlist.length} 段`;
    audio.src=part.url;audio.play().catch(()=>{status.textContent='请点播放器里的播放按钮继续。';});
  }
  function play(record,parts){
    playlist=parts;position=0;player.hidden=false;
    $('#voice-player-title').textContent=`${record.voice} · ${date(record.createdAt)}`;
    dialog.close();playPart();
  }
  audio.addEventListener('ended',()=>{if(position+1<playlist.length){position++;playPart();}else status.textContent='播放完毕';});
  audio.addEventListener('error',()=>{status.textContent='音频暂不可用，请刷新记录后重试。';});
  $('#voice-player-close').addEventListener('click',()=>{audio.pause();audio.removeAttribute('src');audio.load();playlist=[];player.hidden=true;});
  async function load(){
    feedback.textContent='正在读取语音记录…';$('#voice-history-refresh').disabled=true;
    try{
      const response=await fetch('/api/voice/recordings',{credentials:'same-origin'}),data=await response.json();
      if(response.status===404){feedback.textContent='语音回放正在等待更新加载。现有任务结束后会自动启用。';return;}
      if(!response.ok)throw Error(data.error||'读取失败');
      list.replaceChildren();const records=data.recordings||[];
      if(!records.length)feedback.textContent='还没有已生成的语音。开启语音模式后，生成的回复会显示在这里。';
      else feedback.textContent='选择一条播放；关闭此窗口或刷新聊天记录，不会打断播放器。';
      for(const record of records){
        const card=node('article');card.className='voice-recording';
        card.append(node('h3',`${record.voice} · ${date(record.createdAt)}`));
        const text=node('p',record.text);text.className='voice-recording-text';card.append(text);
        const all=node('button',`播放全部 ${record.parts.length} 段`);all.type='button';all.addEventListener('click',()=>play(record,record.parts));card.append(all);
        for(const part of record.parts){
          const line=node('div');line.className='voice-recording-part';
          const button=node('button',`播放第 ${part.index+1} 段`);button.type='button';button.addEventListener('click',()=>play(record,[part]));
          const label=part.status==='sent'?'QQ 已确认发送':part.status==='uncertain'||part.status==='sending'?'QQ 发送结果待核对':'本地已生成';
          line.append(button,node('span',label));card.append(line);
        }
        list.append(card);
      }
    }catch(error){feedback.textContent=`语音记录读取失败：${error.message}`;}finally{$('#voice-history-refresh').disabled=false;}
  }
  $('#voice-history-open').addEventListener('click',()=>{$('#voice-settings-dialog').close();dialog.showModal();void load();});
  $('#voice-history-refresh').addEventListener('click',()=>void load());
})();
