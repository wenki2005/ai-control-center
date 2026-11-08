const isoTime = value => {
  if (value === null || value === undefined || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const ageMs = (value, now) => { const parsed = value === null ? NaN : Date.parse(value); return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null; };
const record = value => value && typeof value === 'object' ? value : {};

/** Aggregate device-scoped status without treating cached observations as live work. */
export function buildDeviceManagementView({
  localStatus = {}, remoteState = {}, readJobs = [], now = Date.now(),
  leaseForDevice = () => null, onlineWindowMs = 45_000, freshnessWindowMs = 120_000,
} = {}) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp');
  if (typeof leaseForDevice !== 'function') throw new TypeError('leaseForDevice must be a function');
  const devices = [];
  const local = record(localStatus), localId = typeof local.deviceId === 'string' && local.deviceId ? local.deviceId : 'local';
  const localSeen = isoTime(local.lastSeen);
  const localAge = ageMs(localSeen, now);
  devices.push(makeDevice({
    deviceId: localId, name: local.name || '本机', kind: 'local', online: local.online === true,
    lastSeen: localSeen, capabilities: local.capabilities, permissions: local.permissions,
    sharing: local.sharing, sharingObservedAt: local.sharingObservedAt,
    tasks: normalizeLocalTasks(local.currentTasks, local.currentTask,now,freshnessWindowMs), leaseForDevice, now, freshnessWindowMs,
    statusFreshness: { observedAt: localSeen, ageMs: localAge, fresh: localAge === null ? null : localAge <= onlineWindowMs },
  }));

  const remoteDevices = Array.isArray(remoteState.devices) ? remoteState.devices : [];
  for (const raw of remoteDevices) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id === localId) continue;
    const capabilities = normalizeCapabilities(raw.capabilities);
    const seen = isoTime(raw.lastSeen);
    const age = ageMs(seen, now);
    const online = raw.status === 'approved' && age !== null && age <= onlineWindowMs;
    const observation = record(remoteState.observations?.[raw.id] || (remoteState.observation?.deviceId === raw.id ? remoteState.observation : null));
    const freshAt = isoTime(observation.observation?.capturedAt || observation.lastReceived);
    const freshAge = ageMs(freshAt, now);
    const sharingFresh = online && observation.active === true && freshAge !== null && freshAge <= freshnessWindowMs;
    const jobs = readJobs.filter(job => job?.deviceId === raw.id).map(job=>normalizeRemoteJob(job,now));
    const sharing = { active: !online || typeof observation.active!=='boolean' ? null : observation.active, observedAt: freshAt, fresh: sharingFresh, lastObservedActive:typeof observation.active==='boolean'?observation.active:null };
    devices.push(makeDevice({
      deviceId: raw.id, name: raw.name || raw.id, kind: 'remote', online, lastSeen: seen,
      capabilities, permissions: { status: raw.status || 'unknown', executionPolicy: raw.executionPolicy || null, dshExecutionPolicy: raw.dshExecutionPolicy || null },
      sharing, tasks: jobs, leaseForDevice, now, freshnessWindowMs,
      statusFreshness: { observedAt: seen, ageMs: age, fresh: age === null ? null : age <= onlineWindowMs },
    }));
  }
  return { generatedAt: new Date(now).toISOString(), devices };
}

function normalizeCapabilities(value) {
  const caps = record(value), clientVersion = typeof caps.clientVersion === 'string' ? caps.clientVersion : null;
  return {
    clientVersion,
    compatibility: clientVersion === null ? 'unknown' : clientVersion === '0.2.9' ? 'reported-0.2.9' : 'reported-other',
    reported: {
      nativeSessions: typeof caps.nativeSessions === 'boolean' ? caps.nativeSessions : null,
      messages: typeof caps.messages === 'boolean' ? caps.messages : null,
      work: typeof caps.work === 'boolean' ? caps.work : null,
    },
  };
}

