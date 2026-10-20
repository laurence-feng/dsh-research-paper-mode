/**
 * Research-paper writing mode: the tool half of the `research-paper` agent preset.
 *
 * Everything registered here lives in the preset's scope, so these tools are
 * visible only to sessions that selected the mode.
 * @module dsh-research-paper-mode
 */

import { registerBundledSkills } from './lib/bundled-skills.js';
import { registerKimiSearch } from './lib/kimi.js';
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
const METHOD_SECTION = `科研写作工作流（本模式的专用工具与技能）：
1. 立题与检索：先用 literature_search 摸清已有工作与彼此的分歧，再用 web_fetch 读关键原文；跨引擎对照时可给 literature_search 传 provider（deepseek-official / deepseek-search-api / kimi-web-search，kimi 需 MOONSHOT_API_KEY）。每一处论据都记下可核验的出处。
2. 内置技能：任务匹配时调用对应 skill——nature-academic-search（多源检索与引文核对）、nature-reader（全文精读/中英对照）、nature-paper-xray（单篇深读）、nature-writing（章节起草）、nature-polishing（语言润色）、academic-humanizer（AI 辅助学术文稿的行文与语气打磨，不改数字/结果/引用）、nature-paper2ppt / nature-image2ppt（做 PPT）、nature-ref-verifier（参考文献核验）、nature-literature-pipeline（文献追踪流水线）、nature-experiment-log（实验日志）、researchwrite（项目申请书/开题报告）。
3. 结构先行：先给出提纲（研究问题 / 每节的论点 / 支撑每个论点所需的证据 / 目标期刊与语言），与用户确认后再逐节成稿。
4. 成稿落盘：用文件工具把稿件写进工作目录，一节一个标题或一个文件，便于迭代、比较与交付。
5. 语言润色：用 paper_polish 逐段润色，改完再落盘；不要整篇一次性覆盖。
6. 定稿自查：用 paper_style_check 过一遍规范问题，只修真正有问题的条目，不要为了清零警告而删内容。
7. 参考文献：用 citation_format 统一格式。缺字段的条目按其 warnings 请用户补齐。
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
  const usableUrl = (value) => {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    try {
      return new URL(value).protocol.startsWith('http') ? value.replace(/\/+$/, '') : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    searchMaxResults: bounded(input.searchMaxResults, 8, 1, 25),
    searchExcerptChars: bounded(input.searchExcerptChars, 1200, 200, 8000),
    maxInputChars: bounded(input.maxInputChars, 24000, 500, 200000),
    chunkChars: bounded(input.chunkChars, 6000, 500, 20000),
    styleMaxIssues: bounded(input.styleMaxIssues, 60, 1, 500),
    polishMaxTokens: Number.isInteger(input.polishMaxTokens) && input.polishMaxTokens > 0 ? input.polishMaxTokens : undefined,
    kimiApiKey: typeof input.kimiApiKey === 'string' && input.kimiApiKey.length > 0 ? input.kimiApiKey : undefined,
    kimiBaseURL: usableUrl(input.kimiBaseURL),
    kimiTier: input.kimiTier === 'pro' ? 'pro' : 'basic',
    kimiTimeoutSeconds: bounded(input.kimiTimeoutSeconds, 20, 1, 60),
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
  registerKimiSearch(ctx, resolved);
  registerBundledSkills(ctx);

  const order = typeof ctx.systemPrompt?.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH') - 100
    : 1900;
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'research-paper-method', order, text: METHOD_SECTION }),
    'research-paper.method',
  );
}
