/** Parse the existing director output marker followed by one JSON object. */
export function parseProtocolObject(text, marker) {
  const start = String(text).indexOf(marker);
  if (start < 0) throw new Error('协议标记不存在');
  const source = String(text).slice(start + marker.length);
  const objectStart = source.indexOf('{');
  if (objectStart < 0) throw new Error('协议缺少 JSON 对象');
  let depth = 0; let quoted = false; let escaped = false; let end = -1;
  for (let i = objectStart; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('协议 JSON 对象未闭合');
  const candidate = source.slice(objectStart, end);
  let normalized = ''; quoted = false; escaped = false;
  for (const char of candidate) {
    if (quoted) {
      if (escaped) { escaped = false; normalized += char; continue; }
      if (char === '\\') { escaped = true; normalized += char; continue; }
      if (char === '"') { quoted = false; normalized += char; continue; }
      if (char === '\n') { normalized += '\\n'; continue; }
      if (char === '\r') { normalized += '\\n'; continue; }
      normalized += char; continue;
    }
    if (char === '"') quoted = true;
    normalized += char;
  }
  return { value: JSON.parse(normalized), end: start + marker.length + end };
}
