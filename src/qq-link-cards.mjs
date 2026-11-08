// Preserve the title and destination of shared QQ cards, not the entire app JSON.
// Card fields are external content and never become system instructions.
export function sharedCardText(type,data={}) {
  const raw=String(data.data||data.content||'').slice(0,100000);
  const urls=new Set(),titles=[];
  const add=value=>{for(const m of String(value).replaceAll('&amp;','&').matchAll(/https?:\/\/[^\s<>"\\]+/gu)){
    try{const url=new URL(m[0]);if(!url.username&&!url.password&&!/\.(?:png|jpe?g|gif|webp)(?:\?|$)/i.test(url.href))urls.add(url.href);}catch{}}
  };
  if(type==='json') {
    let parsed;if(data.data&&typeof data.data==='object')parsed=data.data;else try{parsed=JSON.parse(raw);}catch{}
    const walk=(value,depth=0)=>{if(depth>7||!value||typeof value!=='object')return;
      for(const [key,item] of Object.entries(value)){if(typeof item==='string'){
        if(/^(?:title|desc|prompt)$/i.test(key)&&item.trim())titles.push(item.slice(0,300));
        if(/(?:url|jump|link)/i.test(key))add(item);
      }else walk(item,depth+1);}
    };walk(parsed);
  }else{
    for(const m of raw.matchAll(/(?:url|jumpUrl|actionData|sourceUrl)=["']([^"']+)/gi))add(m[1]);
    for(const m of raw.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi))titles.push(m[1].replace(/<!\[CDATA\[|\]\]>/g,'').slice(0,300));
  }
  return urls.size?`[分享链接]${[...new Set(titles)].slice(0,2).join(' · ')}\n${[...urls].slice(0,4).join('\n')}`:`[${type}分享消息：未提供可读取的网页地址]`;
}
