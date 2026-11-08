// Public, character-specific gallery previews. Original downloads may require
// a site verification; never manufacture original URLs or bypass that flow.
const CHARACTERS=new Map([['AI 助手','daniya'],['助手','moning'],['AI 助手','aimisi']]);
const decode=value=>String(value).replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'");
const attr=(html,key)=>decode(new RegExp(`\\b${key}="([^"]*)"`,'i').exec(html)?.[1]||'');

export function stickerCharacter(name){return [...CHARACTERS].find(([label])=>String(name||'').includes(label))?.[1]||null;}

export function packPreviews(html,{pack,name}){
  const rows=[],seen=new Set();
  for(const match of String(html).matchAll(/<img\b[^>]*>/gi)){
    const url=attr(match[0],'src'),title=attr(match[0],'alt');
    if(/封面/.test(title)||!url||seen.has(url))continue;
    let source;try{source=new URL(url);}catch{continue;}
    if(source.origin!=='https://i.sparxie.moe'||!source.pathname.startsWith('/derived/v1/p240/'+pack+'/'))continue;
    seen.add(url);rows.push({url,title:title||`${name} · Q版表情`,pageUrl:'https://sparxie.moe/packs/'+pack,character:name,pack,tags:['Q版','可爱','角色表情'],previewOnly:true});
  }
  return rows;
}

export function createStickerDiscovery({readPage}){
  if(typeof readPage!=='function')throw Error('需要表情来源读取器');
  return async function discover({name,limit=12,excludeUrls=[]}={}){
    const slug=stickerCharacter(name);if(!slug)return [];
    const html=await readPage('https://sparxie.moe/characters/'+slug),packs=[];
    for(const match of String(html).matchAll(/href="\/packs\/([a-z0-9][a-z0-9-]{1,160})"/gi))if(!packs.includes(match[1]))packs.push(match[1]);
    const excluded=new Set(excludeUrls),items=[];
    // A bounded collection pass, never a site-wide crawl. Already collected
    // previews are skipped so subsequent passes can discover fresh images.
    for(const pack of packs.slice(0,4)){
      const page=await readPage('https://sparxie.moe/packs/'+pack);
      for(const candidate of packPreviews(page,{pack,name}))if(!excluded.has(candidate.url)&&!items.some(x=>x.url===candidate.url)){
        items.push(candidate);if(items.length>=Math.max(1,Math.min(16,limit)))return items;
      }
    }
    return items;
  };
}
