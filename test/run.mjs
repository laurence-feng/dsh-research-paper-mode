/**
 * End-to-end tests for the research-paper bundle, run outside the Host.
 *
 * `apply()` is driven against a fake Host context, so tool registration,
 * argument validation, output-shape validation and every execute() path are
 * exercised without the Harness running.
 *
 * Run: node test/run.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { apply, resolveConfig } from '../index.js';
import { checkStyle } from '../lib/style.js';
import { formatReferences, parseBibtex, parseAuthors, formatEntry } from '../lib/citation.js';
import { buildPolishPrompt, parsePolishResult, streamPolish } from '../lib/polish.js';
import { chunkText, detectLanguage, extractYear, htmlToText, normalizeUrl, truncate } from '../lib/text.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('test body must be synchronous; use `atest`');
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Fake Host                                                           *
 * ------------------------------------------------------------------ */

const SEARCH_RESULTS = [
  { title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', snippet: 'Transformer architecture', publishedAt: '2017-06-12' },
  { title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762/', snippet: 'duplicate' },
  { title: 'BERT', url: 'https://arxiv.org/abs/1810.04805?utm_source=newsletter', snippet: 'Pretraining', publishedAt: '2018-10-11' },
  { title: 'Old Paper', url: 'https://example.org/old', snippet: 'From 1998', publishedAt: '1998-01-01' },
  { title: 'Undated', url: 'https://example.org/undated', snippet: 'no date' },
];

function makeServices(overrides = {}) {
  const calls = { search: [], fetch: [], stream: [] };
  const services = {
    web: {
      async search(request, signal) {
        calls.search.push(request);
        assert.equal(signal.aborted, false);
        return { sources: SEARCH_RESULTS, content: 'provider answer', truncated: false };
      },
      async fetch(request) {
        calls.fetch.push(request);
        return {
          url: request.url,
          statusCode: 200,
          body: { kind: 'html', content: '<html><head><style>p{}</style></head><body><p>Excerpt &amp; body</p><script>bad()</script></body></html>' },
          truncated: false,
        };
      },
    },
    llm: {
      stream(options) {
        calls.stream.push(options);
        return (async function* generate() {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ polished: `POLISHED(${options.messages[0].content[0].text.length})`, notes: ['tightened', 'tightened'] }) };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    fs: {
      async resolve(path) {
        return path;
      },
      async readText() {
        return '这是一段需要润色的文字。';
      },
    },
    ...overrides,
  };
  return { services, calls };
}

function makeContext(services, options = {}) {
  const registered = [];
  const sections = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    systemPrompt: {
      section: (section) => sections.push(section),
      getSectionOrder: (orderName) => {
        assert.equal(orderName, 'TOOL_WEB_SEARCH');
        return options.webSearchOrder ?? 2000;
      },
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
    get: (name) => services[name],
  };
  return { ctx, registered, sections };
}

const EXEC = { signal: new AbortController().signal, agent: { session: { header: { cwd: '/workspace' } } } };

function toolNamed(registered, name) {
  const found = registered.find((definition) => definition.name === name);
  assert.ok(found, `tool ${name} was not registered`);
  return found;
}

/* ------------------------------------------------------------------ *
 * Pure helpers                                                        *
 * ------------------------------------------------------------------ */

console.log('\nlib/text.js');
test('detectLanguage separates Chinese and English', () => {
  assert.equal(detectLanguage('这是一段中文文本，用于测试语言判定。'), 'zh');
  assert.equal(detectLanguage('This is an English sentence used for detection.'), 'en');
});
test('htmlToText drops script/style and decodes entities', () => {
  const text = htmlToText('<style>a{}</style><p>Excerpt &amp; body</p><script>x()</script>');
  assert.equal(text, 'Excerpt & body');
});
test('truncate cuts on a boundary and marks the cut', () => {
  const value = truncate('alpha beta gamma delta epsilon', 14);
  assert.ok(value.endsWith('\u2026'), value);
  assert.ok(value.length <= 20, value);
});
test('normalizeUrl drops tracking, fragments and www', () => {
  assert.equal(normalizeUrl('https://www.arXiv.org/abs/1706.03762/?utm_source=x#sec'), 'https://arxiv.org/abs/1706.03762');
});
test('extractYear reads a four-digit year', () => {
  assert.equal(extractYear('published 2017-06-12'), 2017);
  assert.equal(extractYear('no date here'), undefined);
});
test('chunkText splits on paragraphs and respects the cap', () => {
  const paragraph = 'Sentence one is here. Sentence two follows. '.repeat(6).trim();
  const chunks = chunkText(`${paragraph}\n\n${paragraph}\n\n${paragraph}`, 200);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `chunk of ${chunk.length} exceeds 200`);
  assert.ok(chunks.join('').includes('Sentence two follows.'));
});
test('chunkText returns the whole short text as one chunk', () => {
  assert.deepEqual(chunkText('short text', 100), ['short text']);
});

console.log('\nlib/style.js');
test('flags colloquial Chinese and half-width punctuation', () => {
  const result = checkStyle('这个方法非常好,而且很多工作都做过.我觉得其实差不多.');
  assert.equal(result.language, 'zh');
  const rules = new Set(result.issues.map((issue) => issue.rule));
  assert.ok(rules.has('zh-halfwidth-punctuation'), [...rules].join(','));
  assert.ok([...rules].some((rule) => rule.startsWith('zh-colloquial')), [...rules].join(','));
  assert.equal(result.stats.characters, '这个方法非常好,而且很多工作都做过.我觉得其实差不多.'.length);
});
test('flags English wordiness, contractions and long sentences', () => {
  const text = `In order to evaluate the model we don't use the baseline, because it isn't ${'representative '.repeat(45)}of the population.`;
  const result = checkStyle(text, { language: 'en' });
  const rules = new Set(result.issues.map((issue) => issue.rule));
  assert.ok([...rules].some((rule) => rule === 'en-wordy:in order to'), [...rules].join(','));
  assert.ok([...rules].some((rule) => rule.startsWith('en-contraction')), [...rules].join(','));
  assert.ok(rules.has('sentence-too-long'), [...rules].join(','));
  assert.equal(result.stats.longSentences >= 1, true);
});
test('separates colloquial wording from unsupported assertions in Chinese', () => {
  const result = checkStyle('众所周知，该方法效果很好。', { language: 'zh' });
  const rules = new Set(result.issues.map((issue) => issue.rule));
  assert.ok(rules.has('zh-unsupported:众所周知'), [...rules].join(','));
  assert.ok(!rules.has('zh-colloquial:众所周知'), [...rules].join(','));
  assert.equal(result.issues.find((issue) => issue.rule === 'zh-unsupported:众所周知').severity, 'info');
});
test('localises the long-sentence advice for Chinese', () => {
  const result = checkStyle(`这是${'很长的'.repeat(40)}一句话。`, { language: 'zh' });
  const long = result.issues.find((issue) => issue.rule === 'sentence-too-long' || issue.rule === 'sentence-long');
  assert.ok(long, 'expected a long-sentence finding');
  assert.match(long.suggestion, /拆/);
});
test('respects maxIssues and reports the full count in the summary', () => {
  const text = 'very really basically actually quite '.repeat(6);
  const result = checkStyle(text, { language: 'en', maxIssues: 3 });
  assert.equal(result.issues.length, 3);
  assert.match(result.summary, /total, 3 shown/);
});
test('a clean English sentence produces no errors', () => {
  const result = checkStyle('The model achieves 91.2% accuracy on the held-out set.', { language: 'en' });
  assert.equal(result.issues.filter((issue) => issue.severity === 'error').length, 0);
});

console.log('\nlib/polish.js');
test('buildPolishPrompt defaults to the academic brief', () => {
  const prompt = buildPolishPrompt({}, 'text');
  assert.equal(prompt.style, 'academic');
  assert.match(prompt.system, /scientific copy-editor/);
  assert.match(prompt.user, /BEGIN PASSAGE/);
});
test('buildPolishPrompt honours style, language and extra instructions', () => {
  const prompt = buildPolishPrompt({ style: 'journal-zh', language: 'zh', instructions: 'keep 注意力机制' }, 'text');
  assert.equal(prompt.style, 'journal-zh');
  assert.match(prompt.system, /输出语言：中文。/);
  assert.match(prompt.system, /keep 注意力机制/);
});
test('buildPolishPrompt ignores an unknown style', () => {
  assert.equal(buildPolishPrompt({ style: 'nonsense' }, 't').style, 'academic');
});
test('parsePolishResult reads bare, fenced and prose-wrapped JSON', () => {
  const bare = parsePolishResult('{"polished":"A","notes":["n"]}');
  assert.deepEqual([bare.polished, bare.structured], ['A', true]);
  const fenced = parsePolishResult('```json\n{"polished":"B","notes":[]}\n```');
  assert.deepEqual([fenced.polished, fenced.notes], ['B', []]);
  const prose = parsePolishResult('Here you go:\n{"polished":"C","notes":["x"]}\nHope that helps.');
  assert.deepEqual([prose.polished, prose.notes], ['C', ['x']]);
});
test('parsePolishResult falls back to the raw reply', () => {
  const result = parsePolishResult('Just some text.');
  assert.equal(result.polished, 'Just some text.');
  assert.equal(result.structured, false);
  assert.match(result.reason, /not the requested JSON/);
});
await atest('streamPolish accumulates deltas and ignores non-text chunks', async () => {
  const fakeStream = () => (async function* generate() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'hel' };
    yield { type: 'text-delta', index: 0, text: 'lo' };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  assert.equal(await streamPolish(fakeStream, { system: 's', user: 'u', provider: 'p', model: 'm' }), 'hello');
});
await atest('streamPolish surfaces provider failures', async () => {
  const failing = () => (async function* generate() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'X' } } };
  })();
  await assert.rejects(
    () => streamPolish(failing, { system: 's', user: 'u', provider: 'p', model: 'm' }),
    /rate limited/,
  );
});

