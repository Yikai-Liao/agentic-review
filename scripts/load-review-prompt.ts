import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { reviewLanguageInstruction, type ReviewLanguage } from './review-language.ts';

export async function loadReviewPrompt(control: string, language: ReviewLanguage = 'zh-CN') {
  const files = [
    'skills/agentic-review/SKILL.md',
    ...['protocol', 'findings', 'review-state', 'evidence-access'].map(name => `skills/agentic-review/references/${name}.md`),
    'central/github-context.md', 'central/review-result.md',
    'skills/agentic-review/references/levels/code.md',
    ...['alignment', 'security', 'reliability', 'performance'].map(name => `skills/agentic-review/references/focuses/${name}.md`),
    ...['behavior', 'test-contracts'].map(name => `skills/agentic-review/references/levels/code/${name}.md`),
  ];
  const [entry, ...references] = await Promise.all([
    'central/review-rules.md', ...files,
  ].map(file => readFile(path.join(control, file), 'utf8')));
  return entry + '\n\n' + reviewLanguageInstruction(language)
    + references.map((content, index) => `\n\n## control/${files[index]}\n\n${content}`).join('');
}
