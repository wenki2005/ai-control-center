import {createHash} from 'node:crypto';

/** Stable review instructions stay in the same native session; facts stay per turn. */
export function reviewContext({guide,persona,loaded='',file}) {
  const text=`${guide}\n当前人设：${persona.name}；称呼：${persona.address}；语气：${persona.style}`;
  const fingerprint=createHash('sha256').update(text).digest('hex');
  return {fingerprint,changed:loaded!==fingerprint,text:loaded===fingerprint
    ?`沿用本会话已加载的回顾规则与当前人设（来源：${file}）。本轮只依据以下资料；历史材料不补作本轮事实。`:text};
}

// Provider input includes cached input. Cache subsets must not trigger an early rollover.
export function contextInputTokens(usage) {
  return Number.isFinite(usage?.inputTokens)&&usage.inputTokens>=0?usage.inputTokens:null;
}
