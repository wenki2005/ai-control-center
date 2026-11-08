// Derived from genuine delivered outreach, not an additional model or timer.
// This is character expression state, never evidence about the user's safety.
export function waitingForReply(store, now = Date.now()) {
  const idle = { stage: 'calm', intensity: 0, unanswered: 0, waitingMinutes: 0, suppressed: false };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23' }).format(new Date(now)));
  const quiet = hour < 9 || hour >= 23;
  const tableExists=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_message_batches'").get();
  const user = store.db.prepare("SELECT id,text,createdAt FROM companion_chat WHERE role='user' AND retractedAt IS NULL ORDER BY id DESC LIMIT 1").get();
  if (!user) return { ...idle, suppressed: quiet, quiet };
  const unavailable = /(?:先不聊|别催|不要催|别找我|不要找我|不想聊|晚安|睡了|睡觉|开车|开会|在忙|忙一会|等我忙完)/u.test(user.text);
  if (!tableExists) return { ...idle, suppressed: quiet||unavailable, boundary:unavailable, quiet, anchorUserId:user.id };
  if(unavailable||quiet) {
    const batches = store.db.prepare(`SELECT b.id,MIN(o.updatedAt) sentAt FROM companion_message_batches b
      JOIN companion_message_parts p ON p.batchId=b.id JOIN outbox o ON o.id=p.outboxId
      WHERE b.kind='proactive' AND b.anchorUserId=? AND o.status='sent' GROUP BY b.id ORDER BY sentAt`).all(user.id);
    return { ...idle, unanswered:batches.length, suppressed:true, boundary:unavailable,quiet,anchorUserId:user.id,
      batchId:batches[0]?.id||null, meaning:'当前有边界或处于安静时段，暂停主动触达。' };
  }
  const batches = store.db.prepare(`SELECT b.id,MIN(o.updatedAt) sentAt FROM companion_message_batches b
    JOIN companion_message_parts p ON p.batchId=b.id JOIN outbox o ON o.id=p.outboxId
    WHERE b.kind='proactive' AND b.anchorUserId=? AND o.status='sent' GROUP BY b.id ORDER BY sentAt`).all(user.id);
  if (!batches.length) return { ...idle, suppressed:false, boundary:false,quiet:false,anchorUserId:user.id };
  const minutes = Math.max(0, Math.floor((now-Date.parse(batches[0].sentAt))/60000));
  if (!Number.isFinite(minutes)) return idle;
  const suppressed=false;
  if(store.meta('companion:adaptive-outreach')==='true')return {
    stage:minutes<45?'calm':minutes<240?'missing':'wistful',intensity:minutes<45?0:32,
    waitingMinutes:minutes,unanswered:batches.length,suppressed:false,allowFollowup:true,
    anchorUserId:user.id,batchId:batches[0].id,boundary:false,quiet:false,
    meaning:'用户已开启自主联系；按本轮节奏可以换话题分享，未回复本身不是暂停条件，不要求回应。'
  };
  // A check is only a chance to consider a message. A single gentle follow-up
  // is eligible after a long pause; further silence never raises the pressure.
  const stage=suppressed||minutes<45?'calm':minutes<240?'missing':'wistful';
  const allowFollowup=!suppressed&&batches.length===1&&minutes>=240;
  return { stage, intensity:stage==='missing'?28:allowFollowup?32:0,
    waitingMinutes:minutes,unanswered:batches.length,suppressed,
    allowFollowup,anchorUserId:user.id,batchId:batches[0].id,boundary:false,quiet:false,
    meaning:'已送出主动消息后的一点惦记；未回复不等于已读、不在意或发生危险。' };
}
