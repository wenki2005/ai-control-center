const MAX_BYTES=2*1024*1024;
export function createStickerVision(ctx,{fetchImage=globalThis.fetch}={}){
  const viewed=new Map();
  return {
    canApprove(sessionId,id){return viewed.get(sessionId)?.has(id)===true;},
    async attach(value,exec,origin){
      let store,llm,enabled=false;
      try{store=ctx.get?.('attachments');llm=ctx.get?.('llm');const header=exec.agent?.session?.requestHeader?.()?.config||exec.agent?.options||{};
        enabled=!!store&&(await llm?.resolveModelInfo(header.provider,header.model,exec.signal))?.inputModalities?.includes('image')===true;
      }catch{}
      const images=[];const sessionId=exec.agent?.session?.id||exec.agent?.id;
      if(enabled)for(const item of (value.items||[]).slice(0,4)){
        if(!/^[a-f0-9-]{36}$/i.test(item.id)||item.preview!==`/api/companion/stickers/${item.id}/image`)continue;
        try{
          const response=await fetchImage(new URL(item.preview,origin),{signal:exec.signal||AbortSignal.timeout(10000)});
          const mediaType=response.headers.get('content-type')?.split(';')[0];
          if(!response.ok||!['image/png','image/jpeg','image/webp','image/gif'].includes(mediaType))continue;
          let length=0,chunks=[];for await(const part of response.body){length+=part.length;if(length>MAX_BYTES)throw Error('表情预览过大');chunks.push(part);}
          const input={data:Buffer.concat(chunks),mediaType,name:item.title||'角色表情'};
          const image=typeof store.saveImages==='function'?(await store.saveImages([input]))?.[0]:await store.saveImage?.(input);
          if(!image?.attachmentId)continue;
          images.push({id:item.id,image});let ids=viewed.get(sessionId);if(!ids){ids=new Set();viewed.set(sessionId,ids);}ids.add(item.id);
          if(ids.size>24)ids.delete(ids.values().next().value);if(viewed.size>12)viewed.delete(viewed.keys().next().value);
        }catch{/* A missing visual attachment never becomes a title-only approval. */}
      }
      return JSON.stringify({...value,visualReviewAvailable:images.length>0,images,
        reviewInstruction:images.length?'候选实图按id顺序附在工具结果中。只选清楚、可爱、符合当前角色和语境的图；未审核图片先用hub_sticker_review，合格至少4分。没有合适的就不发。':'本轮没有成功附上可读实图，不能只按标题批准新图片；仅使用已审核图库，或留给用户看图选择。'});
    },
  };
}
export function renderStickerPreview(_args,value){
  let data;try{data=JSON.parse(value);}catch{return[{type:'text',text:String(value)}];}
  return [{type:'text',text:JSON.stringify(data)},...(data.images||[]).map(x=>({type:'image',attachment:x.image}))];
}
