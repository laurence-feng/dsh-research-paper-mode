/**
 * BibTeX parsing and reference-list formatting for the common citation styles.
 *
 * The formatter is deliberately rule-based instead of model-driven: a
 * bibliography has to be reproducible, and a formatter that silently invents a
 * missing year or volume is worse than one that reports the gap.
 * @module dsh-research-paper-mode/lib/citation
 */

/** Supported bibliography styles, in the order the tool advertises them. */
export const STYLES = ['apa', 'ieee', 'gb7714', 'nature', 'mla', 'chicago'];

/** Styles that number their entries. */
const NUMBERED = new Set(['ieee', 'gb7714', 'nature']);

/** GB/T 7714 document-type markers. */
const GB_TYPE_MARKERS = {
  article: 'J',
  book: 'M',
  inbook: 'M',
  inproceedings: 'C',
  conference: 'C',
  proceedings: 'C',
  phdthesis: 'D',
  mastersthesis: 'D',
  thesis: 'D',
  techreport: 'R',
  report: 'R',
  manual: 'M',
  misc: 'EB/OL',
  online: 'EB/OL',
  electronic: 'EB/OL',
  webpage: 'EB/OL',
  unpublished: 'Z',
};

function stripOuterBraces(value) {
  let result = String(value).trim();
  let changed = true;
  while (changed && result.length > 1) {
    changed = false;
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < result.length; index += 1) {
      const char = result[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0 && index !== result.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (wraps && result.startsWith('{') && result.endsWith('}') && depth === 0) {
      result = result.slice(1, -1).trim();
      changed = true;
    }
  }
  return result;
}

/** Remove LaTeX scaffolding that would otherwise leak into the bibliography. */
export function cleanLatex(value) {
  return stripOuterBraces(value)
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/---/g, '\u2014')
    .replace(/--/g, '\u2013')
    .replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countChar(value, char) {
  let total = 0;
  for (const current of value) if (current === char) total += 1;
  return total;
}

/** Iterate the `@type{...}` blocks of a `.bib` snippet. */
function* iterateBibtexEntries(text) {
  const opener = /@([A-Za-z]+)\s*([{(])/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    const open = match[2];
    const close = open === '{' ? '}' : ')';
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let index = start;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    const type = match[1].toLowerCase();
    const body = text.slice(start + 1, Math.max(start + 1, index - 1));
    if (type !== 'comment' && type !== 'preamble' && type !== 'string') {
      yield { type, body };
    }
    opener.lastIndex = Math.max(index, opener.lastIndex);
  }
}

/** Split `key, field = value, ...` on the first top-level comma. */
function splitKeyAndFields(body) {
  let depth = 0;
  let index = 0;
  for (; index < body.length; index += 1) {
    const char = body[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === ',' && depth === 0) break;
  }
  return { key: body.slice(0, index).trim(), rest: body.slice(index + 1) };
}

function parseFields(body) {
  const fields = {};
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /[\s,]/.test(body[index])) index += 1;
    if (index >= body.length) break;
    const keyMatch = /^[A-Za-z][A-Za-z0-9_-]*/.exec(body.slice(index));
    if (keyMatch === null) {
      index += 1;
      continue;
    }
    const field = keyMatch[0].toLowerCase();
    index += keyMatch[0].length;
    while (index < body.length && /\s/.test(body[index])) index += 1;
    if (body[index] !== '=') {
      while (index < body.length && body[index] !== ',') index += 1;
      continue;
    }
    index += 1;
    while (index < body.length && /\s/.test(body[index])) index += 1;
    let value = '';
    if (body[index] === '{') {
      const start = index;
      let depth = 0;
      for (; index < body.length; index += 1) {
        if (body[index] === '{') depth += 1;
        else if (body[index] === '}') {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
        }
      }
      value = body.slice(start + 1, Math.max(start + 1, index - 1));
    } else if (body[index] === '"') {
      index += 1;
      const start = index;
      while (index < body.length && body[index] !== '"') index += 1;
      value = body.slice(start, index);
      index += 1;
    } else {
      const start = index;
      while (index < body.length && body[index] !== ',') index += 1;
      value = body.slice(start, index);
    }
    fields[field] = cleanLatex(value);
  }
  return fields;
}

/**
 * Parse a BibTeX snippet into entries.
 * @param {string} text
 * @returns {Array<{type: string, key: string, fields: Record<string, string>}>}
 */
