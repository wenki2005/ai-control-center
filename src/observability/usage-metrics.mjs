const MAX_WINDOW_MS=366*24*60*60*1000;
const EVENT_SAMPLE_LIMIT=10000;
const TOKEN_FIELDS={
  inputTokens:['inputTokens','input_tokens','promptTokens','prompt_tokens'],
  outputTokens:['outputTokens','output_tokens','completionTokens','completion_tokens'],
  totalTokens:['totalTokens','total_tokens'],
  cacheReadTokens:['cacheReadTokens','cache_read_tokens','cachedInputTokens','cached_input_tokens'],
  cacheWriteTokens:['cacheWriteTokens','cache_write_tokens'],
};
const COST_FIELDS={costUsd:['costUsd','totalCostUsd','cost_usd'],inputCostUsd:['inputCostUsd','input_cost_usd'],outputCostUsd:['outputCostUsd','output_cost_usd']};

function hasTable(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name);}
function getField(object,names){for(const name of names){const value=Number(object?.[name]);if(object?.[name]!==undefined&&object?.[name]!==null&&Number.isFinite(value)&&value>=0)return value;}return null;}
function parseObject(value){if(value&&typeof value==='object'&&!Array.isArray(value))return value;try{const parsed=JSON.parse(String(value||''));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;}catch{return null;}}
function firstId(...objects){
  for(const object of objects)for(const key of ['providerRequestId','requestId','usageId','turnId','turn_id','eventId','event_id']) {
    const value=object?.[key];if(typeof value==='string'&&value.trim())return `${key}:${value.trim()}`;
    if(typeof value==='number'&&Number.isFinite(value))return `${key}:${value}`;
  }
  return null;
}
function label(value,allowed){const key=String(value||'').toLowerCase();return allowed.has(key)?key:'unknown';}
const ROLES=new Set(['director','worker','librarian','maintenance','direct','coordinator','narrator']);
const ENGINES=new Set(['dsh','codex','workbuddy','unknown']);

/** Read-only token/cost and report-narration aggregates. Unknown means the
 * source did not provide that field; no prompt, task ID, or payload is returned.
 */
