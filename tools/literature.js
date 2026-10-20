/**
 * `literature_search`: an academic-scoped web search that returns citable
 * sources instead of a prose answer.
 * @module dsh-research-paper-mode/tools/literature
 */

import { defineTool } from '../lib/tool-schema.js';
import { extractYear, htmlToText, normalizeUrl, truncate } from '../lib/text.js';

/** Repository and publisher scopes, mapped to the search operator each uses. */
const SCOPE_OPERATORS = {
  arxiv: 'site:arxiv.org',
  pubmed: 'site:pubmed.ncbi.nlm.nih.gov',
  pmc: 'site:pmc.ncbi.nlm.nih.gov',
  semanticscholar: 'site:semanticscholar.org',
  springer: 'site:link.springer.com',
  sciencedirect: 'site:sciencedirect.com',
  ieee: 'site:ieeexplore.ieee.org',
  acm: 'site:dl.acm.org',
  cnki: 'site:cnki.net',
  wanfang: 'site:wanfangdata.com.cn',
  doaj: 'site:doaj.org',
};

/** Scopes that narrow to one repository; anything else is ignored with a note. */
export const KNOWN_SCOPES = Object.keys(SCOPE_OPERATORS);

function buildQuery(query, scopes, notes) {
  const parts = [query];
  const seen = new Set();
  for (const scope of scopes) {
    const key = String(scope).trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    const operator = SCOPE_OPERATORS[key];
    if (operator === undefined) {
      notes.push(`Unknown scope “${scope}” ignored (known: ${KNOWN_SCOPES.join(', ')}).`);
      continue;
    }
    parts.push(operator);
  }
  return parts.join(' ');
}

