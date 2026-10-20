/**
 * Deterministic academic-writing checks.
 *
 * Every rule here is a pure function of the text, so a `paper_style_check`
 * result is reproducible and auditable. Rules are advisory: they flag patterns
 * that are usually wrong in a manuscript, not certain errors.
 * @module dsh-research-paper-mode/lib/style
 */

import {
  countWords,
  detectLanguage,
  splitParagraphs,
  splitSentences,
} from './text.js';

/** @typedef {'error'|'warning'|'info'} Severity */

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/** Wordy or informal English phrasing with a preferred replacement. */
const ENGLISH_PHRASES = [
  ['in order to', 'to'],
  ['due to the fact that', 'because'],
  ['owing to the fact that', 'because'],
  ['in spite of the fact that', 'although'],
  ['in the event that', 'if'],
  ['for the purpose of', 'to'],
  ['with regard to', 'regarding'],
  ['with respect to', 'regarding'],
  ['in terms of', 'for'],
  ['a large number of', 'many'],
  ['a small number of', 'a few'],
  ['a number of', 'several'],
  ['the vast majority of', 'most'],
  ['a majority of', 'most'],
  ['a total of', ''],
  ['it is important to note that', ''],
  ['it should be noted that', ''],
  ['it is worth noting that', ''],
  ['at this point in time', 'now'],
  ['in the near future', 'soon'],
  ['prior to', 'before'],
  ['subsequent to', 'after'],
  ['is able to', 'can'],
  ['are able to', 'can'],
  ['has the ability to', 'can'],
  ['have the ability to', 'can'],
  ['utilize', 'use'],
  ['utilizes', 'uses'],
  ['utilized', 'used'],
  ['utilizing', 'using'],
  ['a lot of', 'many'],
  ['lots of', 'many'],
  ['very', ''],
  ['really', ''],
  ['quite', ''],
  ['basically', ''],
  ['actually', ''],
];

/** First-person and vague-attribution phrasing that weakens a claim. */
const ENGLISH_HEDGES = [
  ["i think", 'state the claim directly'],
  ["i believe", 'state the claim directly'],
  ['we think', 'state the claim directly'],
  ['we believe', 'state the claim directly'],
  ['obviously', 'give the evidence instead'],
  ['clearly', 'give the evidence instead'],
  ['of course', 'give the evidence instead'],
  ['everyone knows', 'give the evidence instead'],
  ['as we all know', 'give the evidence instead'],
];

/** Contractions do not belong in a formal manuscript. */
const ENGLISH_CONTRACTIONS = [
  ["don't", 'do not'],
  ["doesn't", 'does not'],
  ["isn't", 'is not'],
  ["aren't", 'are not'],
  ["wasn't", 'was not'],
  ["weren't", 'were not'],
  ["can't", 'cannot'],
  ["won't", 'will not'],
  ["it's", 'it is'],
  ["that's", 'that is'],
  ["we're", 'we are'],
  ["they're", 'they are'],
  ["hasn't", 'has not'],
  ["haven't", 'have not'],
];

/** Colloquial Chinese wording with a written-register replacement. */
const CHINESE_PHRASES = [
  ['很多', '大量 / 众多'],
  ['非常多', '数量可观'],
  ['非常', '十分 / 显著'],
  ['特别好', '表现突出'],
  ['真的', '（删除）'],
  ['其实', '（删除）'],
  ['差不多', '大致'],
  ['差不多一样', '基本一致'],
  ['差不多都', '大多'],
  ['搞定', '完成'],
  ['弄清楚', '明确'],
  ['东西', '内容 / 对象'],
  ['挺好的', '效果良好'],
  ['还有就是', '此外'],
  ['所以说', '因此'],
  ['所以说呢', '因此'],
  ['我们可以看到', '结果表明'],
  ['我们可以看出', '结果表明'],
  ['我觉得', '本文认为'],
  ['我认为', '本文认为'],
  ['等等等', '等'],
];

/** Chinese assertions that stand in for evidence. */
const CHINESE_UNSUPPORTED = [
  ['众所周知', '给出引用或删除'],
  ['不言而喻', '给出引用或删除'],
  ['显而易见', '给出证据或改为可检验的表述'],
  ['毋庸置疑', '给出引用或删除'],
];

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';

