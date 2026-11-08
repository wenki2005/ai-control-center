import {errorStrategy} from './error-strategy.mjs';
const key=id=>'qq-delivery-retry:'+id;
function saved(store,id){try{return JSON.parse(store.meta(key(id))||'{}');}catch{return {};}}
export function deliveryRetryReady(store,id,now=Date.now()){return !(saved(store,id).nextAt>now);}
export function rejectedDelivery(store,row,error,{now=Date.now(),random=Math.random}={}){
 if(error?.uncertain!==false)return {status:'uncertain',category:'unknown-outcome',action:'verify-outcome'};
 const prior=saved(store,row.id),attempt=Number(prior.attempts||0);
 const plan=errorStrategy(Object.assign(Error(error.message),error,{retrySafe:true}),{attempt,now,random});
 const retry=plan.autoRetry&&now+plan.delayMs-(prior.startedAt??now)<=600000;
 const state={attempts:attempt+1,startedAt:prior.startedAt??now,nextAt:retry?now+plan.delayMs:0};
 store.meta(key(row.id),JSON.stringify(state));
 store.event(null,'qq.error-strategy',{outboxId:row.id,category:plan.category,action:plan.action,httpStatus:plan.status,retry,attempt:state.attempts,...(retry?{nextAt:new Date(state.nextAt).toISOString()}:{})});
 return {status:retry?'pending':'failed',category:plan.category,action:plan.action,nextAt:state.nextAt};
}
