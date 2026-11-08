// Serialize with the existing internal reporter. No worker seat, shell text
// encoding, QQ delivery or new native session is used just for this check.
export function createRepairModelProbe({store,narrator,modelConnection}) {
  const flights=new Map();
  return {
    run(result){
      if(flights.has(result.id))return flights.get(result.id);
      const operation=(async()=>{
        const saved=store.meta('repair:model-probe:'+result.id);
        const dispatchedAt=JSON.parse(result.baseline||'{}').capturedAt||result.createdAt;
        if(saved){try{const proof=JSON.parse(saved);if(proof.attempt===result.attempts&&Date.parse(proof.checkedAt)>=Date.parse(dispatchedAt)&&Date.parse(store.now())-Date.parse(proof.checkedAt)<60000)return proof;}catch{}}
        const startedAt=store.now();
        const token=await narrator.summarize({task:{id:result.taskId||null,role:'reporter',engine:'dsh',status:'running',prompt:'Internal connection check'},kind:'connection-probe'});
        if(token!=='HUB_PROBE_OK')throw Error('模型未返回连接验收标记');
        const evidence={engine:'dsh',terminal:'completed',checkedAt:store.now(),attempt:result.attempts,scope:'connection-only'};
        modelConnection.record({engine:'dsh',status:'completed',taskCreatedAt:startedAt});
        store.meta('repair:model-probe:'+result.id,JSON.stringify(evidence));
        store.event(result.taskId||null,'internal-repair.connection-verified',{repairId:result.id,...evidence});
        return evidence;
      })().finally(()=>flights.delete(result.id));
      flights.set(result.id,operation);return operation;
    }
  };
}
