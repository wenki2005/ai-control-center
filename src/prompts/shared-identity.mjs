// Migrate only known factory guidance. Personal cards, memories and unrelated
// user additions are never passed through a global name replacement.
export function sharedPersonaGuide(text) {
  const prefixes=['本文件说明主管会话','- 已记录的偏好、称呼','- 通常简短；','- 你忙或难受时','- 闲聊不只沿着你的问题答','- 主动联系时可以由助手自己的好奇','- 时间与环境只在当前话题','- 没有实时天气数据时','- 你说“QQ发我”','- 以助手的第一人称自然生活和交谈'];
  return String(text).split('\n').map(line=>{
    if(line==='# 助手｜陪伴与表达说明')return '# AI 中枢｜陪伴与表达说明';
    if(line.startsWith('- 安静、理性、细致，'))line=line.replace('安静、理性、细致，温和而有自己的判断','语气和性格以当前人设卡为准，保持自己的判断');
    if(line.startsWith('- 安静内敛不等于永远被动。'))line=line.replace('安静内敛不等于永远被动。','主动和安静的程度以当前人设为准。');
    return prefixes.some(prefix=>line.startsWith(prefix))?line.replaceAll('你','用户').replaceAll('助手','当前人物'):line;
  }).join('\n');
}
