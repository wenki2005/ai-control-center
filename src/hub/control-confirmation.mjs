const PENDING_KEY='control:pending-confirmation';
const TTL_MS=120_000;

const commands=new Map([
  ['退出中枢','退出中枢'],['关闭中枢','关闭中枢'],['停止中枢','停止中枢'],
  ['退出直连','退出直连'],['关闭直连','关闭直连'],['结束直连','结束直连'],
  ['关闭修复窗口','关闭修复窗口'],['退出修复窗口','退出修复窗口'],['结束修复','结束修复'],
  ['退出dsh直连','退出DSH直连'],['关闭dsh直连','关闭DSH直连'],['退出dsh当前会话','退出DSH当前会话'],['退出 dsh 直连','退出 DSH 直连'],
  ['停掉当前任务','停掉当前任务'],['停止当前任务','停止当前任务'],['取消当前任务','取消当前任务'],
  ['停止所有任务','停止所有任务'],['取消全部任务','取消全部任务'],
]);
const confirmations=new Set(['确认退出','确认关闭','确认停止','确认执行']);
const cancellations=new Set(['取消','算了','不退出','不关闭','不停止']);
const taskCommandPattern=/^(?:取消|停止任务|终止任务)\s+(t-[\w-]{4,})$/iu;
const namedStopPattern=/^(?:(?:请|麻烦|帮我)\s*)?(?:停掉|停止任务|终止任务)\s+.{1,100}$|^(?:停止|停一下|stop|cancel)$/iu;

function normalized(value) {
  return String(value??'').trim().replace(/\s+/gu,' ').toLocaleLowerCase();
}
function clearPending(store) {
  if(store?.db?.prepare)store.db.prepare('DELETE FROM metadata WHERE key=?').run(PENDING_KEY);
  else store?.meta?.(PENDING_KEY,'');
}
function readPending(store) {
  const raw=store?.meta?.(PENDING_KEY);
  if(!raw)return null;
  try {
    const value=JSON.parse(raw);
    if(value&&typeof value.command==='string'&&typeof value.source==='string'&&Number.isFinite(value.expiresAt))return value;
  } catch { /* Discard invalid persisted confirmation state. */ }
  clearPending(store);
  return null;
}
function clockValue(now) {
  const value=now instanceof Date?now.getTime():Number(now);
  return Number.isFinite(value)?value:Date.now();
}
function askReply(command) {
  const effect=command==='退出中枢'||command==='关闭中枢'||command==='停止中枢'
    ?'退出中枢会停止后台任务结果回传。'
    :command==='停止所有任务'||command==='取消全部任务'
      ?'这会停止所有正在运行或排队中的任务。'
      :taskCommandPattern.test(normalized(command))
        ?`这会停止指定任务“${taskCommandPattern.exec(normalized(command))?.[1]||''}”。`
        :command==='停掉当前任务'||command==='停止当前任务'||command==='取消当前任务'
      ?'这会停止当前任务。'
      :'这会关闭当前直连或修复窗口。';
  return `你要执行“${command}”。${effect}请在 120 秒内回复“确认退出”“确认关闭”“确认停止”或“确认执行”；回复“算了”可取消。`;
}

/** Require an explicit same-source confirmation before executing control commands. */
export function guardControlCommand({store,text,source='web',now=Date.now()}={}) {
  if(!store?.meta)throw new TypeError('store.meta is required');
  const sourceName=String(source||'web');
  const input=String(text??'');
  const normalizedText=normalized(input);
  const at=clockValue(now);
  let pending=readPending(store);
  if(pending&&pending.expiresAt<=at) {clearPending(store);pending=null;}

  if(pending?.source===sourceName) {
    if(cancellations.has(normalizedText)) {
      clearPending(store);
      return {cancelled:true,reply:`已取消“${pending.command}”，不会执行。`};
    }
    if(confirmations.has(normalizedText)) {
      clearPending(store);
      return {confirmed:true,command:pending.command,chatSource:pending.source};
    }
  }

  const targeted=taskCommandPattern.exec(normalizedText);
  const command=commands.get(normalizedText)||(targeted||namedStopPattern.test(input.trim())?input.trim():null);
  if(command) {
    const record={command:input.trim(),source:sourceName,expiresAt:at+TTL_MS};
    store.meta(PENDING_KEY,JSON.stringify(record));
    return {pending:true,reply:askReply(record.command)};
  }

  if(pending?.source===sourceName)clearPending(store);
  return null;
}

export const controlConfirmationKey=PENDING_KEY;
