/**
 * Natural-language authorization policy for director dispatch.
 * Current user assignment wins, followed by the per-request execution setting.
 * Only automatic routing may choose by continuity and capabilities.
 */
export function allowsEngine(prompt, engine) {
  const text = String(prompt?.prompt ?? prompt ?? '');
  const token = engine === 'codex' ? 'Codex' : engine === 'workbuddy' ? 'WorkBuddy' : String(engine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(token + '\\b', 'gi');
  const explicitBefore = /(?:用|使用|通过|让|请|指定|选择|交给|派给|派发给|分配给|发给|给|委托给|指派给|交由|由|找)\s*(?:(?:我|你|他|那个|这边|本轮)\s*)?$/iu;
  const conversationBefore = /(?:跟|和)\s*(?:(?:我|你|他|那个|这边|本轮)\s*)?$/iu;
  const explicitShouldBefore = /(?:应该|应当|本来就该|最好|必须|明确要)\s*(?:把[^，。；！？!?\n\r]{0,12}?)?(?:用|使用|通过|让|交给|派给|派发给|分配给|发给|给|委托给|指派给|交由|由)\s*(?:(?:我|你|他|那个|这边|本轮)\s*)?$/iu;
  const explicitAfter = /^\s*(?:(?:应该|应当|需要|要|来|去|负责|执行)\s*)?(?:(?:来|去)\s*)?(?:帮我|替我|做|修|修改|修复|处理|完成|开发|实现|编写|解决|维护|排查|检查|调研|创建|整理|运行|执行|查|测试)(?!的|能力|方案)/iu;
  const conversationAfter = /^\s*(?:说|沟通|协作)(?!的|能力|方案)/iu;
  const negativeBefore = /(?:不要|别|不必|不应该|不可以|不能|不想|不愿(?:意)?|不希望|不需要|不用|不使用|不交给|不派给|不派发给|不发给|不跟|不和|不是|无需)(?:再\s*)?(?:(?:把[^，。；！？!\?\n\r]{0,14}?)?(?:用|使用|通过|让|交给|派给|派发给|分配给|发给|给|委托给|指派给|交由|由|选|选择)|(?:跟|和))?\s*(?:(?:我|你|他|那个|这边|本轮)\s*)?$/iu;
  const negativeAfter = /^\s*(?:不要|别|不必|不应该|不可以|不能|不想|不愿意|不需要|不用|不使用|不是)(?:\s|$)/iu;
  for (const clause of text.split(/[，,。；;！？!?\n\r]+/)) {
    // An explanation of an earlier routing decision is not a new assignment.
    if(/为什么|怎么(?:会|又|还)|为何/u.test(clause)&&!/(?:现在|这次|本轮|改为|改用|重新|请|帮我).*(?:用|交给|派给|选择)/u.test(clause))continue;
    mention.lastIndex = 0;
    for (const match of clause.matchAll(mention)) {
      const before = clause.slice(Math.max(0, match.index - 48), match.index);
      const after = clause.slice(match.index + match[0].length, match.index + match[0].length + 32);
      if (negativeBefore.test(before) || negativeAfter.test(after)) continue;
      if (explicitBefore.test(before) || explicitShouldBefore.test(before) || explicitAfter.test(after) || (conversationBefore.test(before) && conversationAfter.test(after))) return true;
    }
  }
  return false;
}

/** Preserve the Hub's precedence: codex, then workbuddy, then dsh. */
export function requestedEngine(prompt) {
  const command=parseExplicitEngineCommand(String(prompt?.prompt??prompt??''));
  if(command)return command.engine;
  for (const engine of ['codex', 'workbuddy', 'dsh']) if (allowsEngine(prompt, engine)) return engine;
  return null;
}

/** Phone control targets one shared physical device, so work using it must not overlap. */
export function requiresPhoneResource(prompt) {
  return /(?:手机|安卓|android\s+(?:phone|device)|this\s+phone|QQ模拟|QQ会话)[^\r\n]*(?:控制|操作|打开|浏览|滑动|点击|看|刷|播放|control|use|open|browse|scroll|tap)|(?:控制|操作|打开|浏览|滑动|点击|看|刷|播放|control|operate|open|browse|scroll|tap)[^\r\n]*(?:手机|安卓|android\s+(?:phone|device)|this\s+phone|QQ模拟|QQ会话)/iu.test(String(prompt ?? ''));
}

/** Parse a chat prefix command; returns its normalized engine and prompt. */
export function parseExplicitEngineCommand(text) {
  const match = /^(codex|dsh|workbuddy)\s+([\s\S]+)$/i.exec(String(text ?? ''));
  return match ? { engine: match[1].toLowerCase(), prompt: match[2] } : null;
}

export function requestsBoundInbox(prompt) {
  const text=String(prompt??'');
  const queries=/(?:查看|查找|查阅|查一下|查查|查邮件|看看|看一下|检查|核对|读一下|读取|总结|汇总|整理|有没有|有什么|有哪些|收到[了过]?)/u;
  const mail=/(?:邮箱|收件箱|邮件|电子邮件)/u;
  const otherMailbox=/(?:\b(?:agent(?:ly)?\s*(?:mail|邮箱|收件箱)|gmail|outlook)|@agent\.qq\.com|(?:163|网易|企业微信)\s*(?:邮箱|收件箱))/iu;
  const action=/(?:帮我|替我|顺便|请|然后|再|^\s*)(?:先|去|把.{0,15})?\s*(?:发送|发一[封条]|发邮件|回复|回信|回邮件|转发|删除|标记|移动|授权|登录|绑定|接入)/u;
  return text.split(/[。；;！？!?\n\r]+/u).some(part=>{
    return mail.test(part)&&queries.test(part)&&!otherMailbox.test(part)&&!action.test(part)
      &&!/^(?:\s*(?:不要|别|不用|无需).{0,12}(?:查|看|读|整理))/u.test(part);
  });
}

/**
 * Resolve a proposed dispatch. Directors still require the user to name a
 * non-DSH engine; the second-level coordinator may choose any available engine
 * when the user asked for work but did not pin a particular engine.
 */
export function resolveDispatchEngine({ parentPrompt, proposedEngine, taskPrompt, availableEngines, autoRoute = false, selectedEngine, continuationEngine } = {}) {
  const requested = requestedEngine(parentPrompt);
  if (requested) return requested;
  const original=String(parentPrompt?.prompt??parentPrompt??'');
  if(autoRoute&&(!availableEngines||availableEngines.includes('workbuddy'))&&requestsBoundInbox(original)&&requestsBoundInbox(taskPrompt||original))return 'workbuddy';
  if(selectedEngine==='codex'&&(!Array.isArray(availableEngines)||availableEngines.includes('dsh'))
    &&requiresPhoneResource(`${String(parentPrompt?.prompt??parentPrompt??'')}\n${String(taskPrompt??'')}`))return 'dsh';
  if(selectedEngine&&selectedEngine!=='auto') {
    if(!['dsh','codex','workbuddy'].includes(selectedEngine)||Array.isArray(availableEngines)&&!availableEngines.includes(selectedEngine))throw Error('所选任务引擎当前不可用，请修改任务执行设置；不会自动改派其他引擎。');
    return selectedEngine;
  }
  if(continuationEngine&&(!Array.isArray(availableEngines)||availableEngines.includes(continuationEngine)))return continuationEngine;
  if (autoRoute) {
    const available=Array.isArray(availableEngines)?availableEngines:['dsh','codex','workbuddy'];
    const work=`${String(parentPrompt?.prompt??parentPrompt??'')}\n${String(taskPrompt??'')}`;
    // Prefer the engine with the capability the task actually needs over an
    // arbitrary coordinator guess. Explicit user engine requests still win.
    if(available.includes('dsh') && /(?:手机|安卓|操控.{0,8}手机|控制.{0,8}手机|QQ模拟|QQ会话|DSH(?:内置|原生).{0,8}(?:工具|插件)|(?:打开|播放).{0,10}(?:B站|哔哩哔哩|视频)|(?:browser|mobile).{0,12}(?:control|操作))/iu.test(work))return 'dsh';
    if(available.includes('codex') && /(?:代码|编程|代码库|仓库|源文件|脚本|JavaScript|TypeScript|Python|Node\.?js|\.mjs|\.cjs|\.tsx?|\.jsx?|\.py|单元测试|构建|函数|组件|软件缺陷|代码.{0,8}(?:修复|修改|实现))/iu.test(work))return 'codex';
    if(available.includes(proposedEngine))return proposedEngine;
    if(available.includes('dsh'))return 'dsh';
  }
  if (proposedEngine === 'dsh' || allowsEngine(parentPrompt, proposedEngine)) return proposedEngine;
  const name = proposedEngine === 'codex' ? 'Codex' : proposedEngine === 'workbuddy' ? 'WorkBuddy' : String(proposedEngine);
  throw new Error(`普通任务默认交给 DSH。本轮用户未要求使用 ${name}，请改用 dsh 派发。`);
}
