/**
 * Text helpers for the research-paper tools.
 *
 * Deliberately free of Harness imports so every function here can be exercised
 * by plain `node` outside the Host process.
 * @module dsh-research-paper-mode/lib/text
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  times: '\u00d7',
  middot: '\u00b7',
  deg: '\u00b0',
};

/** Decode the HTML entities that appear in fetched academic pages. */
export function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

/**
 * Reduce an HTML document to readable plain text.
 *
 * This is intentionally lossy: it exists to give the model a citable excerpt of
 * a search hit, not to replace `web_fetch`, which renders markdown properly.
 */
export function htmlToText(input) {
  const stripped = String(input)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt|figcaption|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Collapse runs of whitespace without destroying paragraph breaks. */
export function normalizeWhitespace(input) {
  return String(input)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cut `text` to `limit` characters on a word/sentence boundary where possible. */
export function truncate(text, limit) {
  const value = String(text);
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  const window = value.slice(0, limit);
  const boundary = Math.max(
    window.lastIndexOf('\u3002'),
    window.lastIndexOf('. '),
    window.lastIndexOf('\n'),
    window.lastIndexOf(' '),
  );
  const cut = boundary > limit * 0.6 ? boundary + 1 : limit;
  return `${window.slice(0, cut).trimEnd()}\u2026`;
}

/** Count CJK ideographs and kana; a practical proxy for "Chinese characters". */
export function countCjk(text) {
  const matches = String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g);
  return matches === null ? 0 : matches.length;
}

/** Count latin letters; used to decide whether a text is mostly English. */
export function countLatinLetters(text) {
  const matches = String(text).match(/[A-Za-z]/g);
  return matches === null ? 0 : matches.length;
}

/**
 * Guess the working language of a passage.
 * @returns {'zh'|'en'} `zh` when CJK characters dominate latin letters.
 */
export function detectLanguage(text) {
  const cjk = countCjk(text);
  const latin = countLatinLetters(text);
  if (cjk === 0 && latin === 0) return 'en';
  return cjk * 2 >= latin ? 'zh' : 'en';
}

/** Split into non-empty paragraph blocks. */
export function splitParagraphs(text) {
  return normalizeWhitespace(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/** Split into sentences, keeping CJK full stops and latin terminators. */
export function splitSentences(text) {
  const sentences = [];
  for (const block of normalizeWhitespace(text).split('\n')) {
    const line = block.trim();
    if (line.length === 0) continue;
    const parts = line.match(/[^.!?\u3002\uff01\uff1f\uff1b;]+[.!?\u3002\uff01\uff1f\uff1b;]*/g);
    if (parts === null) {
      sentences.push(line);
      continue;
    }
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence.length > 0) sentences.push(sentence);
    }
  }
  return sentences;
}

/** Word count: CJK characters plus latin word tokens. */
export function countWords(text, language = detectLanguage(text)) {
  const cjk = countCjk(text);
  const latin = String(text).replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ');
  const tokens = latin.match(/[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g);
  const latinWords = tokens === null ? 0 : tokens.length;
  return language === 'zh' ? cjk + latinWords : latinWords + cjk;
}

/**
 * Split text into chunks no longer than `maxChars`, preferring paragraph then
 * sentence boundaries so a polished chunk still reads as whole prose.
 */
export function chunkText(text, maxChars) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized.length === 0 ? [] : [normalized];
  const chunks = [];
  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value.length > 0) chunks.push(value);
    current = '';
  };
  for (const paragraph of splitParagraphs(normalized)) {
    if (paragraph.length > maxChars) {
      flush();
      for (const sentence of splitSentences(paragraph)) {
        if (current.length > 0 && current.length + sentence.length + 1 > maxChars) flush();
        if (sentence.length > maxChars) {
          flush();
          for (let index = 0; index < sentence.length; index += maxChars) {
            chunks.push(sentence.slice(index, index + maxChars));
          }
          continue;
        }
        current = current.length === 0 ? sentence : `${current} ${sentence}`;
      }
      flush();
      continue;
    }
    if (current.length > 0 && current.length + paragraph.length + 2 > maxChars) flush();
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
  }
  flush();
  return chunks;
}

/** Normalize a URL for de-duplication: drop fragments and tracking parameters. */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url));
    parsed.hash = '';
    const tracking = [];
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref|referrer|source|fbclid|gclid|spm)/i.test(key)) tracking.push(key);
    }
    for (const key of tracking) parsed.searchParams.delete(key);
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let value = parsed.toString();
    if (value.endsWith('/')) value = value.slice(0, -1);
    return value;
  } catch {
    return String(url).trim();
  }
}

/** Extract a four-digit publication year from arbitrary provider text. */
export function extractYear(value) {
  if (value === undefined || value === null) return undefined;
  const match = /(1[5-9]\d{2}|20\d{2}|21\d{2})/.exec(String(value));
  return match === null ? undefined : Number.parseInt(match[1], 10);
}