function excerptAround(text, index, length) {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  const prefix = start > 0 ? '\u2026' : '';
  const suffix = end < text.length ? '\u2026' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pushPhraseIssues(text, phrases, options, push) {
  const { severity, message, rulePrefix, wordBoundary } = options;
  for (const [phrase, suggestion] of phrases) {
    const body = escapeRegExp(phrase);
    const source = wordBoundary ? `(?<![A-Za-z])${body}(?![A-Za-z])` : body;
    const regex = new RegExp(source, 'gi');
    let match;
    let guard = 0;
    while ((match = regex.exec(text)) !== null) {
      if (guard >= 100) break;
      guard += 1;
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      push({
        rule: `${rulePrefix}:${phrase}`,
        severity,
        message,
        suggestion,
        offset: match.index,
        excerpt: excerptAround(text, match.index, match[0].length),
      });
    }
  }
}

function pushRegexIssues(text, spec, push) {
  const flags = spec.flags ?? '';
  const regex = new RegExp(spec.source, flags.includes('g') ? flags : `${flags}g`);
  let match;
  let guard = 0;
  while ((match = regex.exec(text)) !== null) {
    if (guard >= 100) break;
    guard += 1;
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    push({
      rule: spec.rule,
      severity: spec.severity,
      message: spec.message,
      suggestion: typeof spec.suggestion === 'function' ? spec.suggestion(match) : spec.suggestion,
      offset: match.index,
      excerpt: excerptAround(text, match.index, match[0].length),
    });
  }
}

/**
 * Check one passage against the academic-writing rules.
 * @param {string} text - the passage to inspect.
 * @param {{language?: 'auto'|'zh'|'en', maxIssues?: number}} [options]
 * @returns {{language: 'zh'|'en', stats: object, issues: Array<object>, summary: string}}
 */
export function checkStyle(text, options = {}) {
  const value = String(text ?? '');
  const requested = options.language ?? 'auto';
  const language = requested === 'auto' ? detectLanguage(value) : requested;
  const maxIssues = Number.isInteger(options.maxIssues) && options.maxIssues > 0 ? options.maxIssues : 60;
  const issues = [];
  const push = (issue) => issues.push(issue);

  if (language === 'en') {
    pushPhraseIssues(value, ENGLISH_PHRASES, {
      severity: 'warning',
      message: 'Wordy or informal phrasing; prefer the shorter form.',
      rulePrefix: 'en-wordy',
      wordBoundary: true,
    }, push);
    pushPhraseIssues(value, ENGLISH_HEDGES, {
      severity: 'info',
      message: 'Unsupported or first-person assertion; state the claim and its evidence.',
      rulePrefix: 'en-hedge',
      wordBoundary: true,
    }, push);
    pushPhraseIssues(value, ENGLISH_CONTRACTIONS, {
      severity: 'error',
      message: 'Contraction is not acceptable in a formal manuscript.',
      rulePrefix: 'en-contraction',
      wordBoundary: true,
    }, push);

    pushRegexIssues(value, {
      rule: 'en-space-before-punctuation',
      severity: 'warning',
      source: '\\s+[,.;:!?](?=\\s|$)',
      message: 'Space before punctuation.',
      suggestion: 'Remove the space.',
    }, push);
    pushRegexIssues(value, {
      rule: 'en-repeated-word',
      severity: 'warning',
      source: '\\b([A-Za-z]{2,})\\s+\\1\\b',
      message: 'Repeated word.',
      suggestion: (match) => `Keep one “${match[1]}”.`,
    }, push);
    pushRegexIssues(value, {
      rule: 'en-double-space',
      severity: 'info',
      source: '\\S {2,}\\S',
      message: 'Run of multiple spaces.',
      suggestion: 'Use a single space.',
    }, push);
    pushRegexIssues(value, {
      rule: 'en-possible-passive',
      severity: 'info',
      source: '\\b(?:is|are|was|were|be|been|being)\\s+(?:\\w+ed|shown|known|used|made|given|taken|found|seen|done|held|built)\\b',
      message: 'Possible passive voice; check that the agent matters here.',
      suggestion: 'Consider naming the actor.',
    }, push);
    pushRegexIssues(value, {
      rule: 'en-first-person',
      severity: 'info',
      source: '\\b(?:I|we|our|my|us)\\b',
      message: 'First-person reference; many venues prefer impersonal phrasing.',
      suggestion: 'Confirm the target venue’s style.',
    }, push);
    pushRegexIssues(value, {
      rule: 'en-etc',
      severity: 'warning',
      source: '\\betc\\.',
      message: '“etc.” is vague in formal writing.',
      suggestion: 'Name the remaining items or drop the list.',
    }, push);
  } else {
    pushPhraseIssues(value, CHINESE_PHRASES, {
      severity: 'warning',
      message: '口语化表达，建议改用书面语。',
      rulePrefix: 'zh-colloquial',
      wordBoundary: false,
    }, push);
    pushPhraseIssues(value, CHINESE_UNSUPPORTED, {
      severity: 'info',
      message: '以断言代替证据；学术写作需要给出引用或论证。',
      rulePrefix: 'zh-unsupported',
      wordBoundary: false,
    }, push);
    pushRegexIssues(value, {
      rule: 'zh-halfwidth-punctuation',
      severity: 'warning',
      source: `[${CJK}][,;:?!]`,
      message: '中文句子中混用了半角标点。',
      suggestion: '改用全角标点（，；：？！）。',
    }, push);
    pushRegexIssues(value, {
      rule: 'zh-straight-quote',
      severity: 'warning',
      source: `[${CJK}][^\\n]{0,12}"`,
      message: '中文正文中使用了直引号。',
      suggestion: '改用中文引号“”。',
    }, push);
    pushRegexIssues(value, {
      rule: 'zh-repeated-particle',
      severity: 'error',
      source: '(的的|了了|是是|和和|在在)',
      message: '虚词重复。',
      suggestion: '删除重复的虚词。',
    }, push);
    pushRegexIssues(value, {
      rule: 'zh-missing-space-latin',
      severity: 'info',
      source: `[${CJK}][A-Za-z]|[A-Za-z][${CJK}]`,
      message: '中英文之间缺少空格。',
      suggestion: '中英文之间加一个半角空格。',
    }, push);
    pushRegexIssues(value, {
      rule: 'zh-fullwidth-space',
      severity: 'info',
      source: '\\u3000',
      message: '使用了全角空格。',
      suggestion: '改用半角空格或直接删除。',
    }, push);
  }

  const sentences = splitSentences(value);
  const paragraphs = splitParagraphs(value);
  const sentenceLimits = language === 'en' ? [40, 60] : [60, 100];
  const splitAdvice = language === 'en' ? 'Break it into shorter sentences or a list.' : '拆成更短的句子，或改为并列结构。';
  const considerAdvice = language === 'en' ? 'Break it into shorter sentences.' : '可拆成更短的句子。';
  for (const sentence of sentences) {
    const length = language === 'en' ? countWords(sentence, 'en') : sentence.length;
    if (length >= sentenceLimits[1]) {
      push({
        rule: 'sentence-too-long',
        severity: 'warning',
        message: language === 'en'
          ? `Sentence runs ${length} words; split it.`
          : `句子长达 ${length} 字，建议拆分。`,
        suggestion: splitAdvice,
        offset: value.indexOf(sentence),
        excerpt: excerptAround(value, Math.max(0, value.indexOf(sentence)), Math.min(sentence.length, 60)),
      });
    } else if (length >= sentenceLimits[0]) {
      push({
        rule: 'sentence-long',
        severity: 'info',
        message: language === 'en'
          ? `Sentence runs ${length} words; consider splitting.`
          : `句子长达 ${length} 字，可考虑拆分。`,
        suggestion: considerAdvice,
        offset: value.indexOf(sentence),
        excerpt: excerptAround(value, Math.max(0, value.indexOf(sentence)), Math.min(sentence.length, 60)),
      });
    }
  }

  const paragraphLimit = language === 'en' ? 250 : 600;
  for (const paragraph of paragraphs) {
    const length = language === 'en' ? countWords(paragraph, 'en') : paragraph.length;
    if (length > paragraphLimit) {
      push({
        rule: 'paragraph-too-long',
        severity: 'info',
        message: language === 'en'
          ? `Paragraph runs ${length} words; one paragraph should carry one idea.`
          : `段落长达 ${length} 字，建议按论点拆分。`,
        suggestion: language === 'en' ? 'Split by claim.' : '一段只承载一个论点。',
        offset: value.indexOf(paragraph),
        excerpt: excerptAround(value, Math.max(0, value.indexOf(paragraph)), 40),
      });
    }
  }

  const totalWords = countWords(value, language);
  const longSentences = sentences.filter((sentence) => {
    const length = language === 'en' ? countWords(sentence, 'en') : sentence.length;
    return length >= sentenceLimits[0];
  }).length;

  issues.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const limited = issues.slice(0, maxIssues);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;

  const stats = {
    characters: value.length,
    words: totalWords,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    averageSentenceLength: sentences.length === 0 ? 0 : Math.round((totalWords / sentences.length) * 10) / 10,
    longSentences,
  };

  return {
    language,
    stats,
    issues: limited,
    summary: `${counts.error} error / ${counts.warning} warning / ${counts.info} info (${issues.length} total, ${limited.length} shown)`,
  };
}
