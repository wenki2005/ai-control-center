/** User-authored style preferences. Call only for assistant-facing output. */
export const SPEECH_STYLE_POLICY_GUIDE = `# 用语偏好与自然表达

直接说这次事情、自己的具体感受或有用的信息。轻松聊天可以开心、害羞、开玩笑、有小主见，也可以只简短回应；情绪随内容发生，不规定每次都要有。保留当前角色的身份、称呼和节奏。
不要把对话写成点评台词、认领承诺或表演冷静。避免用分量、轻重、平稳给话语评分，避免记忆宣告、对话接招、认账、陪守承诺、揣测心思与催促反问。收到偏好后直接照着做，相关时自然用上；无需宣告自己已记忆。
回答问题就说答案；分享就聊分享本身；忙和晚安可以自然结束；不强制追问，不为可爱而加固定开头、尾句或语气词。正向例句只是表达方法，不当作每轮替换模板。
闲聊用平时说出口的话。上下文里已经清楚的人和事可以省掉，一句太长就从自然停顿处拆开。先说你听到的那个细节，或者你自己最想接的一句。吐槽可以一起吐槽，开心可以一起开心；对方想听主意时再多说两句。同一件事已经提醒过，接着聊新说的部分就好。比如听到“蒸饺全是皮”，一句“这皮也太舍得给了吧”就可以收住。
普通接手和陪伴用肯定句说自己的想法、兴致与接下来做的事。省去以否定假设中的坏做法来作保证的尾句；选材与权限核对在后台落实。真实失败、必要限制、用户明确询问的范围和技术解释仍准确表达，不能按单个否定字删改原意。
这些偏好适用于助手对用户新写的聊天、主动消息、看屏反应和工作汇报。用户原话、明确引述、代码、日志和技术事实照常保留；稳定运行、数字重量比较等不是聊天套话。规则由版本文档首次或变更时加载，不追加到用户原话。`;

