/**
 * `citation_format`: turn BibTeX entries into a consistent reference list.
 * @module dsh-research-paper-mode/tools/citation
 */

import { defineTool } from '../lib/tool-schema.js';
import { STYLES, formatReferences } from '../lib/citation.js';
import { truncate } from '../lib/text.js';

export function registerCitationFormat(ctx) {
  ctx.tools.register(defineTool({
    name: 'citation_format',
    description: [
      'Format a reference list in a consistent citation style.',
      'Each item should be a complete BibTeX entry; bare URLs and freeform strings are kept verbatim and reported as unparsed rather than guessed at.',
      'Use the returned `warnings` to tell the author which references are incomplete — never fill a missing year, volume, or DOI yourself.',
    ].join(' '),
    parameters: {
      references: {
        type: 'array',
        required: true,
        description: 'One string per reference: a BibTeX entry, a bare URL, or a freeform reference line.',
        items: { type: 'string' },
      },
      style: {
        type: 'string',
        enum: STYLES,
        description: `Target style: ${STYLES.join(', ')}. Defaults to apa.`,
      },
      sort: {
        type: 'string',
        enum: ['author', 'year', 'none'],
        description: 'Ordering of the output list. Defaults to author (then year).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          style: { type: 'string', required: true },
          count: { type: 'number', required: true },
          bibliography: { type: 'string', required: true },
          warnings: { type: 'array', items: { type: 'string' } },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                type: { type: 'string', required: true },
                formatted: { type: 'string', required: true },
                number: { type: 'string' },
                source: { type: 'string', required: true },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.count} reference(s) in ${value.style} style.`, '', value.bibliography];
        const problems = value.entries.filter((entry) => (entry.warnings ?? []).length > 0);
        if (problems.length > 0) {
          lines.push('', 'Incomplete or unparsed references:');
          for (const entry of problems) {
            lines.push(`- ${truncate(entry.source, 90)}`);
            for (const warning of entry.warnings) lines.push(`    ${warning}`);
          }
        }
        if ((value.warnings ?? []).length > 0) {
          lines.push('', 'Warnings:');
          for (const warning of value.warnings) lines.push(`- ${warning}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      if (!Array.isArray(args.references) || args.references.length === 0) {
        throw new Error('citation_format needs a non-empty `references` array.');
      }
      const result = formatReferences(args.references, { style: args.style, sort: args.sort });
      return {
        style: result.style,
        count: result.count,
        bibliography: result.bibliography,
        warnings: result.warnings,
        entries: result.entries.map((entry) => ({
          key: entry.key,
          type: entry.type,
          formatted: entry.formatted,
          ...(entry.numbered.length > 0 ? { number: entry.numbered } : {}),
          source: entry.source,
          warnings: entry.warnings,
        })),
      };
    },
  }));
}
