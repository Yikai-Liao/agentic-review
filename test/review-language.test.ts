import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';
import { buildFooter, checkText, coverageNotice } from '../scripts/publish-review.ts';
import { parseReviewLanguage, reviewCheckMessages } from '../scripts/review-language.ts';

test('语言由中央仓库选择，缺失和不支持的值在签发 token 前失败', () => {
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

test('英文选择进入可信提示词，并明确保留 JSON schema 与枚举值', async () => {
  const control = fileURLToPath(new URL('..', import.meta.url));
  const english = await loadReviewPrompt(control, 'en');
  const chinese = await loadReviewPrompt(control, 'zh-CN');
  assert.match(english, /REVIEW_LANGUAGE=en。.*英文（English）/);
  assert.match(english, /JSON schema 字段及枚举值保留原文/);
  assert.match(english, /What was checked/);
  assert.match(chinese, /REVIEW_LANGUAGE=zh-CN。.*简体中文/);
  assert.doesNotMatch(english, /Review 使用简体中文/);
});

test('英文覆盖提示、页脚和 Check 使用同一语言，部分覆盖仍要求继续审查', () => {
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
