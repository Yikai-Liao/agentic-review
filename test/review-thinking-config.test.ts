import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

test('missing repository thinking level fails before issuing review tokens, configured levels remain selectable', () => {
  const entry = parse(readFileSync(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8'));
  const execution = entry.jobs.review.uses;
  const workflow = execution
    ? parse(readFileSync(new URL(`../${execution}`, import.meta.url), 'utf8')) : entry;
  const jobLevel = structuredClone(workflow);
  delete jobLevel.env?.REVIEW_THINKING_LEVEL;
  for (const job of Object.values(jobLevel.jobs) as Array<{ env?: Record<string, string> }>) {
    job.env = { ...job.env, REVIEW_THINKING_LEVEL: '${{ vars.REVIEW_THINKING_LEVEL }}' };
  }
  const withPreparation = structuredClone(workflow);
  withPreparation.jobs.review.steps.unshift({ name: 'Inspect configuration', run: 'printf "level=%s\\n" "$REVIEW_THINKING_LEVEL"' });
  const directory = mkdtempSync(path.join(tmpdir(), 'review-thinking-'));
  try {
    for (const candidate of [workflow, jobLevel, withPreparation]) {
      const review = candidate.jobs.review;
      const mint = review.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/create-github-app-token@'));
      assert.ok(mint >= 0);
      const validated = review.steps.slice(0, mint).some((step: { run?: string; env?: Record<string, string> }) => {
        if (!step.run?.includes('REVIEW_THINKING_LEVEL')) return false;
        const environment = { ...candidate.env, ...review.env, ...step.env };
        if (environment.REVIEW_THINKING_LEVEL !== '${{ vars.REVIEW_THINKING_LEVEL }}') return false;
        const run = (level: string) => spawnSync('bash', ['-e', '-c', step.run!], {
          encoding: 'utf8', cwd: directory, env: { ...process.env,
            REVIEW_THINKING_LEVEL: level, REVIEW_LANGUAGE: 'zh-CN', REPOSITORY: 'owner/repo', REPOSITORY_ID: '1', PULL_NUMBER: '2',
            TRIGGER_SOURCE: 'automatic', BASE_SHA: '', HEAD_SHA: '', GITHUB_OUTPUT: path.join(directory, 'output') },
        });
        const missing = run('');
        return missing.status !== null && missing.status !== 0 && missing.stderr.includes('REVIEW_THINKING_LEVEL')
          && ['low', 'xhigh'].every(level => run(level).status === 0);
      });
      assert.ok(validated, 'thinking level must be validated before minting Review tokens');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
