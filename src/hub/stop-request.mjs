export function parseStopRequest(text){
 const full=String(text||'').trim();if(!full||/^(?:不要|不用|别|不想|我们讨论|我想知道|请解释|能不能告诉我|为什么|怎么|如何|确认)/u.test(full))return null;
 const first=full.split(/[，,；;。！!\n]/u,1)[0].trim();
 const prefix='(?:(?:请|麻烦|帮我|现在|立即|马上|强制|直接|你|给我|先)\\s*)*';
 const objectFirst=new RegExp('^'+prefix+'(?:把|将)\\s*(.{1,100}?)\\s*(?:停止|停掉|停下|停了|终止|取消)(?:一下|吧|呀|啊|了)?$','iu').exec(first);
 const actionFirst=new RegExp('^'+prefix+'(?:停止|停掉|停下|停一下|停|取消|终止|stop|cancel)(?:一下)?(?:\\s*任务)?(?:\\s+|：|:)?(.*)$','iu').exec(first);
 const match=objectFirst||actionFirst;if(!match)return null;
 let target=String(match[1]||'').trim().replace(/(?:吧|呀|啊)$/u,'');
 if(/[?？]|(?:功能|怎么|如何|是否|了吗|没有)$/u.test(target))return null;
 if(/^(?:当前|原|本|这个|那个|现在的)(?:执行|工作)?任务$|^(?:当前|本轮|原来的)$/u.test(target))target='';
 return {target,force:/强制/u.test(full),all:/^(?:所有|全部)(?:的)?(?:任务)?$/u.test(target)};
}
