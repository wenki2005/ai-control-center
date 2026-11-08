import {join} from 'node:path';
/** The only image sources the center's DSH adapters may open. */
export function controlImageRoots({runtime,qqMediaRoot,archiveRoot,visualCacheRoot}){
 return [qqMediaRoot,archiveRoot,visualCacheRoot,join(runtime,'screen-companion'),join(runtime,'remote-screen-companion')];
}
