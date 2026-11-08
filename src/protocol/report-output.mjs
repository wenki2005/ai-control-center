/** A report is a user-facing body, not the model's preparation notes. */
export function reportBody(source) {
  const value=String(source||'').trim(),marker='[HUB-REPORT]';
  const index=value.indexOf(marker);
  if(index>=0) {
    try {
      const parsed=JSON.parse(value.slice(index+marker.length).trim());
      if(!parsed||typeof parsed.text!=='string'||Object.keys(parsed).some(k=>k!=='text'))return null;
      return reportBody(parsed.text);
    } catch {return null;}
  }
  if(/(?:^|\n)\s*(?:Relay:|Need (?:to )?(?:relay|summari[sz]e)|Let's (?:craft|respond)|Prioritize:|Keep \d|Summari[sz]e\b|User (?:says|asks|wants)\b)|(?:Keep|Use)\s+\d[–—-]\d\s+sentences|<\/?(?:think|analysis)>/iu.test(value))return null;
  // Automatic reports use Chinese. Product names, commands and quoted English
  // are allowed inside Chinese prose; an English draft is not a report.
  const chinese=(value.match(/\p{Script=Han}/gu)||[]).length,latin=(value.match(/[a-z]/gi)||[]).length;
  return value&&chinese>0&&latin<=Math.max(100,chinese*4)?value:null;
}
