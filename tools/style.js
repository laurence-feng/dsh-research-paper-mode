/**
 * `paper_style_check`: deterministic academic-writing lint over a passage.
 * @module dsh-research-paper-mode/tools/style
 */

import { defineTool } from '../lib/tool-schema.js';
import { checkStyle } from '../lib/style.js';
import { truncate } from '../lib/text.js';

export function registerPaperStyleCheck(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'paper_style_check',
    description: [
      'Lint a passage against academic-writing rules and return reproducible, character-offset findings.',
      'Checks register and wordiness, contractions, vague attribution, repeated particles, mixed half/full-width punctuation, over-long sentences and paragraphs, and possible passive voice.',
      'Findings are advisory: fix the ones that are genuinely wrong for the target venue, and do not delete content merely to clear a warning.',
    ].join(' '),
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The passage to check. Use the whole section rather than a single sentence so sentence- and paragraph-level rules have context.',
      },
      language: {
        type: 'string',
        enum: ['auto', 'zh', 'en'],
        description: 'Rule set to apply. Defaults to auto, which follows the passage.',
      },
      maxIssues: { type: 'number', description: `Maximum findings to return (default ${config.styleMaxIssues}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          language: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          stats: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              characters: { type: 'number', required: true },
              words: { type: 'number', required: true },
              sentences: { type: 'number', required: true },
              paragraphs: { type: 'number', required: true },
              averageSentenceLength: { type: 'number', required: true },
              longSentences: { type: 'number', required: true },
            },
          },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rule: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                message: { type: 'string', required: true },
                suggestion: { type: 'string' },
                excerpt: { type: 'string' },
                offset: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const header = `${value.summary} | ${value.stats.words} words, ${value.stats.sentences} sentences, avg ${value.stats.averageSentenceLength}`;
        const lines = value.issues.map((issue) => {
          const where = issue.offset === undefined ? '' : ` @${issue.offset}`;
          const fix = issue.suggestion === undefined ? '' : ` -> ${issue.suggestion}`;
          return `- [${issue.severity}] ${issue.rule}${where}: ${issue.message}${fix}${issue.excerpt === undefined ? '' : `\n    ${truncate(issue.excerpt, 120)}`}`;
        });
        return [{ type: 'text', text: [header, ...lines].join('\n') }];
      },
    },
    async execute(args) {
      if (typeof args.text !== 'string' || args.text.trim().length === 0) {
        throw new Error('paper_style_check needs non-empty `text`.');
      }
      const language = args.language === 'zh' || args.language === 'en' ? args.language : 'auto';
      return checkStyle(args.text, { language, maxIssues: args.maxIssues ?? config.styleMaxIssues });
    },
  }));
}
