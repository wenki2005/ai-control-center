import{existsSync,readFileSync,readdirSync}from'node:fs';
import{join}from'node:path';
export function remoteClientPackage(root){
 let version='0.2.0';try{const candidate=JSON.parse(readFileSync(join(root,'remote-client','package.json'),'utf8')).version;if(/^\d+\.\d+\.\d+$/.test(candidate))version=candidate;}catch{}
 const directory=join(root,'remote-client','dist'),compare=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
 const name='AI-Remote-Companion-'+version+'.exe',path=join(directory,name);
 if(existsSync(path))return {name,path,version};
 // Publishing a new source version must not make the download regress to 0.2.0.
 let ready=[];try{ready=readdirSync(directory).map(n=>({name:n,version:/^(?:AI-Remote-Companion|助手远端只读陪伴)-(\d+\.\d+\.\d+)\.exe$/.exec(n)?.[1]})).filter(x=>x.version&&compare(x.version,version)<=0).sort((a,b)=>compare(b.version,a.version)||Number(b.name.startsWith('AI-'))-Number(a.name.startsWith('AI-')));}catch{}
 if(ready[0])return {...ready[0],path:join(directory,ready[0].name)};
 return {name,path,version};
}
