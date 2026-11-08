export function remoteCapabilities(device){try{return typeof device.capabilities==='string'?JSON.parse(device.capabilities):device.capabilities||{};}catch{return {};}}
export function remoteExecutionPolicy(store,device,engine='dsh'){
 const capabilities=remoteCapabilities(device),chosen=store.meta('remote:execution-policy:'+device.id);
 if(capabilities.work===true&&(!chosen||chosen==='native-work'))return 'native-work';
 if(engine==='codex')return 'native-read-only';
 const policy=chosen||store.meta('remote:dsh-execution-policy:'+device.id);
 return policy==='task-read-only'?'task-read-only':'native-read-only';
}
