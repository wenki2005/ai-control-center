// Serialize only in-flight callbacks. Settled promises must not become a
// second in-memory history of every task or retain the adapter callback graph.
export function enqueueTaskEvent(owner,id,action,onError){
 const previous=owner.chains.get(id)||Promise.resolve();
 const next=previous.then(action).catch(onError);
 owner.chains.set(id,next);
 const clear=()=>{if(owner.chains.get(id)===next)owner.chains.delete(id);};
 void next.then(clear,clear);
 return next;
}