console.log('\nlib/citation.js');
const BIB = `@article{vaswani2017attention,
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  title = {Attention is All You Need},
  journal = {Advances in Neural Information Processing Systems},
  year = {2017},
  volume = {30},
  pages = {5998--6008},
  doi = {10.5555/3295222.3295349}
}`;
test('parseBibtex reads type, key and braced fields', () => {
  const [entry] = parseBibtex(BIB);
  assert.equal(entry.type, 'article');
  assert.equal(entry.key, 'vaswani2017attention');
  assert.equal(entry.fields.pages, '5998\u20136008');
  assert.equal(entry.fields.journal, 'Advances in Neural Information Processing Systems');
});
test('parseAuthors handles BibTeX  and  separators', () => {
  const authors = parseAuthors('Vaswani, Ashish and Shazeer, Noam and Parmar, Niki');
  assert.deepEqual(authors.map((author) => author.last), ['Vaswani', 'Shazeer', 'Parmar']);
  assert.equal(authors[0].first, 'Ashish');
});
test('parseBibtex survives nested braces and quoted values', () => {
  const [entry] = parseBibtex('@inproceedings{k, title = {The {BERT} model}, author = "Devlin, Jacob", year = 2019, booktitle = {NAACL}}');
  assert.equal(entry.fields.title, 'The BERT model');
  assert.equal(entry.fields.author, 'Devlin, Jacob');
  assert.equal(entry.fields.year, '2019');
});
test('formatEntry produces the expected APA, IEEE, GB/T and Nature strings', () => {
  const [entry] = parseBibtex(BIB);
  const apa = formatEntry(entry, 'apa');
  assert.match(apa, /^Vaswani, A\., Shazeer, N\., & Parmar, N\. \(2017\)\. Attention is All You Need\. Advances in Neural Information Processing Systems, 30, 5998\u20136008\. https:\/\/doi\.org\/10\.5555\/3295222\.3295349$/);
  const ieee = formatEntry(entry, 'ieee');
  assert.match(ieee, /^A\. Vaswani, N\. Shazeer, and N\. Parmar, "Attention is All You Need," Advances in Neural Information Processing Systems, vol\. 30, pp\. 5998\u20136008, 2017, doi: 10\.5555\/3295222\.3295349\.$/);
  const gb = formatEntry(entry, 'gb7714');
  assert.match(gb, /^VASWANI A, SHAZEER N, PARMAR N\. Attention is All You Need\[J\]\. Advances in Neural Information Processing Systems, 2017, 30: 5998\u20136008\.$/);
  const nature = formatEntry(entry, 'nature');
  assert.match(nature, /^Vaswani, A\., Shazeer, N\. & Parmar, N\. Attention is All You Need\. Advances in Neural Information Processing Systems 30, 5998\u20136008 \(2017\)\.$/);
});
test('formatEntry uses et al. for MLA with three or more authors', () => {
  const [entry] = parseBibtex(BIB);
  assert.match(formatEntry(entry, 'mla'), /^Vaswani, Ashish, et al\. "Attention is All You Need\." /);
});
test('GB/T 7714 truncates authors, joins proceedings with // and picks the right Latin', () => {
  const [paper] = parseBibtex('@inproceedings{he2016deep, author={He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian}, title={Deep Residual Learning for Image Recognition}, booktitle={Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition}, year={2016}, pages={770--778}}');
  assert.equal(
    formatEntry(paper, 'gb7714'),
    'HE K, ZHANG X, REN S, et al. Deep Residual Learning for Image Recognition[C]//Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition, 2016: 770\u2013778.',
  );
  const [chinese] = parseBibtex('@article{zhang2020, author={张三 and 李四 and 王五 and 赵六}, title={一种新方法}, journal={计算机学报}, year={2020}, volume={43}, number={2}, pages={1--10}}');
  assert.equal(formatEntry(chinese, 'gb7714'), '张三, 李四, 王五, 等. 一种新方法[J]. 计算机学报, 2020, 43(2): 1\u201310.');
});
test('formatReferences sorts by author then year and numbers numbered styles', () => {
  const result = formatReferences([
    BIB,
    '@article{devlin2019bert, author={Devlin, Jacob and Chang, Ming-Wei}, title={BERT}, journal={NAACL}, year={2019}, pages={4171--4186}}',
    '@article{authors2020aaa, author={Aaronson, Sam}, title={Zeta}, journal={J}, year={2020}}',
  ], { style: 'ieee', sort: 'author' });
  assert.equal(result.count, 3);
  assert.match(result.entries[0].formatted, /Aaronson/);
  assert.match(result.entries[1].formatted, /Devlin/);
  const lines = result.bibliography.split('\n');
  assert.match(lines[0], /^\[1\] S\. Aaronson/);
});
test('formatReferences keeps unparsed input verbatim and warns', () => {
  const result = formatReferences(['https://example.org/paper', 'Smith, J. (2020). A study. Journal.'], { style: 'apa' });
  assert.equal(result.count, 2);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.entries.some((entry) => entry.formatted === 'https://example.org/paper'));
  assert.ok(result.entries.some((entry) => (entry.warnings ?? []).length > 0));
});
test('formatReferences falls back to APA for an unknown style', () => {
  assert.equal(formatReferences([BIB], { style: 'chicago-notes' }).style, 'apa');
});

