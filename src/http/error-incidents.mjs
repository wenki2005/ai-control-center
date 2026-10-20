const DEFAULT_WINDOW_MS=15*60_000;

export function groupErrorIncidents(errors,{windowMs=DEFAULT_WINDOW_MS}={}) {
  const ordered=[...(Array.isArray(errors)?errors:[])].sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0));
  const incidents=[],latestByMessage=new Map();
  for(const error of ordered) {
    const message=String(error.message||'未知错误');
    const at=Date.parse(error.createdAt);
    const previous=latestByMessage.get(message);
    if(previous && Number.isFinite(at) && previous.anchorAt-at<=windowMs) {
      previous.count++;
      previous.firstSeenAt=error.createdAt;
      previous.resolved=previous.resolved && !!error.resolved;
      if(error.taskTitle && !previous.taskTitles.includes(error.taskTitle))previous.taskTitles.push(error.taskTitle);
      continue;
    }
    const incident={
      createdAt:error.createdAt,firstSeenAt:error.createdAt,message,
      resolved:!!error.resolved,count:1,taskTitles:error.taskTitle?[error.taskTitle]:[],anchorAt:at,
    };
    incidents.push(incident);latestByMessage.set(message,incident);
  }
  return incidents.map(({anchorAt,taskTitles,...incident})=>({
    ...incident,
    taskTitle:taskTitles.length===1?taskTitles[0]:taskTitles.length>1?`${taskTitles.length} 项任务`:null,
    affectedTasks:taskTitles.length,
  }));
}
