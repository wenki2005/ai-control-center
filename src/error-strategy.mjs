// Shared decisions, not a blanket fetch wrapper. Callers must prove replay safety.
export function retryAfterMs(value,now=Date.now()) {
 if(value==null||String(value).trim()==='')return null;
 const text=String(value).trim();
 if(/^\d+(?:\.\d+)?$/.test(text)){const ms=Number(text)*1000;return Number.isFinite(ms)?ms:null;}
 const at=Date.parse(text);return Number.isFinite(at)?Math.max(0,at-now):null;
}
export function errorStrategy(error,{attempt=0,now=Date.now(),random=Math.random}={}) {
 const text=[error?.code,error?.message,typeof error==='string'?error:'',error?.cause?.message].filter(Boolean).join(' ');
 const rawStatus=error?.httpStatus??error?.status??error?.cause?.httpStatus;
 const status=Number(rawStatus)||Number(/\b(?:HTTP\s*|status[=: ]*|error[=: ]*)([45]\d{2})\b/i.exec(text)?.[1])||Number(/(?:^|\s|[=:])([45]\d{2})(?=[\s:：.,]|$)/.exec(text)?.[1])||null;
 let category='unknown',action='diagnose',transient=false;
 if(/insufficient[_ -]?quota|quota[_ -](?:exceeded|exhausted)|usage limit exceeded|credit.{0,20}(?:exhausted|insufficient)|billing|payment required|余额不足|额度(?:已)?(?:不足|耗尽|用完)|欠费/i.test(text)||status===402){category='quota-exhausted';action='wait-provider';}
 else if(/context[_ -]?(?:length[_ -]?)?(?:exceeded|limit|full)|maximum context length|prompt.{0,10}too long|上下文.{0,12}(?:超出|超过|已满)/i.test(text)){category='context-limit';action='continue-context';}
 else if(status===429||/rate[_ -]?limit|too many requests|prefill_cap_refused|cell is at capacity|限流/i.test(text)){category='rate-limit';action='retry';transient=true;}
 else if([408,425,500,502,503,504].includes(status)){category='temporary-service';action='retry';transient=true;}
 else if(status===401||status===403||/API key.{0,15}(?:expired|invalid)|unauthorized|invalid_api_key/i.test(text)){category='authentication';action='refresh-auth';}
 else if(status===404||status===410||/session.{0,40}(?:not found|does not exist)|会话.{0,8}不存在/i.test(text)){category='missing-target';action='rediscover-target';}
 else if(status===409||status===412||/already owned by an active write handle|another.{0,15}process.{0,15}writ/i.test(text)){category='conflict';action='reconcile-state';}
 else if(status===413){category='payload-too-large';action='reduce-payload';}
 else if([400,405,415,422].includes(status)||/invalid[_ -]?request|malformed|bad request|schema validation/i.test(text)){category='invalid-request';action='correct-request';}
 else if(/ENOTFOUND|CERT_|certificate|TLS|SSL/i.test(text)){category='configuration';action='check-connection-config';}
 else if(/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|EPIPE|fetch failed|network error|timed?\s*out|TimeoutError/i.test(text)){category='temporary-network';action='retry';transient=true;}
 const uncertain=error?.uncertain===true;
 const retrySafe=error?.retrySafe===true||error?.retryPreflightSafe===true||error?.readOnly===true||error?.idempotent===true;
 if(uncertain){action='verify-outcome';transient=false;}
 const header=error?.retryAfter??error?.headers?.get?.('retry-after');
 const requested=Number.isFinite(error?.retryAfterMs)?Math.max(0,error.retryAfterMs):retryAfterMs(header,now);
 const base=category==='rate-limit'?(/prefill_cap_refused|cell is at capacity/i.test(text)?30000:5000):1000;
 const backoff=Math.min(60000,base*2**Math.max(0,Math.min(10,attempt)));
 const delayMs=Math.max(backoff,requested??0)+Math.floor(Math.max(0,Math.min(1,random()))*Math.min(1000,backoff/5));
 return {category,action,status,transient,retrySafe,autoRetry:transient&&retrySafe&&!uncertain&&attempt<3&&delayMs<=600000,delayMs,maxRetries:3};
}
