/** Last resort after bounded AI retries. Never reinterpret raw executor output as chat. */
export function reportFallback(task={},persona={}) {
  const address=typeof persona==='object'?String(persona?.address||'').trim():'';
  const lead=address?`${address}，`:'';
  const status=task.status==='completed'?'这项工作已经完成':task.status==='failed'?'这项工作没能完成':task.status==='cancelled'?'这项工作已停止':'这项工作的结果暂时还没确认';
  return `${lead}${status}，不过汇报整理出了问题，详细结果还留在中枢里。`;
}
