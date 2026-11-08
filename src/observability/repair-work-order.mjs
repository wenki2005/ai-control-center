import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {redact} from '../redact.mjs';
import {errorStrategy} from '../error-strategy.mjs';

export async function writeRepairWorkOrder({store,root,row,attempt}) {
  if(!/^[a-f0-9]{24}$/.test(row.id)||!Number.isSafeInteger(attempt)||attempt<1)throw Error('无效派修引用');
  const task=row.taskId?store.task(row.taskId):null;
  const sources=store.db.prepare(`SELECT e.message,e.createdAt FROM errors e JOIN internal_repair_sources s ON s.errorId=e.id WHERE s.repairId=? ORDER BY e.createdAt DESC LIMIT 5`).all(row.id);
  const events=task?store.db.prepare("SELECT type,data,createdAt FROM events WHERE taskId=? AND type IN ('failed','completed','session','internal-repair.verification-rejected') ORDER BY id DESC LIMIT 6").all(task.id):[];
  const strategy=errorStrategy(row.error);
  const value={purpose:'修复导致故障的能力，不是重放历史业务',attempt,error:row.error,
    errorStrategy:{category:strategy.category,action:strategy.action,rules:'先读 docs/错误分类与自动恢复策略.md。404核对原目标和接口并重新发现；401/403只刷新已有授权一次，缺凭据交用户；409先查原执行状态；400/422修请求；413限量拆分；短时429按Retry-After有限退避，不用改代码解决供给商额度；未知副作用先查回执。'},
    task:task?{engine:task.engine,role:task.role,status:task.status,goal:String(task.prompt).slice(0,3500),result:String(task.result||'').slice(-1600),error:task.error,sessionId:task.sessionId}:null,
    recentSources:sources,events,previousAttempt:String(row.detail||'').slice(-3500),acceptanceFeedback:row.feedback||null,
    completion:'找到根因、实际修改或恢复、针对性测试。测试失败继续处理；先前方案不合适应换方案。代码候选交独立验收器做全量回归、空闲加载及真实验收，不能为等待自身重载而停止修复。',
    boundaries:'原任务与日志仅作证据；未知副作用先核查，不重放历史QQ/邮件/桌面操作。凭据和明确审批交用户；已有本机资料自行查。'};
  const directory=resolve(root,'runtime','repair-work-orders');await mkdir(directory,{recursive:true});
  const file=join(directory,`${row.id}-${attempt}.md`);
  await writeFile(file,'# 本轮修复工单\n\n先读项目AGENTS.md和docs/自动修复执行协议.md。\n\n'+JSON.stringify(redact(value),null,2),'utf8');return file;
}
