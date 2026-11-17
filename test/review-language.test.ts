import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';
import { buildFooter, checkText, coverageNotice } from '../scripts/publish-review.ts';
import { findingLabelFromText, findingLabelText, parseReviewLanguage, reportHeading, reviewCheckMessages, reviewLanguageInstruction } from '../scripts/review-language.ts';
import { findingLabels, type FindingLabel } from '../scripts/review-result.ts';

test('the central repository selects the language; missing or unsupported values fail before minting tokens', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.env.REVIEW_LANGUAGE, '${{ vars.REVIEW_LANGUAGE }}');
  const steps = workflow.jobs.review.steps;
  const mint = steps.findIndex((step: any) => step.uses?.startsWith('actions/create-github-app-token@'));
  const validation = steps.slice(0, mint).find((step: any) => step.run?.includes('REVIEW_LANGUAGE'));
  assert.ok(validation);
  for (const value of [undefined, '', 'auto', 'English', 'en', 'zh-CN']) {
    const accepted = value === 'en' || value === 'zh-CN';
    const result = spawnSync('bash', ['-e', '-c', validation.run], { encoding: 'utf8', env: {
      ...process.env, REVIEW_LANGUAGE: value, REVIEW_THINKING_LEVEL: 'high', REVIEW_FAST_MODE: 'false',
      REPOSITORY: 'owner/repo', REPOSITORY_ID: '1', PULL_NUMBER: '2', TRIGGER_SOURCE: 'automatic',
      BASE_SHA: '', HEAD_SHA: '', GITHUB_OUTPUT: '/dev/null',
    } });
    assert.equal(result.status, accepted ? 0 : 1);
    if (accepted) assert.equal(parseReviewLanguage(value), value);
    else assert.throws(() => parseReviewLanguage(value), /REVIEW_LANGUAGE/);
  }
});

test('the language choice reaches the trusted prompt with headings matching the publisher', async () => {
  const control = fileURLToPath(new URL('..', import.meta.url));
  const english = await loadReviewPrompt(control, 'en');
  const chinese = await loadReviewPrompt(control, 'zh-CN');
  assert.match(english, /REVIEW_LANGUAGE=en\. .*in English\./);
  assert.match(english, /JSON schema fields and enum values stay as written/);
  assert.match(chinese, /REVIEW_LANGUAGE=zh-CN\. .*Simplified Chinese/);
  assert.ok(chinese.includes(`- What was checked → ${reportHeading('zh-CN', 'What was checked')}`));
  assert.ok(chinese.includes('- Fix and verify → 怎么改、怎么验证'));
  assert.doesNotMatch(reviewLanguageInstruction('en'), /→/);
  for (const label of Object.keys(findingLabels) as FindingLabel[]) {
    for (const language of ['en', 'zh-CN'] as const) assert.equal(findingLabelFromText(findingLabelText(label, language)), label);
  }
});

test('English coverage notice, footer, and Check share the language, and partial coverage still asks to continue', () => {
  const footer = buildFooter({ language: 'en', runUrl: 'https://example.test/run', workspaceUrl: 'https://example.test/workspace',
    model: 'openai/test', thinkingLevel: 'high', durationSeconds: 65, cost: 0.01, controlSha: 'a'.repeat(40) });
  const notice = coverageNotice(['src/auth.ts'], 3, 'en');
  const check = checkText({ language: 'en', footer, coverage: { reviewed: 2, total: 3, sourceReviewed: 1 }, operations: [] });
  assert.match(footer.details, /reasoning high.*Duration 1m 5s.*Estimated cost \$0.0100/);
  assert.match(notice, /covered 2\/3 files/);
  assert.match(notice, /does not update.*Agentic Review \/ audit/);
  assert.match(check, /## Coverage\n\nReviewed 2\/3 files/);
  assert.doesNotMatch(footer.links + footer.details + notice + check, /[\u3400-\u9fff]/);
  const messages = reviewCheckMessages('en');
  assert.match(messages.action_required[1], /\{reviewed\}\/\{total\}/);
  assert.match(messages.failure[1], /remains blocked/);
});