function normalizeLocalTasks(values, legacyValue,now,freshnessWindowMs) {
  const source = Array.isArray(values) ? values : legacyValue ? [legacyValue] : [];
  const result = [], seen = new Set();
  for (const value of source) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || seen.has(value.id)) continue;
    seen.add(value.id);
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(value.status)) continue;
    const native=record(value.nativeEvidence),binding=record(native.binding);
    const bound=value.status!=='queued'&&value.engine==='dsh'&&typeof value.sessionId==='string'&&value.sessionId.length>0&&binding.taskId===value.id&&binding.engine===value.engine&&binding.sessionId===value.sessionId&&binding.runVersion===value.runVersion&&Number.isSafeInteger(value.runVersion);
    const valid=item=>item&&Number.isSafeInteger(item.eventId)&&item.eventId>0&&['session','dsh.prompt-received','dsh.model-started','dsh.tool-activity'].includes(item.type)&&isoTime(item.at)&&Date.parse(isoTime(item.at))<=now;
    const acceptance=bound&&valid(native.acceptance)?native.acceptance:null;
    const activity=bound&&value.status==='running'&&valid(native.activity)&&['dsh.model-started','dsh.tool-activity'].includes(native.activity.type)&&now-Date.parse(isoTime(native.activity.at))<=freshnessWindowMs?native.activity:null;
    result.push({
    taskId: value.id, label:value.label||null, engine: value.engine || null, sessionId: value.sessionId || null,
    status: value.status || 'unknown', source: 'local-task-record', evidence: 'local-task-record',
    centerReceipt:{received:true,receivedAt:isoTime(value.createdAt),evidence:'center-task-record'},
    accepted: acceptance?true:null, acceptedAt:acceptance?isoTime(acceptance.at):null,
    nativeAcceptance:{status:acceptance?'accepted':'unknown',evidence:acceptance?.type||null,eventId:acceptance?.eventId||null},
    execution:{status:activity?'recent-activity':'unknown',observedAt:activity?isoTime(activity.at):null,evidence:activity?.type||null,eventId:activity?.eventId||null},
    completion: { status: 'unknown', evidence: null, completedAt: null },
    });
  }
  return result;
}

function normalizeRemoteJob(job,now) {
  if(['pending','reading','sending'].includes(job.status)&&Number.isFinite(job.createdAt)&&now-job.createdAt>60000)job={...job,status:job.action==='post'&&job.status==='sending'?'uncertain':'expired'};
  const acceptance = job.status === 'completed' && job.action === 'post';
  const uncertain = job.status === 'uncertain';
  const status = acceptance ? 'accepted' : uncertain ? 'uncertain' : ['pending', 'reading', 'sending'].includes(job.status) ? 'pending' : job.status || 'unknown';
  // A remote read-job completion is a receipt for acceptance, not the native task result.
  return {
    taskId: job.id || null, label:job.label||null, engine: job.engine || null, sessionId: job.sessionId || null,
    status, source: 'remote-native-read-job', evidence: acceptance ? 'remote-read-job-receipt' : null,
    accepted: acceptance, acceptedAt: acceptance ? isoTime(job.updatedAt || job.createdAt) : null,
    completion: { status: 'unknown', evidence: null, completedAt: null },
  };
}

function makeDevice({ deviceId, name, kind, online, lastSeen, capabilities, permissions, sharing, tasks, leaseForDevice, now, freshnessWindowMs, statusFreshness }) {
  const lease = leaseForDevice(deviceId) || null;
  const checkedLease = lease && typeof lease === 'object' ? {
    taskId: typeof lease.taskId === 'string' ? lease.taskId : null,
    state: typeof lease.state === 'string' ? lease.state : 'unknown',
    expiresAt: Number.isFinite(lease.expiresAt) ? lease.expiresAt : null,
    updatedAt: isoTime(lease.updatedAt),
    fresh: Number.isFinite(lease.expiresAt) ? lease.expiresAt > now : null,
  } : null;
  return {
    deviceId, name, kind, online, lastSeen,
    statusAgeMs: ageMs(lastSeen, now), statusFreshness, capabilities: kind === 'remote' ? capabilities : record(capabilities),
    permissions: permissions || {}, sharing,
    currentTasks: tasks,
    desktopLease: checkedLease,
    freshnessWindowMs,
  };
}