/* ------------------------------------------------------------------ *
 * Plugin registration and tool execution                              *
 * ------------------------------------------------------------------ */

console.log('\nindex.js apply()');
test('resolveConfig bounds every value', () => {
  const resolved = resolveConfig({ searchMaxResults: 999, chunkChars: -4, styleMaxIssues: 0, polishMaxTokens: 4096 });
  assert.equal(resolved.searchMaxResults, 25);
  assert.equal(resolved.chunkChars, 6000);
  assert.equal(resolved.styleMaxIssues, 60);
  assert.equal(resolved.polishMaxTokens, 4096);
  assert.equal(resolveConfig(undefined).searchMaxResults, 8);
  assert.equal(resolveConfig(null).polishMaxTokens, undefined);
});
test('apply registers the four tools and the workflow section', () => {
  const { services } = makeServices();
  const { ctx, registered, sections } = makeContext(services);
  apply(ctx, {});
  assert.deepEqual(registered.map((definition) => definition.name).sort(), [
    'citation_format', 'literature_search', 'paper_polish', 'paper_style_check',
  ]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'research-paper-method');
  assert.equal(sections[0].order, 1900);
  assert.match(sections[0].text, /literature_search/);
});
test('every tool declares a valid parameter and output schema', () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  for (const definition of registered) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.output.schema.additionalProperties, false);
  }
});

