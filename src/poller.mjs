// Periodic callers share the current pass instead of building a backlog of
// obsolete passes when one scan takes longer than its timer interval.
export function createPoller(poll,onError=()=>{}) {
  let pending=null,closed=false;
  return {
    run() {
      if(closed)return Promise.resolve();
      if(pending)return pending;
      const current=Promise.resolve().then(()=>{if(!closed)return poll();})
        .catch(onError).finally(()=>{if(pending===current)pending=null;});
      pending=current;
      return current;
    },
    async close() { closed=true;await pending; },
  };
}
