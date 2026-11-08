import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {INTERACTIVE_CUA_SOCKET,READ_ONLY_CUA_SOCKET,INTERACTIVE_CUA_EFFECTIVE_MANIFEST_SHA256,READ_ONLY_CUA_EFFECTIVE_MANIFEST_SHA256} from './runtime-mode.mjs';
const execute=promisify(execFile);
export function assessCuaStatus(output,{mode='readonly'}={}){
 const socket=mode==='interactive'?INTERACTIVE_CUA_SOCKET:READ_ONLY_CUA_SOCKET;
 const digest=mode==='interactive'?INTERACTIVE_CUA_EFFECTIVE_MANIFEST_SHA256:READ_ONLY_CUA_EFFECTIVE_MANIFEST_SHA256;
 let reason='ready';
 if(!String(output).includes(`socket: ${socket}`))reason='dedicated-pipe-unavailable';
 else if(!/permission mode: bounded \(trusted_startup_configuration\)/i.test(output))reason='permission-mode-mismatch';
 else if(!/capability manifest: configured=true, approved_at_startup=true, valid=true/i.test(output))reason='manifest-not-approved-or-expired';
 else if(!output.toLowerCase().includes(`capability manifest sha256: ${digest}`))reason='manifest-fingerprint-mismatch';
 return {ready:reason==='ready',mode,reason,expectedManifestSha256:digest};
}
// Bounded async checks shared by health and requests; never block the event loop
// with spawnSync or cache a startup failure for the lifetime of the server.
export class CuaRuntimeReadiness{
 constructor({executable,pidFile,cwd,mode='readonly',probe=execute,clock=Date.now,ttlMs=5000}){Object.assign(this,{executable,pidFile,cwd,mode,probe,clock,ttlMs});this.cached=null;this.flight=null;}
 async status(){
  if(this.cached&&this.clock()-this.checkedAt<this.ttlMs)return this.cached;
  if(this.flight)return this.flight;
  this.flight=(async()=>{
   let value;
   try{const r=await this.probe(this.executable,['status','--socket',this.mode==='interactive'?INTERACTIVE_CUA_SOCKET:READ_ONLY_CUA_SOCKET,'--pid-file',this.pidFile],{cwd:this.cwd,windowsHide:true,encoding:'utf8',timeout:2500,maxBuffer:128*1024});value=assessCuaStatus(r.stdout,{mode:this.mode});}
   catch(error){value={ready:false,mode:this.mode,reason:error.killed||error.code==='ETIMEDOUT'?'probe-timeout':error.code==='ENOENT'?'driver-unavailable':'dedicated-pipe-unavailable'};}
   this.checkedAt=this.clock();this.cached={...value,checkedAt:new Date(this.checkedAt).toISOString()};return this.cached;
  })().finally(()=>{this.flight=null;});return this.flight;
 }
}
