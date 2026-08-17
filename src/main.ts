import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareContext } from './context.ts';
import { createGitHubReviewTool } from './github.ts';
import { createReviewModel } from './model.ts';
import { materializeBasePolicy } from './policy.ts';
import { loadReviewAgents } from './review-agents.ts';
import { runAggregator, runReviewer } from './session.ts';

const engineRoot = path.resolve(import.meta.dirname, '..');
const cwd = path.resolve(process.env.REVIEW_REPOSITORY_PATH ?? process.cwd());
const baseSha = required('REVIEW_BASE_SHA');
const headSha = required('REVIEW_HEAD_SHA');
const context = await prepareContext(cwd, baseSha, headSha);
await materializeBasePolicy(context.root, process.env.REVIEW_POLICY_ROOT ?? 'spec/review');
const { runtime, model } = await createReviewModel(context.root);
const thinking = (process.env.REVIEW_AGENT_THINKING ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh';
const reviewAgents = await loadReviewAgents(engineRoot, process.env.REVIEW_AGENTS);
await Promise.all(reviewAgents.map(({ id }) => access(`${engineRoot}/prompts/${id}.md`)));

const results = await Promise.allSettled(
  reviewAgents.map(({ id }) => runReviewer({
    cwd,
    id,
    promptPath: `${engineRoot}/prompts/${id}.md`,
    modelRuntime: runtime,
    model,
    thinking,
    contextRoot: context.root,
  })),
);
const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ reviewer: reviewAgents[index]!.id, error: String(result.reason) }] : []);
if (failures.length) await writeFile(`${context.root}/results/failures.json`, `${JSON.stringify(failures, null, 2)}\n`);
if (failures.some(({ reviewer }) => reviewAgents.find(({ id }) => id === reviewer)?.required)) throw new Error('required Review Agent failed');

const reviewerResults = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
await runAggregator({
  cwd,
  promptPath: `${engineRoot}/prompts/aggregator.md`,
  modelRuntime: runtime,
  model,
  thinking: 'low',
  results: reviewerResults,
  failures,
  githubTool: createGitHubReviewTool(context.root),
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
