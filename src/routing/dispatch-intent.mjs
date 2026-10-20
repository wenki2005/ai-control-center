const executionVerb = /(?:修改|改|修复|修|解决|实现|创建|编写|生成|搜索|调研|调查|研究|查找|检查|排查|读取|整理|归档|分类|运行|测试|安装|启动|重启|接入|连接|验证|迁移|部署|打开|删除|移动|导入|扫描|截图|派(?:发|单|一个|个)|续接|收集|改造|构建|制作|编辑|转换|提取|比较|更新|处理|优化|升级|增加|新增|补充|完善|增强|恢复|清理|清除|汇报|通知|发送|推送|监督|跟踪|导出|自检|评估|分析|制定|设计|规划)/u;

/** Only dispatch when the user clearly asks the hub to perform an operation. */
export function hasExplicitExecutionIntent(value) {
  let text=String(value||'').trim();
  if(text.startsWith('[二级协调]')) {
    const original=text.match(/用户原话\s*[：:]([\s\S]*)$/u);
    if(original)text=original[1].trim();
  }
  // Chat may prefix an explicit engine command before the actual imperative.
  text=text.replace(/^(?:codex|dsh|workbuddy)\s+/iu,'').trim();
  if(!text)return false;
  const originalText=text;
  if(/^(?:继续|接着)(?:这个|上面|之前的|刚才的|原来的)?(?:任务|工作|项目|事情)(?:吧)?$/u.test(text))return true;
  const negativeOperation=/(?:不要|不用|无需|不必).{0,10}(?:找|查|搜索|整理|归档|运行|测试|修复|修改|创建|生成|打开|移动|签名|派发|派给|交给)|别(?:去|再)?(?:找|查|搜索|整理|归档|运行|测试|修复|修改|创建|生成|打开|移动|签名|派发|派给|交给)/u;
  text=text.split(/[，,。；;！？?\n]+/u).filter(clause=>!negativeOperation.test(clause)).map(clause=>clause.replace(/^\s*(?:但|但是|不过|而是|然后)\s*/u,'').trim()).filter(Boolean).join('；');
  if(!text)return false;
  const actionClauses=text.split('；').filter(clause=>!/^(?:你好|嗨|哈喽|喂)$/u.test(clause.trim()));
  if(actionClauses.length===1 && /^(?:(?:请|麻烦你)\s*)?(?:(?:你帮我|帮我|替我)\s*)?(?:(?:再|继续|接着)\s*)?(?:处理|做一下)$/u.test(actionClauses[0].trim()))return false;
  // A polite question can still be a direct commission (“能不能帮我修一下？”).
  // Preserve information-only questions and requests to explain how to do it.
  const asksForExplanation=/^(?:能不能|可不可以|可以不可以|你能不能|你可不可以|你觉得能不能).{0,36}(?:告诉我|解释|说明|介绍|教我|指导我|建议我|分析(?:一下)?).{0,24}(?:怎么|如何|为什么|为何|要不要)/u.test(text);
  const asksForInformation=/^(?:(?:请(?:你)?|能不能|可不可以|可以不可以|能否|你觉得)?\s*)(?:告诉我|解释(?:一下)?|说明(?:一下)?|介绍|讲讲|说说|教我|指导我|建议我|分析(?:一下)?)(?=.{0,48}(?:怎么|如何|为什么|为何|是否|要不要))/u.test(text);
  const asksHow=/^(?:怎么|如何|为什么|为何|是不是|是否|要不要|哪里|哪里能|你觉得)(?!.*(?:帮我|替我|麻烦你|请你|我希望你|我想让你).{0,48}(?:修改|修复|修|实现|创建|编写|生成|搜索|调研|查找|检查|排查|运行|测试|安装|整理|更新|优化|升级|完善|清理|处理))/u.test(text);
  if(asksForExplanation || asksForInformation || asksHow)return false;
  // Short Chinese imperatives are common in chat and should not depend on a
  // polite prefix such as “请帮我”. Keep these patterns operation-shaped so
  // questions like “我怎么找文件？” remain in the director conversation.
  const directOperation=/(?:^|[：:\n；;。])\s*(?:(?:然后|接着|继续|先|再|直接|顺便|就|让(?:它|他|她)|我(?:想|希望)?让你|我希望你|你可以|去|帮我|请|麻烦(?:你)?|你帮我)\s*)*(?:找(?:到)?|查找|搜索|搜一下|定位|读取|读一下|检查|排查|整理|归档|运行|测试|修复|解决|修改|创建|生成|编辑|打开|移动|放到|放在|放上|贴到|贴在|放进|插入|签名|派发|派给|交给|优化|升级|新增|补充|完善|增强|恢复|清理|清除|汇报|通知|发送|推送|监督|跟踪|导出|自检|评估|分析|制定|设计|规划|调查|研究)\s*[^？?。；;]{1,120}/u;
  const contextualOperation=/^(?:请(?:你)?|麻烦(?:你)?|帮我|替我|你帮我|我希望你|我想让你)\s*(?:在|到|对)[^，。；;！？?]{1,80}?(?:项目|目录|文件夹|工作区|仓库|环境)(?:里|中)?\s*(?:运行|测试|执行|修复|修改|创建|生成|编辑|检查|整理|处理)\s*[^？?。；;]{1,100}/u;
  const embeddedCommand=/(?:你(?:自己|直接|再|去)?|我希望你|帮我|请你).{0,18}(?:去|再|直接)?(?:找(?:到)?|查找|搜索|搜一下|看看|看一下|识图|识别|检查|排查|读取|整理|归档|派过去|派发给|派给|交给|创建|修改|修复|运行)(?:一下|一下子)?/u;
  const directAssignment=/(?:你)?(?:直接|就)?把.{1,60}(?:全)?(?:派过去|派发给|派给|交给).{0,36}(?:去做|处理|完成|执行|看|找|查|修|整理|运行)?/u;
  // Conversational commissions often place the task before the deliverable:
  // “go assign a session ... make me a detailed report” or “write me a version
  // I can use in an interview”. These are execution requests even without the
  // formal “帮我/请” cue. Keep the match tied to a concrete deliverable so
  // status questions such as “didn't I assign two tasks?” stay conversational.
  const delegatedDeliverable=/(?:去)?派(?:发|一个|个)?(?:.{0,24})(?:会话|工作会话|执行会话|人|agent)(?:.{0,100})(?:给我|替我|帮我).{0,24}(?:出|写|整理|生成|做).{0,32}(?:报告|文档|原理|方案|总结|稿)/u;
  const naturalWritingRequest=/(?:^|[，,。；;])\s*(?:(?:就是|然后|那|再|接着)\s*)?(?:(?:我是想让你|我希望你|我想让你|你|请你|帮我|替我)\s*)?(?:重新)?(?:写|编写|撰写|出)(?:一份|一点|一些|个)?[^。！？?；;]{1,220}(?:给我|面试|口述|稿|报告|文档|讲清楚|更详细|更加细节)/u;
  const clearWritingIntent=/(?:我是想让你|我希望你|我想让你).{0,12}(?:重新)?(?:写|编写|撰写|出)(?:一份|一点|一些|个)/u;
  if(directOperation.test(text) || contextualOperation.test(text) || embeddedCommand.test(text) || directAssignment.test(text) || delegatedDeliverable.test(originalText) || naturalWritingRequest.test(originalText) || clearWritingIntent.test(originalText) || /(?:放上去|贴上去|放到.{0,12}位置|放在.{0,12}位置|把.{1,50}(?:放到|放在|贴到|贴在|插入))/u.test(text))return true;
  if(/(?:帮我|请|麻烦|直接|让(?:它|他|她)).{0,50}(?:把|将).{1,60}(?:放到|放在|贴到|贴在|插入|嵌入|签名处|签名位置)/u.test(text))return true;
  const requestCue=/(?:请(?:你)?|麻烦(?:你)?|帮我|你帮我|替我|我希望你|我想让你|我让你|你(?:自己|直接|再)|能不能(?:请)?(?:你)?(?:帮我|替我)?|可不可以(?:请)?(?:你)?(?:帮我|替我)?|可以不可以(?:请)?(?:你)?(?:帮我|替我)?|能否(?:请)?(?:你)?(?:帮我|替我)?)/u;
  const requestedAction=new RegExp(`${requestCue.source}.{0,52}${executionVerb.source}`,'u');
  if(requestedAction.test(text))return true;
  if(/^(?:怎么|如何|为什么|为何|是不是|是否|要不要|能不能|可不可以|可以不可以|能否|哪里|哪里能|你觉得)/u.test(text) || /[？?]$/u.test(text))return false;
  const operation=/^(?:请(?:你)?|麻烦(?:你)?|能不能(?:请)?(?:你)?|可以(?:请)?(?:你)?|请用.{0,20}?|你帮我|帮我|替我|为我|我希望(?:你)?|我想让你|你再|去|把.{0,24}?|这轮用.{0,20}?|这轮明确交给.{0,20}?|用.{0,20}?)(?:.{0,28}?)$/u;
  for(const match of text.matchAll(new RegExp(executionVerb.source,'gu'))) {
    const before=text.slice(0,match.index);
    if(operation.test(before))return true;
  }
  return /(?:发给|交给).{0,24}(?:让他|让她|让它).{0,8}(?:来|去).{0,8}(?:修|修改|实现|创建|运行|整理|处理|完成)/u.test(text)
    || /(?:这个修复|本次修复|这轮任务).{0,16}(?:应该|需要|最好)?用\s*(?:DSH|Codex|WorkBuddy)/iu.test(text)
    || /(?:交给|使用|用)\s*(?:DSH|Codex|WorkBuddy).{0,24}(?:修|修改|实现|创建|运行|整理|处理|完成)/iu.test(text);
}
