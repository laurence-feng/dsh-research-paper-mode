/**
 * `paper_polish`: academic copy-editing of a passage or a manuscript file,
 * performed by the model the session already uses.
 * @module dsh-research-paper-mode/tools/polish
 */

import { defineTool } from '../lib/tool-schema.js';
import { POLISH_STYLES, buildPolishPrompt, parsePolishResult, streamPolish } from '../lib/polish.js';
import { chunkText, detectLanguage, normalizeWhitespace, truncate } from '../lib/text.js';

export function registerPaperPolish(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'paper_polish',
    description: [
      'Polish an academic passage or manuscript file: tighten the prose, fix the register, keep every claim, number and citation exactly as given.',
      'Pass `text` directly, or `path` to read a file from the working directory.',
      'Long passages are split on paragraph boundaries and polished in order.',
      'This tool never writes files: it returns the polished text, so apply it with your own edit/write tools.',
    ].join(' '),
    parameters: {
      text: { type: 'string', description: 'The passage to polish. Provide this or `path`.' },
      path: { type: 'string', description: 'Path of a manuscript file to read and polish. Provide this or `text`.' },
      style: {
        type: 'string',
        enum: Object.keys(POLISH_STYLES),
        description: `Editing brief. One of ${Object.keys(POLISH_STYLES).join(', ')}. Defaults to academic.`,
      },
      language: {
        type: 'string',
        enum: ['auto', 'zh', 'en'],
        description: 'Output language. Defaults to auto, which follows the input.',
      },
      instructions: {
        type: 'string',
        description: 'Extra author requirements for this pass, for example “keep the term 注意力机制” or “target a 250-word abstract”.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          polished: { type: 'string', required: true },
          notes: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          style: { type: 'string', required: true },
          language: { type: 'string', required: true },
          chunks: { type: 'number', required: true },
          inputCharacters: { type: 'number', required: true },
          outputCharacters: { type: 'number', required: true },
          structured: { type: 'boolean', required: true },
          source: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const header = `Polished ${value.inputCharacters} -> ${value.outputCharacters} chars in ${value.chunks} chunk(s), style=${value.style}, language=${value.language}.`;
        const notes = value.notes.length === 0 ? '' : `\n\nChanges:\n${value.notes.map((note) => `- ${note}`).join('\n')}`;
        const warnings = value.warnings.length === 0 ? '' : `\n\nWarnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`;
        return [{ type: 'text', text: `${header}${notes}${warnings}\n\n---8<--- POLISHED\n${value.polished}\n---8<--- END` }];
      },
    },
    async execute(args, exec) {
      let text = typeof args.text === 'string' ? args.text : '';
      let source;
      if (text.trim().length === 0) {
        if (typeof args.path !== 'string' || args.path.trim().length === 0) {
          throw new Error('paper_polish needs either `text` or `path`.');
        }
        const fs = ctx.get('fs');
        if (fs === undefined) {
          throw new Error('paper_polish cannot read `path` without the fs service; read the file yourself and pass `text` instead.');
        }
        const cwd = exec.agent?.session?.header?.cwd;
        const target = await fs.resolve(args.path, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal });
        text = await fs.readText(target, exec.signal);
        source = args.path;
      }

      const input = normalizeWhitespace(text);
      if (input.length === 0) throw new Error('paper_polish received an empty passage.');
      if (input.length > config.maxInputChars) {
        throw new Error(
          `paper_polish accepts up to ${config.maxInputChars} characters per call and received ${input.length}. `
          + 'Polish the manuscript section by section.',
        );
      }

      const llm = ctx.get('llm');
      if (llm === undefined) throw new Error('paper_polish needs the llm service to call a model.');
      const selector = ctx.get('agentDefaultModel');
      const selection = selector?.currentSelection?.();
      if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
        throw new Error('paper_polish could not resolve a model for this session.');
      }

      const requested = args.language === 'zh' || args.language === 'en' ? args.language : undefined;
      const language = requested ?? detectLanguage(input);
      const chunks = chunkText(input, config.chunkChars);
      const polishedParts = [];
      const collectedNotes = [];
      const warnings = [];
      let structured = true;
      let resolvedStyle = typeof args.style === 'string' && Object.hasOwn(POLISH_STYLES, args.style) ? args.style : 'academic';

      for (const chunk of chunks) {
        exec.signal.throwIfAborted();
        const prompt = buildPolishPrompt(
          { style: args.style, instructions: args.instructions, language },
          chunk,
        );
        resolvedStyle = prompt.style;
        const reply = await streamPolish(
          (options) => llm.stream(options),
          {
            system: prompt.system,
            user: prompt.user,
            provider: selection.provider,
            model: selection.model,
            maxTokens: config.polishMaxTokens,
            signal: exec.signal,
          },
        );
        const parsed = parsePolishResult(reply);
        if (!parsed.structured) {
          structured = false;
          if (typeof parsed.reason === 'string' && !warnings.includes(parsed.reason)) warnings.push(parsed.reason);
        }
        if (parsed.polished.trim().length === 0) {
          warnings.push(`Chunk ${polishedParts.length + 1} came back empty; the original wording was kept.`);
          polishedParts.push(chunk);
          continue;
        }
        polishedParts.push(parsed.polished.trim());
        collectedNotes.push(...parsed.notes);
      }

      const polished = polishedParts.join('\n\n');
      const notes = [...new Set(collectedNotes)].slice(0, 20);
      return {
        polished,
        notes,
        warnings,
        style: resolvedStyle,
        language,
        chunks: chunks.length,
        inputCharacters: input.length,
        outputCharacters: polished.length,
        structured,
        ...(source === undefined ? {} : { source }),
      };
    },
  }));
}