function clampInt(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * Run the search through an explicitly chosen provider from the web seam's
 * registry, capping sources the way the seam itself would.
 */
async function searchWithProvider(web, providerId, request, signal) {
  const registry = web.searchProviders;
  const registered = registry instanceof Map ? [...registry.keys()] : [];
  const provider = registry instanceof Map ? registry.get(providerId) : undefined;
  if (provider === undefined) {
    throw new Error(`web search provider "${providerId}" is not registered (registered: ${registered.join(', ') || 'none'}). Omit the provider argument to use the configured default.`);
  }
  if (typeof provider.available === 'function' && !provider.available()) {
    throw new Error(`web search provider "${providerId}" is registered but unavailable; check its API key and endpoint configuration.`);
  }
  const result = await provider.search(request, signal);
  if (Array.isArray(result?.sources) && Number.isInteger(request.maxResults) && result.sources.length > request.maxResults) {
    return { ...result, sources: result.sources.slice(0, request.maxResults), truncated: true };
  }
  return result;
}

export function registerLiteratureSearch(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'literature_search',
    description: [
      'Search the academic literature and return citable sources (title, URL, snippet, date).',
      'Use it before making any claim about prior work. Optionally narrow to repositories with',
      `scope (${KNOWN_SCOPES.join(', ')}) and to a publication-year window.`,
      'The default search provider is the profile\'s configured one; pass provider to pick a specific',
      'registered backend such as deepseek-official, deepseek-search-api, or kimi-web-search (Kimi needs a MOONSHOT_API_KEY).',
      'Set fetchExcerpts above 0 to also pull a short plain-text excerpt of the top hits; use web_fetch for a full paper.',
      'Every source must be verified by reading it before it is cited: never cite a title, author, year, venue or DOI that the returned sources do not show.',
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The literature query, in the language of the literature you want to find. Be specific: method, task, dataset, population.',
      },
      scope: {
        type: 'array',
        items: { type: 'string' },
        description: `Optional repository filters: ${KNOWN_SCOPES.join(', ')}.`,
      },
      provider: {
        type: 'string',
        description: 'Optional web search provider id (e.g. deepseek-official, deepseek-search-api, kimi-web-search). Omit to use the profile\'s configured default provider.',
      },
      yearFrom: { type: 'number', description: 'Earliest publication year to keep. Sources without a date are kept.' },
      yearTo: { type: 'number', description: 'Latest publication year to keep. Sources without a date are kept.' },
      maxResults: {
        type: 'number',
        description: `Maximum sources to return (1-25). Defaults to ${config.searchMaxResults}.`,
      },
      fetchExcerpts: {
        type: 'number',
        description: 'Fetch a plain-text excerpt for the top N sources (0-5). Defaults to 0; costs one HTTP request per source.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          provider: { type: 'string' },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                url: { type: 'string', required: true },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
                year: { type: 'number' },
                excerpt: { type: 'string' },
                excerptStatus: { type: 'string' },
              },
            },
          },
          answer: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
          removed: { type: 'number', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [`Found ${value.sources.length} source(s) for: ${value.query}${value.provider === undefined ? '' : ` (provider: ${value.provider})`}`];
        for (const [index, source] of value.sources.entries()) {
          const meta = [source.year ?? source.publishedAt, source.title ?? '(no title)'].filter(Boolean).join(' — ');
          lines.push(`${index + 1}. [${meta}](${source.url})`);
          if (source.snippet !== undefined) lines.push(`   ${truncate(source.snippet, 240)}`);
          if (source.excerpt !== undefined) lines.push(`   excerpt: ${truncate(source.excerpt, 240)}`);
        }
        for (const note of value.notes ?? []) lines.push(`note: ${note}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const web = ctx.get('web');
      if (web === undefined) {
        throw new Error('literature_search needs the web service and a search provider; enable @deepseek-ai/dsh-web and a search backend in this profile.');
      }
      const notes = [];
      const query = buildQuery(args.query.trim(), args.scope ?? [], notes);
      const maxResults = clampInt(args.maxResults, config.searchMaxResults, 1, 25);
      const providerId = typeof args.provider === 'string' && args.provider.trim().length > 0 ? args.provider.trim() : undefined;

      const result = providerId === undefined
        ? await web.search({ query, maxResults }, exec.signal)
        : await searchWithProvider(web, providerId, { query, maxResults }, exec.signal);
      exec.signal.throwIfAborted();
      if (providerId !== undefined) notes.push(`Search provider: ${providerId} (explicitly selected; not the configured default).`);

      const from = Number.isInteger(args.yearFrom) ? args.yearFrom : undefined;
      const to = Number.isInteger(args.yearTo) ? args.yearTo : undefined;
      const keep = [];
      const seenUrls = new Set();
      const seenTitles = new Set();
      let removed = 0;

      for (const source of result.sources ?? []) {
        if (typeof source?.url !== 'string' || source.url.length === 0) {
          removed += 1;
          continue;
        }
        const year = extractYear(source.publishedAt);
        if (year !== undefined && ((from !== undefined && year < from) || (to !== undefined && year > to))) {
          removed += 1;
          continue;
        }
        const url = normalizeUrl(source.url);
        const title = typeof source.title === 'string' ? source.title.trim() : '';
        const titleKey = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
        if (seenUrls.has(url) || (titleKey.length > 12 && seenTitles.has(titleKey))) {
          removed += 1;
          continue;
        }
        seenUrls.add(url);
        if (titleKey.length > 12) seenTitles.add(titleKey);
        keep.push({
          ...(title.length > 0 ? { title } : {}),
          url: source.url,
          ...(typeof source.snippet === 'string' && source.snippet.trim().length > 0 ? { snippet: source.snippet.trim() } : {}),
          ...(typeof source.publishedAt === 'string' && source.publishedAt.length > 0 ? { publishedAt: source.publishedAt } : {}),
          ...(year === undefined ? {} : { year }),
        });
      }

      if (from !== undefined || to !== undefined) {
        notes.push(`Publication-year window ${from ?? 'any'}-${to ?? 'any'} applied to sources that carry a date.`);
      }
      if (removed > 0) notes.push(`${removed} provider result(s) dropped as duplicates, undated out-of-range, or malformed.`);
      if (result.truncated === true) notes.push('The provider truncated its result set; narrow the query for full coverage.');

      const fetchCount = clampInt(args.fetchExcerpts, 0, 0, 5);
      if (fetchCount > 0) {
        if (typeof web.fetch !== 'function') {
          notes.push('Excerpts were requested but this profile has no fetch provider.');
        } else {
          for (const source of keep.slice(0, fetchCount)) {
            try {
              const fetched = await web.fetch({ url: source.url }, exec.signal);
              const body = fetched?.body;
              const raw = typeof body?.content === 'string' ? body.content : '';
              const text = body?.kind === 'html' ? htmlToText(raw) : raw;
              source.excerpt = truncate(text, config.searchExcerptChars);
              source.excerptStatus = fetched?.statusCode === undefined ? 'unknown' : `HTTP ${fetched.statusCode}`;
            } catch (error) {
              source.excerptStatus = `fetch failed: ${error instanceof Error ? error.message : String(error)}`;
              notes.push(`Could not fetch an excerpt for ${source.url}.`);
            }
            exec.signal.throwIfAborted();
          }
        }
      }

      return {
        query,
        ...(providerId === undefined ? {} : { provider: providerId }),
        sources: keep,
        ...(typeof result.content === 'string' && result.content.trim().length > 0 ? { answer: result.content.trim() } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        removed,
      };
    },
  }));
}