export class UsageMetrics {
  constructor({db,now=Date.now}={}){if(!db?.prepare)throw new TypeError('UsageMetrics requires a SQLite database');this.db=db;this.now=now;}
  snapshot({windowMs=86400000}={}) {
    const duration=Math.max(0,Math.min(Number(windowMs)||0,MAX_WINDOW_MS)),asOfMs=Number(this.now());
    const asOf=new Date(asOfMs).toISOString(),since=new Date(asOfMs-duration).toISOString();
    if(!hasTable(this.db,'events'))return {window:{since,asOf,windowMs:duration},available:false,usage:[],deduplication:{reliableIdEvents:0,eventsWithoutReliableId:0,duplicateEvents:0,quality:'unavailable'},reportNarration:{available:false,eventCount:null,taskCount:null,repeatedTaskCount:null,maxPerTask:null}};
    const eventCols=new Set(this.db.prepare('PRAGMA table_info(events)').all().map(row=>row.name));
    if(!['type','data','createdAt'].every(name=>eventCols.has(name)))return {window:{since,asOf,windowMs:duration},available:false,usage:[],deduplication:{reliableIdEvents:0,eventsWithoutReliableId:0,duplicateEvents:0,quality:'event-schema-incomplete'},reportNarration:{available:false,eventCount:null,taskCount:null,repeatedTaskCount:null,maxPerTask:null}};
    const hasTasks=hasTable(this.db,'tasks');
    const taskCols=hasTasks?new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(row=>row.name)):new Set();
    const canJoin=eventCols.has('taskId')&&taskCols.has('id')&&taskCols.has('role')&&taskCols.has('engine');
    const taskId=eventCols.has('taskId')?'e.taskId':"NULL";
    const safeEngine="CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.engine') END";
    const engineExpr=canJoin?`COALESCE(${safeEngine},t.engine,'unknown')`:`COALESCE(${safeEngine},'unknown')`;
    const roleExpr=canJoin?"CASE WHEN e.type='narrator.usage' THEN 'narrator' ELSE COALESCE(t.role,'unknown') END":"CASE WHEN e.type='narrator.usage' THEN 'narrator' ELSE 'unknown' END";
    const filter="e.createdAt>=? AND e.createdAt<=? AND (e.type IN ('usage','message','narrator.usage') OR e.type='report.narrated')";
    const matchingRows=this.db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${filter}`).get(since,asOf).n;
    // Extract only the usage sub-object and a bounded prefix of it; never load
    // message text or arbitrary event payloads into this read model.
    const sql=`SELECT ${taskId} AS taskId,e.type,e.createdAt,${engineExpr} AS engine,${roleExpr} AS role,
      CASE WHEN json_valid(e.data) THEN substr(COALESCE(json_extract(e.data,'$.usage'),CASE WHEN e.type='usage' THEN e.data END),1,8192) END AS usageData,
      CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.providerRequestId') END AS rootProviderRequestId,
      CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.requestId') END AS rootRequestId,
      CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.usageId') END AS rootUsageId,
      CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.turnId') END AS rootTurnId,
      CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.eventId') END AS rootEventId
      FROM events e ${canJoin?'LEFT JOIN tasks t ON t.id=e.taskId':''} WHERE ${filter} ORDER BY e.createdAt,e.rowid LIMIT ${EVENT_SAMPLE_LIMIT}`;
    const rows=this.db.prepare(sql).all(since,asOf);
    const truncated=matchingRows>rows.length;
    const groups=new Map(),seen=new Set();let reliableIdEvents=0,eventsWithoutReliableId=0,duplicateEvents=0;
    const reportCounts=new Map();let reportEventCount=0;
    for(const row of rows){
      if(row.type==='report.narrated') {
        reportEventCount++;if(row.taskId!==null)reportCounts.set(row.taskId,(reportCounts.get(row.taskId)||0)+1);continue;
      }
      const usage=parseObject(row.usageData);
      if(!usage)continue;
      const stableId=firstId({providerRequestId:row.rootProviderRequestId,requestId:row.rootRequestId,usageId:row.rootUsageId,turnId:row.rootTurnId,eventId:row.rootEventId},usage);
      if(stableId){reliableIdEvents++;const key=`${row.taskId||''}\0${row.engine}\0${stableId}`;if(seen.has(key)){duplicateEvents++;continue;}seen.add(key);}
      else eventsWithoutReliableId++;
      const role=label(row.role,ROLES),engine=label(row.engine,ENGINES),groupKey=`${role}\0${engine}`;
      let group=groups.get(groupKey);if(!group){group={role,engine,events:0,reliableIdEvents:0,eventsWithoutReliableId:0,duplicateEvents:0,values:{}};for(const field of [...Object.keys(TOKEN_FIELDS),...Object.keys(COST_FIELDS)])group.values[field]={sum:0,known:0};groups.set(groupKey,group);}
      group.events++;if(stableId)group.reliableIdEvents++;else group.eventsWithoutReliableId++;
      for(const [field,aliases] of Object.entries({...TOKEN_FIELDS,...COST_FIELDS})){const value=getField(usage,aliases);if(value!==null){group.values[field].sum+=value;group.values[field].known++;}}
    }
    const usageSummary=[...groups.values()].map(group=>({
      role:group.role,engine:group.engine,events:group.events,reliableIdEvents:group.reliableIdEvents,eventsWithoutReliableId:group.eventsWithoutReliableId,
      tokens:Object.fromEntries(Object.entries(TOKEN_FIELDS).map(([field])=>[field,{total:group.values[field].known?group.values[field].sum:null,knownEvents:group.values[field].known,unknownEvents:group.events-group.values[field].known}])),
      cost:Object.fromEntries(Object.keys(COST_FIELDS).map(field=>[field,{total:group.values[field].known?group.values[field].sum:null,knownEvents:group.values[field].known,unknownEvents:group.events-group.values[field].known,currency:'USD'}])),
    })).sort((a,b)=>a.role.localeCompare(b.role)||a.engine.localeCompare(b.engine));
    const counts=[...reportCounts.values()];
    return {window:{since,asOf,windowMs:duration,boundary:'createdAt >= since and createdAt <= asOf'},available:true,usage:usageSummary,
      sample:{limit:EVENT_SAMPLE_LIMIT,selectedEvents:rows.length,matchingEvents:matchingRows,truncated,scope:'usage totals and report.narrated counts cover selected events only when truncated'},
      deduplication:{reliableIdEvents,eventsWithoutReliableId,duplicateEvents,quality:eventsWithoutReliableId?'provider-id-only; events without reliable IDs are counted as stored event rows and may include replay duplicates':'provider-identifiers-deduplicated'},
      reportNarration:{available:eventCols.has('taskId'),eventCount:reportEventCount,taskCount:counts.length,repeatedTaskCount:counts.filter(count=>count>1).length,maxPerTask:counts.length?Math.max(...counts):0,truncated,quality:'per-task event counts; task identifiers are omitted'}};
  }
}
