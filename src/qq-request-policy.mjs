/** A media send includes conversion, upload and the final platform acknowledgement. */
export function qqRequestPolicy(action,params={}) {
  const sending=action==='send_private_msg';
  const types=Array.isArray(params.message)?params.message.map(part=>part?.type):[];
  const media=types.some(type=>['record','image','file','video'].includes(type))||typeof params.message==='string'&&/\[CQ:(?:record|image|file|video),/i.test(params.message);
  return {sending,kind:media?'media':sending?'text':'read',timeoutMs:sending?(media?120_000:30_000):15_000};
}

/** Do not include the upstream message, body or URL: those may contain credentials. */
export function qqRequestFailure(cause,{sending,timeoutMs,stage}) {
  const timedOut=cause?.name==='TimeoutError'||cause?.name==='AbortError';
  const category=timedOut?'timeout':stage==='response-body'?'invalid-response':'network';
  const reason=timedOut?`QQ 请求等待超过 ${timeoutMs/1000} 秒`:stage==='response-body'?'QQ 回执无法解析':'QQ 请求连接失败';
  return Object.assign(Error(reason+(sending?'，消息是否已送达仍需确认':'')),{
    uncertain:sending,category,stage,timeoutMs,
  });
}
