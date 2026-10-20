/**
 * Research-paper writing mode: the tool half of the `research-paper` agent preset.
 *
 * Everything registered here lives in the preset's scope, so these tools are
 * visible only to sessions that selected the mode.
 * @module dsh-research-paper-mode
 */

import { registerCitationFormat } from './tools/citation.js';
import { registerLiteratureSearch } from './tools/literature.js';
import { registerPaperPolish } from './tools/polish.js';
import { registerPaperStyleCheck } from './tools/style.js';

/** Stable Loader identity. */
export const name = 'research-paper-tools';

/** Services this plugin contributes to. */
export const inject = ['tools', 'systemPrompt'];

/**
 * The workflow section the mode adds to the system prompt.
 * Names the four tools so the model uses them instead of improvising.
 */
const METHOD_SECTION = `科研写作工作流（本模式的专用工具）：
1. 立题与检索：先用 literature_search 摸清已有工作与彼此的分歧，再用 web_fetch 读关键原文。每一处论据都记下可核验的出处。
2. 结构先行：先给出提纲（研究问题 / 每节的论点 / 支撑每个论点所需的证据 / 目标期刊与语言），与用户确认后再逐节成稿。
3. 成稿落盘：用文件工具把稿件写进工作目录，一节一个标题或一个文件，便于迭代、比较与交付。
4. 语言润色：用 paper_polish 逐段润色，改完再落盘；不要整篇一次性覆盖。
5. 定稿自查：用 paper_style_check 过一遍规范问题，只修真正有问题的条目，不要为了清零警告而删内容。
6. 参考文献：用 citation_format 统一格式。缺字段的条目按其 warnings 请用户补齐。
引用纪律：正文引用与参考文献表必须一一对应；无法核实的条目要显式标注“待核实”，绝不编造文献、作者、年份、卷期或 DOI。`;

function intOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the row's config with defaults.
 *
 * The plugin declares no `Config` schema, so unknown keys are ignored rather
 * than rejected, and every value is bounded before it reaches a tool.
 * @param {unknown} config - the value from the Loader row.
 */
export function resolveConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {};
  const bounded = (value, fallback, min, max) => {
    const resolved = intOr(value, fallback);
    return Math.min(Math.max(resolved, min), max);
  };
  return {
    searchMaxResults: bounded(input.searchMaxResults, 8, 1, 25),
    searchExcerptChars: bounded(input.searchExcerptChars, 1200, 200, 8000),
    maxInputChars: bounded(input.maxInputChars, 24000, 500, 200000),
    chunkChars: bounded(input.chunkChars, 6000, 500, 20000),
    styleMaxIssues: bounded(input.styleMaxIssues, 60, 1, 500),
    polishMaxTokens: Number.isInteger(input.polishMaxTokens) && input.polishMaxTokens > 0 ? input.polishMaxTokens : undefined,
  };
}

/**
 * Register the research tools and the workflow prompt section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the preset-scoped context.
 * @param {unknown} config - the Loader row's `config`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  registerLiteratureSearch(ctx, resolved);
  registerPaperPolish(ctx, resolved);
  registerPaperStyleCheck(ctx, resolved);
  registerCitationFormat(ctx);

  const order = typeof ctx.systemPrompt?.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH') - 100
    : 1900;
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'research-paper-method', order, text: METHOD_SECTION }),
    'research-paper.method',
  );
}
