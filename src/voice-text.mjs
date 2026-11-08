const EMOJI = new Map(Object.entries({
  '😀':'笑脸','😂':'笑哭','😊':'微笑','❤️':'红心','❤':'红心','👍':'点赞','😭':'哭哭','😢':'难过',
  '🎉':'庆祝','🥰':'喜欢','😍':'心动','😘':'亲亲','😳':'脸红','🥺':'可怜巴巴','😅':'尴尬地笑',
  '😏':'偷笑','🙄':'白眼','🤔':'思考','🤷‍♀️':'摊手','🤷':'摊手','🤦‍♀️':'扶额','🤦':'扶额',
  '👀':'看看','💗':'爱心','💖':'爱心','💕':'爱心','💤':'困困','✨':'闪亮','✅':'已勾选','❌':'叉号',
}));
const SYMBOLS = {'/':'斜杠','\\':'反斜杠',':':'冒号','_':'下划线','.':'点','-':'短横线','+':'加号','=':'等号','*':'星号','%':'百分号','?':'问号','&':'与号','#':'井号','@':'艾特','<':'小于号','>':'大于号','|':'竖线','(':'左括号',')':'右括号','{':'左花括号','}':'右花括号','[':'左方括号',']':'右方括号',';':'分号','!':'叹号','"':'双引号',"'":'单引号','$':'美元符号','^':'脱字符','~':'波浪号'};
const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'});
const machine=text=>Array.from(text,c=>SYMBOLS[c]?` ${SYMBOLS[c]} `:c).join('');

/** Deterministic presentation, not an AI summary: retain the words and values. */
export function speechText(input) {
  let text=String(input??'').replace(/\r\n?/g,'\n');
  text=text.replace(/```([^\n`]*)\n([\s\S]*?)```/g,(_all,language,code)=>`${language.trim()?language.trim()+'代码，':''}${machine(code)}。`);
  text=text.replace(/`([^`\n]+)`/g,(_all,code)=>machine(code));
  text=text.replace(/!?\[([^\]]*)\]\(([^)\n]+)\)/g,(_all,label,url)=>`${label}，链接 ${machine(url)}`);
  text=text.replace(/<((?:https?:\/\/)[^>]+)>/g,'$1');
  text=text.replace(/https?:\/\/[^\s<>，。！？；]+/g,url=>machine(url));
  text=text.replace(/[A-Za-z]:[\\/][^\s，。！？；<>]*/g,path=>machine(path));
  text=text.replace(/\b[\w]+(?:[_.+*=<>/-][\w]+)+\b/g,token=>machine(token));
  text=text.replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/^\s*>\s?/gm,'');
  text=text.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g,(_all,a,b)=>a??b);
  text=text.replace(/\*([^*\n]+)\*|_([^_\n]+)_/g,(_all,a,b)=>a??b);
  text=text.replace(/~~([^~]+)~~/g,'$1');
  text=text.replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm,'');
  text=text.replace(/^\s*[-+*]\s+/gm,'').replace(/^\s*(\d+)[.)]\s+/gm,'第$1项，');
  text=text.replace(/\|/g,'，').replace(/```/g,'');
  text=Array.from(graphemes.segment(text),({segment})=>EMOJI.get(segment)||(/\p{Extended_Pictographic}/u.test(segment)?'表情':segment)).join('');
  text=text.replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if(text&&/^[\p{P}\p{S}\s]+$/u.test(text))return text.includes('…')?'省略号':text.includes('?')||text.includes('？')?'问号':Array.from(text,c=>SYMBOLS[c]||'标点').join('，');
  return text;
}

export function speechChunks(input,{maxCharacters=120}={}) {
  const max=Math.floor(Number(maxCharacters));if(!Number.isFinite(max)||max<8||max>180)throw RangeError('语音分段长度应在8到180之间');
  const text=speechText(input),chunks=[];let offset=0;
  while(offset<text.length) {
    let count=Math.min(max,text.length-offset);
    if(offset+count<text.length) {
      const window=text.slice(offset,offset+count),minimum=Math.floor(count*.45);
      let boundary=-1;for(let i=minimum;i<window.length;i++)if(/[。！？!?；;，,\n]/u.test(window[i]))boundary=i+1;
      if(boundary<0){const space=window.lastIndexOf(' ');if(space>=minimum)boundary=space+1;}
      if(boundary>0)count=boundary;
      if(/[\uD800-\uDBFF]/u.test(text[offset+count-1]))count--;
    }
    const part=text.slice(offset,offset+count);if(part.trim())chunks.push(part);offset+=count;
  }
  return chunks;
}
