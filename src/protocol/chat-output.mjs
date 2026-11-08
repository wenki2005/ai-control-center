import { parseProtocolObject } from './director-output.mjs';

// Only repair an extra object closer immediately before the messages-array
// closer. Dispatch and tool protocols always retain their strict parser.
export function parseChatOutput(text) {
  const source=String(text);
  try{return {...parseProtocolObject(source,'[HUB-CHAT]'),repaired:false};}
  catch(original) {
    if(!source.trimStart().startsWith('[HUB-CHAT]')||(source.match(/\[HUB-/g)||[]).length!==1)throw original;
    const stack=[];let quoted=false,escaped=false,removed=-1;
    for(let i=source.indexOf('{');i>=0&&i<source.length;i++) {
      const c=source[i];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"'){quoted=true;continue;}
      if(c==='{'||c==='['){stack.push(c);continue;}
      if(c!=='}'&&c!==']')continue;
      const expected=c==='}'?'{':'[';
      if(stack.at(-1)===expected){stack.pop();continue;}
      if(c==='}'&&stack.at(-1)==='['&&stack.length===2&&stack[0]==='{'&&removed<0&&/^\s*\]/u.test(source.slice(i+1))){removed=i;continue;}
      throw original;
    }
    if(removed<0||stack.length||quoted)throw original;
    const fixed=source.slice(0,removed)+source.slice(removed+1);
    let parsed;try{parsed=parseProtocolObject(fixed,'[HUB-CHAT]');}catch{throw original;}
    const value=parsed.value;
    if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['messages','topics','closedTopicIds'].includes(key))||!Array.isArray(value.messages)||!value.messages.every(message=>typeof message==='string')||source.slice(parsed.end+1).trim())throw original;
    return {...parsed,end:parsed.end+1,repaired:true};
  }
}