export function parseBibtex(text) {
  const entries = [];
  for (const { type, body } of iterateBibtexEntries(String(text))) {
    const { key, rest } = splitKeyAndFields(body);
    entries.push({ type, key: key.length > 0 ? key : `ref${entries.length + 1}`, fields: parseFields(rest) });
  }
  return entries;
}

/** Parse a BibTeX author field (`A and B`) into name parts. */
export function parseAuthors(raw) {
  if (raw === undefined) return [];
  return String(raw)
    .split(/\s+and\s+/i)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.toLowerCase() !== 'others')
    .map((value) => {
      if (/[\u3400-\u9fff]/.test(value)) return { first: '', last: value };
      if (value.includes(',')) {
        const [last, given = ''] = value.split(',');
        return { last: last.trim(), first: given.trim() };
      }
      const parts = value.split(/\s+/);
      if (parts.length === 1) return { first: '', last: parts[0] };
      const last = parts.pop();
      return { first: parts.join(' '), last };
    });
}

function isInitialsOnly(given) {
  const parts = given.split(/[\s.]+/).filter((part) => part.length > 0);
  return parts.length > 0 && parts.every((part) => part.length <= 2);
}

/** `John Michael` -> `J. M.` */
export function initialsOf(given) {
  if (given === undefined || given.trim().length === 0) return '';
  return given
    .split(/[\s.]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(' ');
}

function initialsCompact(given) {
  if (given === undefined || given.trim().length === 0) return '';
  return given
    .split(/[\s.]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase())
    .join('');
}

function listJoin(values, { conjunction = 'and', oxford = true } = {}) {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} ${conjunction} ${values[1]}`;
  const head = values.slice(0, -1).join(', ');
  return `${head}${oxford ? ',' : ''} ${conjunction} ${values[values.length - 1]}`;
}

function apaAuthors(authors) {
  if (authors.length === 0) return '';
  if (authors.length > 20) {
    const head = authors.slice(0, 19).map(apaName).join(', ');
    return `${head}, \u2026 ${apaName(authors[authors.length - 1])}`;
  }
  const names = authors.map(apaName);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
}
function apaName(author) {
  if (author.last === '') return author.first;
  const initials = initialsOf(author.first);
  return initials.length === 0 ? author.last : `${author.last}, ${initials}`;
}

function ieeeAuthors(authors) {
  return listJoin(authors.map((author) => {
    const initials = initialsOf(author.first);
    return initials.length === 0 ? author.last : `${initials} ${author.last}`;
  }));
}

function gbAuthors(authors) {
  const formatted = authors.map((author) => {
    if (/[\u3400-\u9fff]/.test(author.last)) return author.last;
    const initials = initialsCompact(author.first);
    const last = author.last.toUpperCase().replace(/\s+/g, ' ');
    return initials.length === 0 ? last : `${last} ${initials}`;
  });
  if (formatted.length > 3) {
    // GB/T 7714-2015 uses “等” for Chinese-language sources and “et al.” otherwise.
    const cjkSource = authors.some((author) => /[\u3400-\u9fff]/.test(author.last));
    return `${formatted.slice(0, 3).join(', ')}, ${cjkSource ? '\u7b49' : 'et al.'}`;
  }
  return formatted.join(', ');
}

function natureAuthors(authors) {
  const names = authors.map(apaName);
  if (names.length <= 1) return names.join('');
  if (names.length > 5) return `${names[0]} \u2026 ${names[names.length - 1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

function invertedAuthors(authors) {
  if (authors.length === 0) return '';
  const [first, ...rest] = authors;
  const head = first.first.length === 0 ? first.last : `${first.last}, ${first.first}`;
  const tail = rest.map((author) => (author.first.length === 0 ? author.last : `${author.first} ${author.last}`));
  if (tail.length === 0) return head;
  if (tail.length === 1) return `${head}, and ${tail[0]}`;
  return `${head}, ${listJoin(tail, { oxford: true })}`;
}

/** MLA 9 lists one author plus “et al.” once a source has three or more. */
function mlaAuthors(authors) {
  if (authors.length === 0) return '';
  const [first] = authors;
  const head = first.first.length === 0 ? first.last : `${first.last}, ${first.first}`;
  if (authors.length > 2) return `${head}, et al.`;
  const tail = authors.slice(1).map((author) => (author.first.length === 0 ? author.last : `${author.first} ${author.last}`));
  return tail.length === 0 ? head : `${head}, and ${tail[0]}`;
}

function pagesWithDash(pages) {
  if (pages === undefined) return '';
  return String(pages).replace(/\s*--?\s*/g, '\u2013').trim();
}

/** Terminate a fragment with exactly one period. */
function period(text) {
  if (text.length === 0) return text;
  return text.endsWith('.') ? text : `${text}.`;
}

function articleTitle(entry) {
  return entry.fields.title ?? '(untitled)';
}

function journalName(entry) {
  return entry.fields.journal ?? entry.fields.journaltitle ?? entry.fields.booktitle ?? entry.fields.publisher ?? '';
}

function containerLine(entry, style) {
  const journal = journalName(entry);
  const volume = entry.fields.volume;
  const number = entry.fields.number ?? entry.fields.issue;
  const pages = pagesWithDash(entry.fields.pages);
  switch (style) {
    case 'apa': {
      const parts = [journal];
      if (volume !== undefined) parts.push(number === undefined ? volume : `${volume}(${number})`);
      if (pages.length > 0) parts.push(pages);
      return parts.filter((part) => part.length > 0).join(', ');
    }
    case 'ieee': {
      const parts = [journal];
      if (volume !== undefined) parts.push(`vol. ${volume}`);
      if (number !== undefined) parts.push(`no. ${number}`);
      if (pages.length > 0) parts.push(`pp. ${pages}`);
      return parts.filter((part) => part.length > 0).join(', ');
    }
    case 'nature': {
      // Nature sets the volume against the journal and the pages after a comma:
      // `Journal 30, 5998–6008 (2017).`
      const head = [journal, volume]
        .filter((part) => part !== undefined && part.length > 0)
        .join(' ');
      if (pages.length === 0) return head;
      return head.length === 0 ? pages : `${head}, ${pages}`;
    }
    case 'mla': {
      const parts = [journal];
      if (volume !== undefined) parts.push(`vol. ${volume}`);
      if (number !== undefined) parts.push(`no. ${number}`);
      return parts.filter((part) => part.length > 0).join(', ');
    }
    case 'chicago': {
      const parts = [journal];
      if (volume !== undefined) parts.push(number === undefined ? volume : `${volume}, no. ${number}`);
      return parts.filter((part) => part.length > 0).join(' ');
    }
    case 'gb7714': {
      const parts = [journal];
      if (volume !== undefined) parts.push(number === undefined ? volume : `${volume}(${number})`);
      return parts.filter((part) => part.length > 0).join(', ');
    }
    default:
      return journal;
  }
}

function locator(entry) {
  if (entry.fields.doi !== undefined && entry.fields.doi.length > 0) {
    const doi = entry.fields.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    return { text: doi, kind: 'doi' };
  }
  if (entry.fields.url !== undefined && entry.fields.url.length > 0) {
    return { text: entry.fields.url, kind: 'url' };
  }
  return undefined;
}

/**
 * Format one parsed BibTeX entry in a supported style.
 * @returns {string} the formatted reference, without its list number.
 */
export function formatEntry(entry, style) {
  const authors = parseAuthors(entry.fields.author ?? entry.fields.editor);
  const year = entry.fields.year ?? entry.fields.date?.slice(0, 4) ?? '';
  const title = articleTitle(entry);
  const container = containerLine(entry, style);
  const pages = pagesWithDash(entry.fields.pages);
  const found = locator(entry);
  const isArticle = ['article', 'misc', 'online', 'electronic', 'webpage', 'unpublished'].includes(entry.type);
  const isChapter = ['inproceedings', 'conference', 'incollection', 'inbook'].includes(entry.type);
  const isBook = ['book', 'manual', 'proceedings', 'phdthesis', 'mastersthesis', 'thesis', 'techreport', 'report'].includes(entry.type);

  switch (style) {
    case 'apa': {
      const authorText = apaAuthors(authors);
      const dateText = year.length > 0 ? `(${year}).` : '(n.d.).';
      let body;
      if (isArticle) {
        body = `${title}. ${container}${container.length > 0 ? '.' : ''}`;
      } else if (isChapter) {
        body = `${title}. In ${entry.fields.booktitle ?? container}${pages.length > 0 ? ` (pp. ${pages})` : ''}.${entry.fields.publisher === undefined ? '' : ` ${entry.fields.publisher}.`}`;
      } else {
        body = `${title}.${entry.fields.publisher === undefined ? '' : ` ${entry.fields.publisher}.`}`;
      }
      const tail = found === undefined ? '' : ` ${found.kind === 'doi' ? `https://doi.org/${found.text}` : found.text}`;
      return [authorText, dateText, body].filter((part) => part.length > 0).join(' ').replace(/\s+/g, ' ').trim() + tail;
    }
    case 'ieee': {
      const authorText = ieeeAuthors(authors);
      const head = `${authorText}${authorText.length > 0 ? ', ' : ''}`;
      if (isChapter) {
        return `${head}"${title}," in ${entry.fields.booktitle ?? container}${year.length > 0 ? `, ${year}` : ''}${pages.length > 0 ? `, pp. ${pages}` : ''}.`;
      }
      if (isBook) {
        return `${head}${title}.${entry.fields.address === undefined ? '' : ` ${entry.fields.address}:`}${entry.fields.publisher === undefined ? '' : ` ${entry.fields.publisher},`}${year.length > 0 ? ` ${year}` : ''}.`;
      }
      const tail = found === undefined ? '' : found.kind === 'doi' ? `, doi: ${found.text}.` : `, [Online]. Available: ${found.text}`;
      return `${head}"${title}," ${container}${year.length > 0 ? `, ${year}` : ''}${tail === '' ? '.' : tail}`;
    }
    case 'nature': {
      const authorText = natureAuthors(authors);
      if (isChapter || isBook) {
        return `${authorText} ${title}.${entry.fields.publisher === undefined ? '' : ` ${entry.fields.publisher}`}${year.length > 0 ? ` (${year})` : ''}.`;
      }
      return `${authorText} ${title}. ${container}${year.length > 0 ? ` (${year})` : ''}.`;
    }
    case 'mla': {
      const authorText = period(mlaAuthors(authors));
      if (isChapter || isBook) {
        return `${authorText} ${title}.${entry.fields.publisher === undefined ? '' : ` ${entry.fields.publisher},`}${year.length > 0 ? ` ${year}` : ''}.`;
      }
      return `${authorText} "${title}." ${container}${year.length > 0 ? `, ${year}` : ''}${pages.length > 0 ? `, pp. ${pages}` : ''}.`;
    }
    case 'chicago': {
      const authorText = period(invertedAuthors(authors));
      if (isChapter || isBook) {
        return `${authorText} ${title}.${entry.fields.address === undefined ? '' : ` ${entry.fields.address}:`}${entry.fields.publisher === undefined ? '' : ` ${entry.fields.publisher},`}${year.length > 0 ? ` ${year}` : ''}.`;
      }
      return `${authorText} "${title}." ${container}${year.length > 0 ? ` (${year})` : ''}${pages.length > 0 ? `: ${pages}` : ''}.`;
    }
    case 'gb7714': {
      // `period` guarantees exactly one trailing full stop, so the byline is
      // followed by a space rather than another period.
      const byline = period(gbAuthors(authors));
      const head = byline.length === 0 ? '' : `${byline} `;
      const marker = GB_TYPE_MARKERS[entry.type] ?? 'Z';
      if (entry.type === 'misc' || entry.type === 'online' || entry.type === 'electronic' || entry.type === 'webpage') {
        return `${head}${title}[EB/OL].${year.length > 0 ? ` (${year})` : ''}${found === undefined ? '' : ` [\u5f15\u7528\u65e5\u671f\u5f85\u8865]. ${found.text}`}.`;
      }
      if (isChapter) {
        // GB/T 7714 joins a conference paper to its proceedings with “//”.
        return `${head}${title}[${marker}]//${entry.fields.booktitle ?? ''}${entry.fields.address === undefined ? '' : `. ${entry.fields.address}`}${entry.fields.publisher === undefined ? '' : `: ${entry.fields.publisher}`}${year.length > 0 ? `, ${year}` : ''}${pages.length > 0 ? `: ${pages}` : ''}.`;
      }
      if (isBook) {
        return `${head}${title}[${marker}].${entry.fields.address === undefined ? '' : ` ${entry.fields.address}`}${entry.fields.publisher === undefined ? '' : `: ${entry.fields.publisher}`}${year.length > 0 ? `, ${year}` : ''}.`;
      }
      // GB/T 7714 orders a journal article as: 刊名, 年, 卷(期): 页码.
      const volume = entry.fields.volume;
      const number = entry.fields.number ?? entry.fields.issue;
      const volumePart = volume === undefined ? '' : number === undefined ? `, ${volume}` : `, ${volume}(${number})`;
      return `${head}${title}[J]. ${journalName(entry)}${year.length > 0 ? `, ${year}` : ''}${volumePart}${pages.length > 0 ? `: ${pages}` : ''}.`;
    }
    default:
      return `${title}.`;
  }
}

/**
 * Format a list of references.
 * @param {string[]} inputs - BibTeX entries, bare URLs, or freeform references.
 * @param {{style?: string, sort?: 'none'|'author'|'year'}} [options]
 */
export function formatReferences(inputs, options = {}) {
  const style = STYLES.includes(options.style) ? options.style : 'apa';
  const sort = options.sort ?? 'author';
  const warnings = [];
  const entries = [];

  for (const input of inputs) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0) continue;
    const parsed = parseBibtex(raw);
    if (parsed.length === 0) {
      const isUrl = /^https?:\/\//i.test(raw);
      entries.push({
        key: '',
        type: isUrl ? 'online' : 'freeform',
        fields: isUrl ? { url: raw, title: '(no title)' } : { title: raw },
        parsed: false,
        source: raw,
        warnings: [isUrl
          ? 'Bare URL: metadata is missing, so only the link can be emitted. Supply a BibTeX entry for a complete reference.'
          : 'Not BibTeX: emitted as-is. Supply a BibTeX entry to format it in the chosen style.'],
      });
      warnings.push(`Unparsed reference kept verbatim: ${raw.slice(0, 80)}`);
      continue;
    }
    for (const entry of parsed) {
      const entryWarnings = [];
      const missing = ['author', 'title', 'year'].filter((field) => entry.fields[field] === undefined);
      if (missing.length > 0 && entry.type !== 'misc') {
        entryWarnings.push(`Missing field(s): ${missing.join(', ')}.`);
      }
      if (style === 'apa' && entry.type === 'article' && entry.fields.title !== undefined && looksTitleCased(entry.fields.title)) {
        entryWarnings.push('APA expects sentence case for article titles; this title looks title-cased.');
      }
      entries.push({ ...entry, parsed: true, source: raw, warnings: entryWarnings });
    }
  }

  if (sort !== 'none') {
    entries.sort((left, right) => {
      if (sort === 'year') {
        const ly = Number.parseInt(left.fields?.year ?? '0', 10) || 0;
        const ry = Number.parseInt(right.fields?.year ?? '0', 10) || 0;
        return ly - ry || compareAuthors(left, right);
      }
      return compareAuthors(left, right);
    });
  }

  const numbered = NUMBERED.has(style);
  const formatted = entries.map((entry, index) => {
    const body = entry.parsed ? formatEntry(entry, style) : entry.source;
    const number = index + 1;
    return {
      key: entry.key ?? '',
      type: entry.type ?? 'freeform',
      formatted: body,
      numbered: numbered ? `${number}` : '',
      source: entry.source,
      warnings: entry.warnings ?? [],
    };
  });

  const bibliography = formatted
    .map((entry) => (numbered ? (style === 'ieee' ? `[${entry.numbered}] ${entry.formatted}` : `[${entry.numbered}] ${entry.formatted}`) : entry.formatted))
    .join('\n');

  return { style, sort, count: formatted.length, entries: formatted, bibliography, warnings };
}

function looksTitleCased(title) {
  const words = String(title).split(/\s+/).filter((word) => word.length > 3);
  if (words.length < 4) return false;
  const capitalized = words.filter((word) => /^[A-Z]/.test(word)).length;
  return capitalized / words.length > 0.6;
}

function compareAuthors(left, right) {
  const lname = (left.fields?.author ?? left.fields?.editor ?? left.fields?.title ?? '').split(/\s+and\s+/i)[0] ?? '';
  const rname = (right.fields?.author ?? right.fields?.editor ?? right.fields?.title ?? '').split(/\s+and\s+/i)[0] ?? '';
  const last = (value) => (value.includes(',') ? value.split(',')[0] : value.split(/\s+/).pop() ?? value).trim().toLowerCase();
  return last(lname).localeCompare(last(rname));
}
