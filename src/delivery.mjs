const URL_RE = /(?:https?:\/\/|www\.)[^\s<>]+/giu;

function urlSpans(text) {
  return [...text.matchAll(URL_RE)].map(match => {
    const chineseEnd = match[0].search(/[。，！？；]/u);
    const value = (chineseEnd < 0 ? match[0] : match[0].slice(0, chineseEnd)).replace(/[;!?.,)\]}]+$/u, '');
    return [match.index, match.index + value.length];
  }).filter(([start, end]) => end > start);
}

function cleanMarkdown(text) {
  return String(text ?? '')
    .replace(/```[^\S\r\n]*[\w+-]*[^\S\r\n]*\r?\n?/g, '')
    .replace(/```/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(?=\S)(.*?)\1/g, '$2')
    .replace(/~~(?=\S)(.*?)~~/g, '$1')
    .replace(/\*(?=\S)([^*\n]+?)\*(?=\s|$)/g, '$1')
    .replace(/_(?=\S)([^_\n]+?)_(?=\s|$)/g, '$1')
    .replace(/\*/g, '')
    .replace(/\r\n?/g, '\n');
}

function isCommand(line) {
  return /^\s*(?:\/|!)[^\s]+/.test(line);
}

function sentencePieces(text) {
  const protectedSpans = urlSpans(text);
  const insideUrl = index => protectedSpans.some(([start, end]) => index >= start && index < end);
  const pieces = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (insideUrl(i)) continue;
    const isOptionDot = char === '.' && /^\s*\d{1,2}$/.test(text.slice(start, i));
    const next = text[i + 1] || '';
    const asciiSentenceEnd = char === '.' && !isOptionDot && (!next || /\s/.test(next)) && !/\d/.test(text[i - 1] || '');
    if ((/[。！？!?；;\n]/.test(char) || asciiSentenceEnd) && i >= start) {
      const piece = text.slice(start, i + 1);
      if (piece) pieces.push(piece);
      start = i + 1;
    }
  }
  const tail = text.slice(start);
  if (tail) pieces.push(tail);
  return pieces;
}

function splitLong(text, limit) {
  if (text.length <= limit || isCommand(text) || /^\s*\d{1,2}[.)、]\s/.test(text)) return [text];
  const result = [];
  let rest = text;
  while (rest.length > limit) {
    const urls = urlSpans(rest);
    const safe = i => !urls.some(([a, b]) => i > a && i < b);
    let cut = -1;
    const ceiling = Math.min(limit, rest.length - 1);
    for (let i = ceiling; i > 0; i--) {
      if (safe(i) && /[，,、；;：:\s]/.test(rest[i - 1])) { cut = i; break; }
    }
    if (cut < 1) {
      cut = ceiling;
      while (cut > 1 && !safe(cut)) cut--;
      if (!safe(cut)) {
        // If the URL begins the remainder, preserve it as one indivisible token.
        const crossing = urls.find(([start, end]) => start < ceiling && end > ceiling);
        if (!crossing) return [text];
        if (crossing[0] === 0) {
          if (crossing[1] >= rest.length) return [text];
          cut = crossing[1];
        } else cut = crossing[0];
      }
      if (cut < 1) return [text];
    }
    const part = rest.slice(0, cut).trim();
    if (part) result.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) result.push(rest);
  return result;
}

/** Convert markdown-ish assistant output into short, content-preserving chat messages. */
export function conversationalParts(text, { maxLength = 120 } = {}) {
  const normalized = cleanMarkdown(text).trim();
  if (!normalized) return [];
  const parts = [];
  for (const line of normalized.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    if (isCommand(value) || /^\d{1,2}[.)、]\s/.test(value)) {
      parts.push(value);
      continue;
    }
    const limit=Math.max(24,maxLength);
    let message='';
    for(const sentence of sentencePieces(value)) {
      const chineseBoundary=/[。！？；]$/u.test(message.trimEnd());
      const appended=chineseBoundary?message.trimEnd()+sentence.trimStart():message+sentence;
      const next=appended.trim();
      if(message.trim() && next.length>limit) {
        parts.push(...splitLong(message.trim(),limit));
        message=sentence.trimStart();
      } else message=appended;
    }
    if(message.trim())parts.push(...splitLong(message.trim(),limit));
  }
  return parts;
}
