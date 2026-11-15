export const isMenuCommand=text=>/^(?:菜单|功能菜单|帮助菜单)$/u.test(String(text||'').trim());
export function voiceModeCommand(text){
  const value=String(text||'').trim().replace(/[。！!]+$/u,'');
  // Parse explicit whole-message settings commands, not mentions inside tasks,
  // quotations, negations or questions about how the feature works.
  if(/^(?:关闭|关掉|停用)语音$/u.test(value))return false;
  const request=value.replace(/^(?:请你|请|麻烦你|麻烦|你帮我|帮我|给我)/u,'');
  const direct=/^(?:开启|打开|启用|切回|切换(?:到|成|为)?|切成|改成|改为|换成|用|使用)(语音|文字)(?:回复|回答|模式)?(?:吧|就好|就行)?$/u.exec(request);
  const contextual=/^(?:你)?(?:把)?(?:(?:你(?:的)?)?(?:这个|当前)?)?(?:回复方式|回复模式|回答方式|回答模式|输出方式)(?:改成|改为|换成|切换到|切换成|切换为|设为)(语音|文字)(?:回复|模式)?(?:吧|就好|就行)?$/u.exec(request);
  if(direct||contextual)return (direct||contextual)[1]==='语音';
  return null;
}

export function quickMenu(store) {
  const voice=store.meta('qq:voice-enabled')==='true';
  const channel=store.meta('repairWindowMode')==='on'?'Codex 直连':store.meta('directSessionMode')==='on'?'DSH 直连':'主管对话';
  return `常用菜单\n当前：${voice?'语音回复（全文分段）':'文字回复'} · ${channel}\n\n切回文字：用文字回复\n切回语音：用当前音色分段朗读所有文字回复\n直连：原话连接本机 Codex 修复窗口\n退出直连：返回主管对话，需二次确认\nDSH直连：连接 DSH 当前会话\n共享屏幕：在电脑上选择共享屏幕或窗口\n状态：查看任务进度\nGM 开启：进入独立角色扮演，GM 帮助查看回退与编辑命令\n菜单：再次查看这些提示\n\n直接发送对应命令即可。长报告、链接和代码也会分段朗读，原文保留在中枢。`;
}