console.log('\ntool: literature_search');
await atest('builds a scoped query, dedupes and filters by year', async () => {
  const { services, calls } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const tool = toolNamed(registered, 'literature_search');
  const value = await tool.execute({ query: 'transformer attention', scope: ['arxiv', 'bogus'], yearFrom: 2015, yearTo: 2020 }, EXEC);

  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].query, 'transformer attention site:arxiv.org');
  assert.equal(calls.search[0].maxResults, 8);
  assert.deepEqual(value.sources.map((source) => source.url), [
    'https://arxiv.org/abs/1706.03762',
    'https://arxiv.org/abs/1810.04805?utm_source=newsletter',
    'https://example.org/undated',
  ]);
  assert.equal(value.answer, 'provider answer');
  assert.ok(value.removed >= 2, `expected removals, got ${value.removed}`);
  assert.ok(value.notes.some((note) => /Unknown scope/.test(note)), JSON.stringify(value.notes));
  assert.ok(value.notes.some((note) => /Publication-year window 2015-2020/.test(note)), JSON.stringify(value.notes));
});
await atest('fetches plain-text excerpts for the requested top hits', async () => {
  const { services, calls } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const tool = toolNamed(registered, 'literature_search');
  const value = await tool.execute({ query: 'transformers', fetchExcerpts: 1, maxResults: 4 }, EXEC);
  assert.equal(calls.fetch.length, 1);
  assert.equal(value.sources[0].excerpt, 'Excerpt & body');
  assert.equal(value.sources[0].excerptStatus, 'HTTP 200');
});
await atest('fails clearly without a web service', async () => {
  const { services } = makeServices({ web: undefined });
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const tool = toolNamed(registered, 'literature_search');
  await assert.rejects(() => tool.execute({ query: 'x' }, EXEC), /needs the web service/);
});
await atest('rejects a missing query through argument validation', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  await assert.rejects(() => toolNamed(registered, 'literature_search').execute({}, EXEC), /invalid arguments/);
});

