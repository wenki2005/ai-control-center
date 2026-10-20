const TOKEN_LIMIT = 512;
const QUERY_LIMIT = 32;

/** Tokenize Chinese text as overlapping bigrams and retain whole Latin words. */
export function companionSearchTokens(value, limit = TOKEN_LIMIT) {
  const text = String(value ?? '').toLocaleLowerCase();
  const tokens = new Set();
  const chunks = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9]+/giu) || [];
  for (const chunk of chunks) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/iu.test(chunk)) {
      const chars = [...chunk];
      if (chars.length === 1) tokens.add(chars[0]);
      for (let index = 0; index < chars.length - 1 && tokens.size < limit; index++) tokens.add(chars[index] + chars[index + 1]);
    } else {
      tokens.add(chunk);
    }
    if (tokens.size >= limit) break;
  }
  return [...tokens].slice(0, limit);
}

/** Build a quoted FTS5 OR query so user text is never interpreted as FTS syntax. */
export function companionFtsQuery(value) {
  const tokens = companionSearchTokens(value, QUERY_LIMIT);
  return tokens.length ? tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ') : '';
}

export function companionSearchDocument(value) {
  return companionSearchTokens(value).join(' ');
}
