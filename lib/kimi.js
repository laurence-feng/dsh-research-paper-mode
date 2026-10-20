/**
 * Kimi (Moonshot AI) web-search provider: the standalone Search REST APIs
 * (`POST /v1/tools/search` and `POST /v1/tools/search_pro`), registered on the
 * `ctx.web` seam so `literature_search` can route to them by provider id.
 *
 * Wire format reference: https://platform.kimi.com/docs/api/tools-search and
 * .../tools-search-pro. Successful calls with a non-empty result list are
 * billed per call by Moonshot; failures and empty results are not.
 *
 * Deliberately free of Harness imports so plain `node` can exercise the
 * response mapping outside the Host process.
 * @module dsh-research-paper-mode/lib/kimi
 */

/** Stable id this provider registers under in the web search registry. */
export const KIMI_PROVIDER_ID = 'kimi-web-search';

/** Default API base, including `/v1`; `/tools/search(_pro)` is appended. */
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';

/** Environment variables consulted for the key, in order. */
export const KIMI_API_KEY_ENVS = ['MOONSHOT_API_KEY', 'KIMI_API_KEY'];

/** `MOONSHOT_BASE_URL` overrides the endpoint without touching the row config. */
export const KIMI_BASE_URL_ENV = 'MOONSHOT_BASE_URL';

function isUsableUrl(value) {
  try {
    return new URL(value).protocol.startsWith('http');
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map one Search API response item to a web-seam source. Pro-tier `chunks`
 * supply the snippet when the item's own snippet is empty.
 */
function mapResultItem(item) {
  if (!isRecord(item) || typeof item.url !== 'string' || item.url.length === 0) return undefined;
  const chunks = Array.isArray(item.chunks) ? item.chunks : [];
  const bestChunk = chunks
    .filter((chunk) => isRecord(chunk) && typeof chunk.text === 'string' && chunk.text.trim().length > 0)
    .sort((a, b) => (typeof b.score === 'number' ? b.score : 0) - (typeof a.score === 'number' ? a.score : 0))[0];
  const snippet = typeof item.snippet === 'string' && item.snippet.trim().length > 0
    ? item.snippet.trim()
    : bestChunk?.text.trim();
  return {
    url: item.url,
    ...(typeof item.title === 'string' && item.title.trim().length > 0 ? { title: item.title.trim() } : {}),
    ...(snippet === undefined ? {} : { snippet }),
    ...(typeof item.date === 'string' && item.date.trim().length > 0 ? { publishedAt: item.date.trim() } : {}),
  };
}

/** Validate and project a Search API response; anything malformed is an error, never a guess. */
export function mapKimiResponse(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.search_results)) {
    throw new Error('Kimi returned an invalid response body: expected a search_results array');
  }
  const sources = [];
  for (const item of payload.search_results) {
    const source = mapResultItem(item);
    if (source !== undefined) sources.push(source);
  }
  return { sources, truncated: false };
}

/** One authentication snapshot for one search; secrets are never retained on the provider. */
function resolveKey(options) {
  if (typeof options.apiKey === 'string' && options.apiKey.length > 0) return options.apiKey;
  for (const env of KIMI_API_KEY_ENVS) {
    const value = process.env[env];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The Kimi-backed search provider. `available()` mirrors the first-party
 * DeepSeek providers: a credential source must exist (literal key, ambient
 * environment, or the credentials service) and the endpoint must parse.
 */
export class KimiSearchProvider {
  /**
   * @param {() => object} resolveOptions - options for the NEXT search, resolved
   *   once per call so one search never mixes two configuration sections.
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.id = KIMI_PROVIDER_ID;
  }

  available() {
    const options = this.resolveOptions();
    return isUsableUrl(options.baseURL)
      && Number.isInteger(options.timeoutSeconds) && options.timeoutSeconds >= 1 && options.timeoutSeconds <= 60
      && (resolveKey(options) !== undefined || options.hasCredentialsService === true);
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    const apiKey = resolveKey(options) ?? await options.resolveCredential?.();
    signal?.throwIfAborted();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        `Kimi web search has no API key: set ${KIMI_API_KEY_ENVS.join(' or ')} in the environment, `
        + 'store it through the credentials service, or set a literal "kimiApiKey" in the dsh-research-paper-mode row config. '
        + 'Create a key at https://platform.kimi.com/console/api-keys',
      );
    }
    const endpoint = `${options.baseURL.replace(/\/+$/, '')}/tools/${options.tier === 'pro' ? 'search_pro' : 'search'}`;
    const limit = Number.isInteger(request.maxResults) && request.maxResults >= 1
      ? Math.min(request.maxResults, 20)
      : 10;
    const body = {
      text_query: request.query,
      limit,
      timeout_seconds: options.timeoutSeconds,
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': 'dsh-research-paper-mode/1.1.0',
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new Error(`Kimi search request failed for endpoint ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      let message = `Kimi API error (HTTP ${response.status})`;
      try {
        const parsed = await response.json();
        const detail = isRecord(parsed?.error) ? parsed.error.message : undefined;
        if (typeof detail === 'string' && detail.length > 0) message += `: ${detail}`;
      } catch { /* error bodies may be absent (401/403 carry none) */ }
      if (response.status === 401 || response.status === 403) {
        message += `. The request used key source ${KIMI_API_KEY_ENVS.join('/')}; verify the key at https://platform.kimi.com/console/api-keys`;
      }
      throw new Error(`${message} (endpoint ${endpoint})`);
    }
    signal?.throwIfAborted();
    return mapKimiResponse(await response.json());
  }
}

/**
 * Register the Kimi provider on the web seam. Returns false when the seam is
 * absent; `literature_search` then simply cannot offer the `kimi-web-search`
 * id and the rest of the mode is unaffected.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the preset-scoped context.
 * @param {object} config - the resolved row config (kimi* keys).
 */
export function registerKimiSearch(ctx, config) {
  const web = ctx.get('web');
  if (web === undefined || typeof web.registerSearchProvider !== 'function') return false;
  web.registerSearchProvider(new KimiSearchProvider(() => ({
    ...(typeof config.kimiApiKey === 'string' && config.kimiApiKey.length > 0 ? { apiKey: config.kimiApiKey } : {}),
    resolveCredential: async () => {
      const credentials = ctx.get('credentials');
      if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined;
      for (const env of KIMI_API_KEY_ENVS) {
        const resolved = await credentials.resolve(env);
        if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value;
      }
      return undefined;
    },
    hasCredentialsService: ctx.get('credentials') !== undefined,
    baseURL: config.kimiBaseURL ?? process.env[KIMI_BASE_URL_ENV] ?? KIMI_DEFAULT_BASE_URL,
    tier: config.kimiTier,
    timeoutSeconds: config.kimiTimeoutSeconds,
  })));
  return true;
}
