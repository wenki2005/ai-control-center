import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';

// Verify one exact session without enumerating every project and history.
// Closing this observation socket does not cancel the native agent turn.
export async function readDshSessionHeader({baseUrl,sessionId,headers,timeoutMs=5000,WebSocketImpl=WebSocket}={}){
 const url=new URL('/api/remote.mux',baseUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
 const streamId=randomUUID(),ws=new WebSocketImpl(url,{headers,maxPayload:1024*1024});
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(ws.readyState===WebSocket.OPEN)ws.close();else ws.terminate();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Object.assign(Error('DSH exact session header timeout'),{retryPreflightSafe:true})),timeoutMs);
  ws.on('error',error=>error.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'?finish(null,null):finish(error));
  ws.on('close',()=>{if(!done)finish(Error('DSH exact session header connection closed'));});
  ws.on('unexpected-response',(_req,response)=>{response.resume();finish(Object.assign(Error('DSH session header HTTP '+response.statusCode),{httpStatus:response.statusCode}));});
  ws.on('open',()=>ws.send(JSON.stringify({type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId},maxMessages:1}}}})));
  ws.on('message',raw=>{
   let frame;try{frame=JSON.parse(String(raw));}catch{return;}
   if(frame.streamId!==streamId)return;
   if(frame.type==='error')return finish(Error('DSH exact session header unavailable'));
   if(frame.type!=='item'||frame.value?.type!=='snapshot')return;
   const header=frame.value.header;
   if(!header?.id||!header?.cwd)return finish(null,null); // older protocol
   if(String(header.id).replace(/^session-/,'')!==sessionId.replace(/^session-/,''))return finish(Error('DSH session header identity mismatch'));
   if(typeof header.cwd!=='string'||!isAbsolute(header.cwd))return finish(Error('DSH session header directory invalid'));
   finish(null,header.cwd);
  });
 });
}
