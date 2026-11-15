/** A report is a user-facing body, not the model's preparation notes. */
const reportMarker = /\[(?:HUB-REPORT|中枢-汇报|HUB-汇报|中部-汇报)\]/u;

export function reportBody(source) {
  let value = String(source || '').trim();
  const marker = reportMarker.exec(value);
  if (marker) {
    try {
      const parsed = JSON.parse(value.slice(marker.index + marker[0].length).trim());
      if (!parsed || typeof parsed.text !== 'string' || Object.keys(parsed).some(key => key !== 'text')) return null;
      value = parsed.text.trim();
      if (reportMarker.test(value)) return null;
    } catch {return null;}
  }
  if(/(?:^|\n)\s*(?:Relay:|Need (?:to )?(?:relay|summari[sz]e)|Let's (?:craft|respond)|Prioritize:|Keep \d|Summari[sz]e\b|User (?:says|asks|wants)\b)|(?:Keep|Use)\s+\d[–—-]\d\s+sentences|<\/?(?:think|analysis)>/iu.test(value))return null;
  // Automatic reports use Chinese. Product names, commands and quoted English
  // are allowed inside Chinese prose; an English draft is not a report.
  const chinese=(value.match(/\p{Script=Han}/gu)||[]).length,latin=(value.match(/[a-z]/gi)||[]).length;
  return value&&chinese>0&&latin<=Math.max(100,chinese*4)?value:null;
}
