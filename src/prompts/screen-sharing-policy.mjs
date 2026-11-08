export function shouldConsiderScreenChat(observation){
 return typeof observation?.summary==='string' && observation.summary.trim().length>0;
}
