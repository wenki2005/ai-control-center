import {mkdirSync,existsSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
process.chdir(root);
const runtime=join(root,'runtime');mkdirSync(runtime,{recursive:true});
const configFile=join(runtime,'config.json');
if(!existsSync(configFile))copyFileSync(join(root,'config.example.json'),configFile);
const config=JSON.parse(readFileSync(configFile,'utf8'));
const qqFile=join(runtime,'qq-config.json');
if(config.qqIngressEnabled){
 if(!existsSync(qqFile))throw Error('请先复制 qq-config.example.json 到 runtime/qq-config.json，并配置自己的 QQ 授权。');
 const qqConfig=JSON.parse(readFileSync(qqFile,'utf8'));
 process.env.HUB_QQ_OWNER=process.env.HUB_QQ_OWNER||String(qqConfig.owner||'');
 if(!/^\d{5,20}$/.test(process.env.HUB_QQ_OWNER))throw Error('请配置自己的 QQ owner 账号。');
 process.env.HUB_QQ_CONFIG=qqFile;
 writeFileSync(join(runtime,'qq-ingress-enabled'),'enabled');
}
const {createControlServer}=await import('../src/server.mjs');
const app=await createControlServer({root,runtime,noQq:!config.qqIngressEnabled});
await app.start();console.log('AI 中枢 http://127.0.0.1:'+app.server.address().port);
let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void app.close().then(()=>process.exit(0));};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
