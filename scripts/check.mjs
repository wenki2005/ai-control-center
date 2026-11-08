import {readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}
const files=[...walk(join(root,'src')),...walk(join(root,'scripts')),...walk(join(root,'public')),...walk(join(root,'plugins'))].filter(f=>/\.(mjs|js)$/.test(f));
for(const f of files)execFileSync(process.execPath,['--check',f],{stdio:'pipe'});
console.log('Syntax OK: '+files.length+' JavaScript files');
