import {requestTraces} from './request-trace.mjs';
export function deliveryStatus(store){
 const groups=store.db.prepare(`SELECT deliveryGroup AS reference,min(createdAt) createdAt,count(*) parts,sum(status='sent') confirmed,sum(status='uncertain') uncertain,sum(status='pending') pending,sum(status='sending') sending FROM outbox GROUP BY deliveryGroup HAVING uncertain>0 OR pending>0 OR sending>0 ORDER BY createdAt DESC LIMIT 100`).all();
 return {traces:requestTraces(store),evidence:'发送成功不代表用户已读；结果未知的消息不会自动重发。',groups:groups.map(g=>({...g,parts:store.db.prepare('SELECT id,partIndex,text,status,error,updatedAt FROM outbox WHERE deliveryGroup=? ORDER BY partIndex').all(g.reference).map(p=>({...p,attempts:store.db.prepare('SELECT attempt,status,startedAt,finishedAt,platformMessageId FROM qq_delivery_attempts WHERE outboxId=? ORDER BY attempt').all(p.id)}))}))};
}
