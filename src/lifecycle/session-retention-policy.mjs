const timestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value>0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

export function planSessionRetention({
  sessions = [], automaticIds = [], personalIds = [], protectedIds = [], archivedIds = [],
  now = Date.now(), automaticDays = 3, inactiveDays = 15,
} = {}) {
  const automatic = new Set(automaticIds);
  const personal = new Set(personalIds);
  const protectedSet = new Set(protectedIds);
  const archived = new Set(archivedIds);
  const eligible = [];
  const skipped = [];
  const nowMs = timestamp(now);
  const cutoffAuto = automaticDays * 86400000;
  const cutoffInactive = inactiveDays * 86400000;

  for (const session of sessions) {
    const { sessionId } = session;
    let reason = null;
    if (personal.has(sessionId)) reason = 'personal';
    else if (protectedSet.has(sessionId)) reason = 'protected';
    else if (session.running !== false || session.runningKnown !== true) reason = 'running-or-unknown';
    else if (archived.has(sessionId)) reason = 'already-archived';
    else if (!automatic.has(sessionId)) reason = 'not-proven-automatic';
    else if (nowMs === null) reason = 'invalid-now';
    else {
      const created = timestamp(session.createdAt);
      const updated = timestamp(session.updatedAt);
      if ((created !== null && created > nowMs) || (updated !== null && updated > nowMs)) {
        skipped.push({sessionId,reason:'future-time'});continue;
      }
      const age = created !== null && created <= nowMs ? nowMs - created : null;
      const latest = [created, updated].filter((t) => t !== null && t <= nowMs);
      const inactiveAge = latest.length ? nowMs - Math.max(...latest) : null;
      if (age !== null && age > cutoffAuto) reason = 'automatic-age';
      else if (inactiveAge !== null && inactiveAge > cutoffInactive) reason = 'inactive';
      else reason = 'not-old-enough-or-invalid-time';
    }
    (reason === 'automatic-age' || reason === 'inactive' ? eligible : skipped)
      .push({ sessionId, reason });
  }
  return { eligible, skipped };
}
