/** Acknowledge a consumed terminal event; adapters retain active/approval records. */
export function withTerminalRelease(adapter,task,onEvent) {
  return event=>{
    const terminal=['completed','failed'].includes(event?.type);
    const release=()=>{if(terminal)void Promise.resolve().then(()=>adapter.release?.(task)).catch(()=>{});};
    let value;
    try{value=onEvent(event);}catch(error){release();throw error;}
    if(value&&typeof value.then==='function')return Promise.resolve(value).finally(release);
    release();return value;
  };
}
