// Derived from genuine delivered outreach, not an additional model or timer.
// This is character expression state, never evidence about the user's safety.
const POUT_AFTER_MINUTES = 15;

export function waitingForReply(store, now = Date.now()) {
  const idle = { stage: 'calm', intensity: 0, unanswered: 0, waitingMinutes: 0, suppressed: false };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23' }).format(new Date(now)));
  const quiet = hour < 9 || hour >= 23;
  const tableExists=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_message_batches'").get();
  const user = store.db.prepare("SELECT id,text,createdAt FROM companion_chat WHERE role='user' AND retractedAt IS NULL ORDER BY id DESC LIMIT 1").get();
  if (!user) return { ...idle, suppressed: quiet, quiet };
  const unavailable = /(?:先不聊|别催|不要催|别找我|不要找我|不想聊|晚安|睡了|睡觉|开车|开会|在忙|忙一会|等我忙完)/u.test(user.text);
  if (!tableExists) return { ...idle, suppressed: quiet||unavailable, boundary:unavailable, quiet, anchorUserId:user.id };
  const batches = store.db.prepare(`SELECT b.id,MIN(o.updatedAt) sentAt FROM companion_message_batches b
    JOIN companion_message_parts p ON p.batchId=b.id JOIN outbox o ON o.id=p.outboxId
    WHERE b.kind='proactive' AND b.anchorUserId=? AND o.status='sent' GROUP BY b.id ORDER BY sentAt`).all(user.id);
  if (unavailable || quiet) {
    return { ...idle, unanswered:batches.length, suppressed:true, boundary:unavailable,quiet,anchorUserId:user.id,
      batchId:batches[0]?.id||null, meaning:'当前有边界或处于安静时段，暂停主动触达。' };
  }
  if (!batches.length) return { ...idle, suppressed:false, boundary:false,quiet:false,anchorUserId:user.id };
  const firstSentAt = Date.parse(batches[0].sentAt);
  const minutes = Math.max(0, Math.floor((now-firstSentAt)/60000));
  if (!Number.isFinite(minutes)) return idle;
  const adaptive = store.meta('companion:adaptive-outreach') === 'true';
  const longWait = minutes >= POUT_AFTER_MINUTES;
  const allowFollowup = adaptive || (longWait && batches.length === 1);
  // A delivered follow-up in the long-wait phase spends the opportunity for
  // a playful complaint, whether the character used it or chose another topic.
  const followupSent = Date.parse(batches.at(-1).sentAt) >= firstSentAt + POUT_AFTER_MINUTES * 60000;
  const mayPout = longWait && allowFollowup && !followupSent;
  const stage = mayPout ? 'pouting' : longWait ? 'wistful' : 'calm';
  return {
    stage, intensity: mayPout ? 48 : longWait && adaptive ? 32 : 0,
    waitingMinutes:minutes,unanswered:batches.length,suppressed:false,allowFollowup,mayPout,
    anchorUserId:user.id,batchId:batches[0].id,boundary:false,quiet:false,
    meaning: mayPout ? '这次等久了有点闹别扭，可以按人设说一句玩笑气话。' :
      '等回话时可以轻轻带过想念，日常分享按原有节奏进行。'
  };
}