console.log('\ntool: paper_polish');
await atest('polishes inline text with the session model', async () => {
  const { services, calls } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const tool = toolNamed(registered, 'paper_polish');
  const value = await tool.execute({ text: '这是一段需要润色的文字。', style: 'journal-zh', language: 'zh' }, EXEC);

  assert.equal(calls.stream.length, 1);
  assert.equal(calls.stream[0].provider, 'deepseek-account');
  assert.equal(calls.stream[0].model, 'deepseek-flash');
  assert.match(calls.stream[0].system, /输出语言：中文。/);
  assert.match(value.polished, /^POLISHED\(/);
  assert.deepEqual(value.notes, ['tightened']);
  assert.equal(value.style, 'journal-zh');
  assert.equal(value.language, 'zh');
  assert.equal(value.chunks, 1);
  assert.equal(value.structured, true);
  assert.equal(value.inputCharacters, '这是一段需要润色的文字。'.length);
});
await atest('reads a file through the fs service and reports its path', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const value = await toolNamed(registered, 'paper_polish').execute({ path: 'paper.md' }, EXEC);
  assert.equal(value.source, 'paper.md');
  assert.equal(value.language, 'zh');
});
await atest('chunks a long passage and joins the results in order', async () => {
  const { services, calls } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, { chunkChars: 500 });
  const paragraph = 'This sentence exists to fill space in the chunk. '.repeat(6).trim();
  const text = [paragraph, paragraph, paragraph, paragraph].join('\n\n');
  const value = await toolNamed(registered, 'paper_polish').execute({ text, language: 'en' }, EXEC);
  assert.ok(value.chunks > 1, `expected chunking, got ${value.chunks}`);
  assert.equal(calls.stream.length, value.chunks);
  assert.equal(value.polished.split('\n\n').length, value.chunks);
});
await atest('rejects an over-long passage and asks for section-by-section work', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, { maxInputChars: 500 });
  await assert.rejects(
    () => toolNamed(registered, 'paper_polish').execute({ text: 'x'.repeat(600) }, EXEC),
    /accepts up to 500 characters/,
  );
});
await atest('rejects a call with neither text nor path', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  await assert.rejects(() => toolNamed(registered, 'paper_polish').execute({}, EXEC), /needs either `text` or `path`/);
});
await atest('reports an unusable model selection instead of failing silently', async () => {
  const { services } = makeServices({ agentDefaultModel: { currentSelection: () => ({}) } });
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  await assert.rejects(
    () => toolNamed(registered, 'paper_polish').execute({ text: 'hello' }, EXEC),
    /could not resolve a model/,
  );
});
await atest('falls back to the raw reply when the model ignores the JSON contract', async () => {
  const { services } = makeServices();
  services.llm = {
    stream: () => (async function* generate() {
      yield { type: 'text-delta', index: 0, text: 'Plain rewritten text.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
  };
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const value = await toolNamed(registered, 'paper_polish').execute({ text: 'hello' }, EXEC);
  assert.equal(value.polished, 'Plain rewritten text.');
  assert.equal(value.structured, false);
  assert.equal(value.warnings.length, 1);
});

console.log('\ntool: paper_style_check');
await atest('returns reproducible findings for a Chinese passage', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const value = await toolNamed(registered, 'paper_style_check').execute({ text: '这个结果非常好,我们觉得差不多.' }, EXEC);
  assert.equal(value.language, 'zh');
  assert.equal(value.stats.paragraphs, 1);
  assert.ok(value.issues.length > 0);
  assert.match(value.summary, /warning/);
});
await atest('rejects empty text', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  await assert.rejects(() => toolNamed(registered, 'paper_style_check').execute({ text: '   ' }, EXEC), /non-empty/);
});

console.log('\ntool: citation_format');
await atest('formats a reference list in the requested style', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  const value = await toolNamed(registered, 'citation_format').execute({ references: [BIB], style: 'gb7714', sort: 'author' }, EXEC);
  assert.equal(value.style, 'gb7714');
  assert.equal(value.count, 1);
  assert.match(value.bibliography, /^\[1\] VASWANI A, SHAZEER N, PARMAR N\./);
  assert.equal(value.entries[0].number, '1');
  assert.equal(value.entries[0].key, 'vaswani2017attention');
  assert.deepEqual(value.entries[0].warnings, []);
});
await atest('rejects an empty reference array', async () => {
  const { services } = makeServices();
  const { ctx, registered } = makeContext(services);
  apply(ctx, {});
  await assert.rejects(() => toolNamed(registered, 'citation_format').execute({ references: [] }, EXEC), /non-empty/);
});

