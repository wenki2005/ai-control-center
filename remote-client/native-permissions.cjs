'use strict';
const MODES=new Set(['read-only','workspace-write','danger-full-access']);
// Read the native policy identity, not UI labels or assistant/chat text.
function nativePermission(values={},eventMode=null){
 const preset=typeof values.permissions?.currentValue==='string'&&/^[\w-]{1,80}$/.test(values.permissions.currentValue)?values.permissions.currentValue:null;
 const explicit=[values.sandboxMode,values.permissions?.sandbox].find(v=>MODES.has(v));
 // Official preset identities remain usable on older hosts that expose only
 // PermissionSelection. An explicit conflicting mode always wins.
 const presetMode=MODES.has(preset)?preset:null;const mode=explicit||presetMode||(MODES.has(eventMode)?eventMode:null);
 return {sandboxMode:mode||null,permissionEvidence:{source:explicit?'native-mode':presetMode?'native-preset':mode?'native-mode':'unknown',preset,mode:mode||null}};
}
module.exports={nativePermission};
