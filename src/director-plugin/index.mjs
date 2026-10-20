import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDirectorTools } from './logic.mjs';

const dshInstall=resolve(process.env.DSH_INSTALL || (process.env.DSH_INSTALL || '.'));
const toolsModule=await import(pathToFileURL(resolve(dshInstall,'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href);
const {defineTool}=toolsModule;

export const name='@mornye-ai/director-tools';
export const inject=['tools'];
export function apply(ctx,config={}) {
  if(config.mode==='report') {const release=ctx.tools.restrict({allow:[]});ctx.effect(()=>release);return;}
  installDirectorTools(ctx,{defineTool});
}