/* ------------------------------------------------------------------ *
 * Bundle wiring                                                       *
 * ------------------------------------------------------------------ */

console.log('\nbundle manifest');
await atest('package.json declares the bundle patch and the icon', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.icon, './icon.svg');
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.exports['.'] === './index.js');
});
await atest('the plugin imports nothing outside its own package', async () => {
  const sources = ['../index.js', '../lib/tool-schema.js', '../lib/text.js', '../lib/style.js', '../lib/polish.js', '../lib/citation.js', '../tools/literature.js', '../tools/polish.js', '../tools/style.js', '../tools/citation.js'];
  for (const relative of sources) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    for (const match of source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('.'),
        `${relative} imports "${specifier}"; a profile-installed bundle must stay self-contained`,
      );
    }
  }
});
await atest('cordis.patch.yml declares one research-paper preset with the tools row', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: preset-research-paper/);
  assert.match(patch, /id: research-paper$/m);
  assert.match(patch, /name: 'dsh-research-paper-mode'/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-tool-web'/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-persona'/);
  assert.ok(!/\t/.test(patch), 'YAML must not contain tab characters');
  const promptVariables = [...patch.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1].trim());
  assert.deepEqual(
    promptVariables.filter((name) => name !== 'provider' && name !== 'model'),
    [],
    'persona templates may only use the registered variables provider/model',
  );
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`);
  process.exitCode = 1;
}
