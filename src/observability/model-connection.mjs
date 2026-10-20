// Passive connection evidence from genuine engine outcomes. HTTP readiness
// alone cannot show whether a model is reachable; this observer never probes
// the provider or stores response bodies, credentials or task identifiers.
export class ModelConnection {
  constructor({store,maxAgeMs=15*60*1000}) { this.store=store;this.maxAgeMs=maxAgeMs; }
  state(engine) {
    try { const saved=JSON.parse(this.store.meta('model-connection:'+engine)||'null');
      if(saved && ['online','offline'].includes(saved.status)) {
        const checkedAt=saved.checkedAt||null;
        const ageMs=checkedAt?Date.parse(this.store.now())-Date.parse(checkedAt):Infinity;
        if(!Number.isFinite(ageMs) || ageMs<0 || ageMs>this.maxAgeMs)return {status:'checking',checkedAt,reason:'stale-evidence'};
        return {status:saved.status,checkedAt,reason:saved.status==='online'?'completed':'connection-error'};
      }
    } catch {}
    return {status:'checking',checkedAt:null,reason:'no-terminal-evidence'};
  }
  record({engine,status,error,taskCreatedAt}) {
    if(!engine)return null;
    const connected=status==='completed';
    const connectionFailure=status==='failed' && /connection error|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(String(error||''));
    if(!connected && !connectionFailure)return null;
    let saved=null;
    try { saved=JSON.parse(this.store.meta('model-connection:'+engine)||'null'); } catch {}
    const incomingOrder=Date.parse(taskCreatedAt||'');
    const savedOrder=Date.parse(saved?.taskCreatedAt||'');
    // A long-running old task can fail after a newer task already proved the
    // model works. Do not let that late failure overwrite newer evidence.
    if(Number.isFinite(incomingOrder)&&Number.isFinite(savedOrder)&&incomingOrder<savedOrder)return null;
    const state={status:connected?'online':'offline',checkedAt:this.store.now(),reason:connected?'completed':'connection-error',...(Number.isFinite(incomingOrder)?{taskCreatedAt:new Date(incomingOrder).toISOString()}:saved?.taskCreatedAt?{taskCreatedAt:saved.taskCreatedAt}:{})};
    this.store.meta('model-connection:'+engine,JSON.stringify(state));
    return state;
  }
}