export const SPEECH_STYLE_BANNED_PHRASES = Object.freeze([
 '这句话稳','比之前的都重','我记下了','我记得了','我记住了','这个账我记住了','比之前的都轻',
 '睡吧，我守着','你去，我跟','问别人还是问自己','行，Xxx','什么心思都写着xx上','这句话接的漂亮',
 '这句话接得漂亮','行，我认','这句话我不接','xx比xx沉','xx比xx重','xx比Xx稳','xx比xx轻',
 '没接你的xxx','比之前的都强','他记得这事','这话我留着','很平','稳','我不拦','我跟','回去睡',
 '你这句话我记着','认你','我不催你','这话是ta告诉你的，还是你自己想明白的','认下来',
 '声音没抖，但比刚才稳','比刚才轻','比刚才重','比刚才平','很直','这话我记下了','这话我收下了',
 '说的比谁都响','说得比谁都响','认这个','收不回去','认得实','xx就是认了','你自己掂量','没接你那句xx','不催','你掂量',
 '不硬闯','不硬套','不乱编','不瞎编','不瞎猜','不凑数','不画饼',
]);
const normalize=s=>s.normalize('NFKC').replace(/[\s\p{P}]/gu,'');
const exact=new Set(SPEECH_STYLE_BANNED_PHRASES.map(s=>normalize(s).toLowerCase()));
const meta=/^(?:禁词分析|禁用清单|禁用(?:短语|表达|说法)|用语规则|原话|日志|报错)[：:]/u;
const technical=/(?:\d|千克|公斤|毫秒|重量|体重|材料|负载|延迟|文件|服务器|稳定运行|运行稳定|[MG]B|kg)/iu;
const speech=/(?:这句|那句|话|语气|声音|承诺|心意|喜欢|情绪|回应|回答|眼神)/u;
const patterns=[
 /^(?:这个账)?我(?:给你)?(?:记下|记得|记住)(?:了|啦|咯)?$/u,
 /^(?:你)?这(?:句话|话)(?:我)?(?:记着|记下了|记住了|收下了|留着)$/u,
 /^(?:他|她|ta)记得这事$/iu,
 /^睡吧我守着(?:你)?$|^你去我跟(?:着)?$/u,
 /^问别人还是问自己$/u,
 /^这(?:句话|话)是.{1,18}告诉你的还是你自己想明白的$/u,
 /^(?:你的|你)?(?:什么|那点|那些)?心思都写(?:在|着).{1,10}上(?:了)?$/u,
 /^这(?:句话|话)(?:接[得的]漂亮|我不接|很?(?:稳|平|直))$/u,
 /^(?:我)?没接你(?:的|那句).{0,24}$/u,
 /^(?:行)?(?:我)?(?:认你|认下来|认这个|认得实)$/u,
 /^(?:行)?我认(?:了)?$|^.{1,12}就是认了$/u,
 /^我不拦(?:你)?$|^我跟(?:着)?(?:你)?$|^我不催(?:你)?$|^不催(?:你)?$/u,
 /^回去睡(?:吧)?$|^你(?:自己)?掂量(?:一下)?$/u,
 /^(?:说|说[得的])比谁都响$/u,
 /^(?:很)?(?:平|稳|直)$|^比(?:之前的都|刚才)(?:重|轻|强|平|稳)$/u,
 /^声音没抖但比刚才(?:稳|轻|重|平)$/u,
 /^这(?:句话|话)比之前的都(?:重|轻|强)$/u,
 /^(?:我|这次|也|我也)?(?:不|不会)(?:硬闯|硬套|乱编|瞎编|瞎猜|凑数|画饼)(?:给你|糊弄你)?$/u,
 /^(?:我|这次|也|我也)?不(?:拿|把|用).{1,36}(?:硬套|凑数|糊弄你)$/u,
];
function filler(text){
 const raw=normalize(text),s=raw.replace(/^(?:嗯好|好的|你|嗯|唔|诶|欸|好){1,2}/u,'').replace(/[呢啦呀哦喔啊]+$/u,'');
 if(!s||/\uE000\d+\uE001/u.test(text)||meta.test(text.trim()))return false;
 if(exact.has(raw.toLowerCase())||exact.has(s.toLowerCase())||patterns.some(re=>re.test(s)))return true;
 if((speech.test(s)||/^(?:这次|那次|你|我|xx)/iu.test(s))&&!technical.test(s)){
  if(/^.{1,24}比.{1,24}(?:沉|重|稳|轻)(?:得多|多了)?$/u.test(s))return true;
  if(/(?:很平|很直|收不回去)$/u.test(s))return true;
 }
 return false;
}
function mask(text){
 const protectedParts=[];
 const protect=s=>{const id=protectedParts.push(s)-1;return `\uE000${id}\uE001`;};
 let source=text.replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s<>"'。，！？；]+/gu,protect);
 source=source.replace(/[“「『"][^”」』"\n]*[”」』"]/gu,(quote,offset,all)=>{
  const prefix=all.slice(Math.max(0,offset-50),offset);
  return /(?:引用|引述|原话|禁用|禁词|说法|措辞|词表|日志|报错|写着|提示词|代码|输出|[你他她]说|用户说)\s*[：:]?\s*$/u.test(prefix)?protect(quote):quote;
 });
 return {source,restore:s=>s.replace(/\uE000(\d+)\uE001/gu,(_,i)=>protectedParts[Number(i)])};
}
function process(text){
 const {source,restore}=mask(text),found=[];
 const cleaned=source.split(/([。！？!?；;\n]+)/u).map(unit=>{
  if(!unit||/^[。！？!?；;\n]+$/u.test(unit)||meta.test(unit.trim()))return unit;
  if(filler(unit)){found.push(unit.trim());return '';}
  let value=unit.replace(/^(\s*)行\s*[，,]\s*/u,(_,space)=>{found.push('行，');return space;});
  // Only redundant, object-free scope tails after an actual delivery statement.
  // Preserve failure explanations, quoted material and substantive constraints.
  if(/(?:发你|发给|给你|找到了|整理好|处理好)/u.test(value)&&!/(?:未知|失败|超时|尚未|还没|缺少|无法|不能|等待|拒绝)/u.test(value)){
    value=value.replace(/[，,]\s*((?:也)?(?:不重做|不重跑|没重发|没有重发|不改别的))\s*$/u,(_,tail)=>{found.push(tail);return '';});
  }
  const pieces=value.match(/[^，,：:]+(?:[，,：:]|$)/gu)||[];
  const kept=[];
  for(const piece of pieces){
   const content=piece.replace(/[，,：:]$/u,'');
   if(filler(content)){found.push(content.trim());continue;}
   kept.push(piece);
  }
  return kept.join('').replace(/[，,：:]\s*$/u,'');
 }).join('');
 if(!found.length)return {text,found};
 const result=restore(cleaned.replace(/^[。！？!?；;\s]+/u,'').replace(/([。！？!?；;])[。！？!?；;]+/gu,'$1').trim());
 return {text:result,found:[...new Set(found.map(restore))]};
}
export function speechStyleViolations(text){return typeof text==='string'?process(text).found:[];}
export function cleanConversationalStyle(text,{emptyFallback='嗯。'}={}){
 if(typeof text!=='string'||!text)return text;
 const result=process(text);return result.found.length?(result.text||emptyFallback):text;
}
