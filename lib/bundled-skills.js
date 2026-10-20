/**
 * Bundled nature-* skills, vendored from https://github.com/Yuan1z0825/nature-skills
 * (Apache-2.0, see skills/NOTICE and skills/LICENSE.apache-2.0).
 *
 * The provider mirrors the first-party `@deepseek-ai/dsh-skill-badge` pattern:
 * one in-package provider whose candidates point at the vendored `SKILL.md`
 * files, registered on `ctx.skills` so the mode's sessions see the skills in
 * their catalog without any filesystem setup.
 *
 * Deliberately free of Harness imports: `BUNDLED_SKILL_RANK` is the published
 * constant value from `@deepseek-ai/dsh-skill` (600), restated here so this
 * package stays self-contained.
 * @module dsh-research-paper-mode/lib/bundled-skills
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Standard precedence rank for packaged skill providers (`dsh-skill`). */
const BUNDLED_SKILL_RANK = 600;

/** Provider name shown as the skills' origin. */
const PROVIDER_NAME = 'research-paper-mode';

const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/**
 * The vendored skills. `name` matches each SKILL.md frontmatter (upstream
 * ships nature-proposal-writer under the compatibility name `researchwrite`);
 * descriptions are the frontmatter descriptions, folded to one line.
 */
export const BUNDLED_SKILLS = [
  {
    dir: 'nature-academic-search',
    name: 'nature-academic-search',
    description: 'Search literature across sources, verify or manage citations, and build MeSH strategies or citation-impact audits. Use for 文献检索、引文核对、参考文献管理、严格他引 and evidence-backed citer profiles; not for translating a paper or drafting manuscript prose.',
  },
  {
    dir: 'nature-experiment-log',
    name: 'nature-experiment-log',
    description: '标准化实验日志记录——直接上传或读取本地图片、语音和文字，产出带 YAML frontmatter 的 Markdown；可选集成飞书 CLI 与 Obsidian。',
  },
  {
    dir: 'nature-image2ppt',
    name: 'nature-image2ppt',
    description: 'Reconstruct slide images, screenshots, scanned PDFs, or image-only PPTX files as object-level editable PowerPoint. Use for 图片转可编辑PPT、截图还原PPT and diagram reconstruction; not authoring a new deck from research notes.',
  },
  {
    dir: 'nature-literature-pipeline',
    name: 'nature-literature-pipeline',
    description: 'Complete automated literature discovery pipeline: multi-source search → six-dimension scoring → fine reading → formatted delivery → archival. Combines a configurable engine with daily cron-driven application layer. Works with Feishu, Telegram, or any messaging platform.',
  },
  {
    dir: 'nature-paper-xray',
    name: 'nature-paper-xray',
    description: 'Read one supplied paper closely enough to reconstruct how its authors actually got there, rather than restating what the abstract claims. Use for 精读论文, 讲透这篇论文, 把这篇读懂, 作者为什么这么设计, 这个公式怎么推出来的, paper x-ray, and deep single-paper comprehension before building on, reviewing, presenting, or citing that paper. Not a summary, not a translation, not a peer review.',
  },
  {
    dir: 'nature-paper2ppt',
    name: 'nature-paper2ppt',
    description: 'Create or improve a Chinese academic PPTX from a scientific paper or research reading notes, with source figures and speaker notes. Use for 论文做PPT、文献汇报、组会PPT and paper-based conference or defense presentations.',
  },
  {
    dir: 'nature-polishing',
    name: 'nature-polishing',
    description: 'Polish, translate, or tighten existing academic prose while preserving facts, terminology, and evidence boundaries. Use for 论文润色、学术翻译、正文精简, or manuscript LaTeX layout fixes. Use nature-writing when the main task is drafting new sections or rebuilding the manuscript argument.',
  },
  {
    dir: 'nature-proposal-writer',
    name: 'researchwrite',
    description: 'Compose, revise, or audit research proposals, opening reports, and research plans from supporting evidence. Use for 研究计划、开题报告、科研项目申请书. Invoked as researchwrite for compatibility; use nature-writing for general manuscript sections.',
  },
  {
    dir: 'nature-reader',
    name: 'nature-reader',
    description: 'Create source-grounded Chinese-English paper readers with aligned text, figures, tables, and equations. Use for 全文翻译、中英文对照、论文精读 or source-linked questions about a paper; respect a requested excerpt or question without generating a full reader.',
  },
  {
    dir: 'nature-ref-verifier',
    name: 'nature-ref-verifier',
    description: '对学术文献逐条执行多源交叉验证，逐字段对比作者、标题、年份、卷期、页码，标记卷年/DOI年冲突、作者顺序异常、页码偏差等问题，输出结构化验证报告。可批量处理整篇论文/开题报告的参考文献列表，也可单条校验，支持与 Zotero 同步修正。',
  },
  {
    dir: 'nature-writing',
    name: 'nature-writing',
    description: 'Draft or restructure scientific manuscript arguments, sections, and initial-submission materials from author-provided evidence. Use for 论文写作、章节起草、论证重构、正文压缩、首次投稿材料. Use nature-polishing for language-only edits to existing prose and nature-response for post-decision correspondence.',
  },
];

function skillFileUrl(dir) {
  return new URL(`../skills/${dir}/SKILL.md`, import.meta.url);
}

/** Strip the YAML frontmatter block; the registry serves body content only. */
export function stripFrontmatter(raw) {
  return String(raw).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/**
 * Register the vendored skills on `ctx.skills`. Returns false (and the mode
 * keeps working without skills) when the registry service is absent.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the preset-scoped context.
 */
export function registerBundledSkills(ctx) {
  const registry = ctx.get('skills');
  if (registry === undefined || typeof registry.registerProvider !== 'function') return false;

  const candidates = BUNDLED_SKILLS.map((skill) => ({
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    locator: skillFileUrl(skill.dir),
    resourceBase: { kind: 'directory', path: `${SKILLS_ROOT}${skill.dir}` },
  }));
  const byName = new Map(BUNDLED_SKILLS.map((skill) => [skill.name, skill]));

  registry.registerProvider(() => ({
    name: PROVIDER_NAME,
    list: () => Promise.resolve(candidates),
    async get(candidate) {
      const skill = byName.get(candidate?.name);
      if (skill === undefined) return undefined;
      const raw = await readFile(skillFileUrl(skill.dir), 'utf8');
      return {
        name: skill.name,
        description: skill.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: `${SKILLS_ROOT}${skill.dir}` },
        content: stripFrontmatter(raw),
      };
    },
  }));
  return true;
}
