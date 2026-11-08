import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// This is recovery of one rejected model request, not a replay of the turn.
// The native loop has not executed this request's tool calls at this boundary.
export function installVisionRequestRecovery(ctx,{database,owns,wait=delay}) {
  const lifetime=new AbortController();
  ctx.on('agent/request-error',async(payload,next)=>{
    const {agent,turn,step,provider,failure,signal}=payload;
    if(provider!=='opencode-go'||failure?.code!=='INVALID_REQUEST'
      ||!/^400\s*:/u.test(String(failure?.message||''))
      ||!String(failure.message).includes('image input is not available on this engine')
      ||!Number.isSafeInteger(turn)||!Number.isSafeInteger(step)||!owns(agent))return next();
    if(signal?.aborted||lifetime.signal.aborted)return;
    const sessionId=agent.session?.id||agent.id;
    if(!sessionId||typeof agent.session?.append!=='function')return next();
    let db,retry;
    try{
      db=new DatabaseSync(database);
      db.exec('CREATE TABLE IF NOT EXISTS vision_request_retries(sessionId TEXT NOT NULL,turn INTEGER NOT NULL,step INTEGER NOT NULL,attempts INTEGER NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(sessionId,turn,step))');
      retry=db.prepare(`INSERT INTO vision_request_retries VALUES(?,?,?,1,?)
        ON CONFLICT(sessionId,turn,step) DO UPDATE SET attempts=attempts+1,updatedAt=excluded.updatedAt
        WHERE attempts<2 RETURNING attempts`).get(sessionId,turn,step,new Date().toISOString())?.attempts;
    }catch{return next();}finally{db?.close();}
    if(!retry)return next();
    const retryId=`hub-vision:${sessionId}:${turn}:${step}`,delayMs=750*retry;
    agent.session.append('llm/retry',{retryId,turn,step,provider,mode:'normal',policyKey:'hub:vision-engine-availability',retry,maxRetries:2,delayMs,
      failure:{code:'INVALID_REQUEST',message:'400: image input is not available on this engine'}});
    const fused=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
    try{await wait(delayMs,undefined,{signal:fused});}catch(error){if(fused.aborted)return;throw error;}
    if(fused.aborted)return;
    agent.session.append('llm/retry-started',{retryId,turn,step,retry});
    return {kind:'retry'};
  });
  ctx.effect?.(()=>()=>lifetime.abort());
}
