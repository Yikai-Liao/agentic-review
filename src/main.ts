import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareContext } from './context.ts';
import { buildPullRequestReview, submitPullRequestReview } from './github.ts';
import { createReviewModel } from './model.ts';
import { materializeBasePolicy } from './policy.ts';
import { loadReviewAgents } from './review-agents.ts';
import { runAggregator, runReviewer } from './session.ts';

const engineRoot = path.resolve(import.meta.dirname, '..');
const cwd = path.resolve(process.env.REVIEW_REPOSITORY_PATH ?? process.cwd());
const baseSha = required('REVIEW_BASE_SHA');
const headSha = required('REVIEW_HEAD_SHA');
console.log(`[agentic-review] Preparing ${baseSha.slice(0, 8)}...${headSha.slice(0, 8)}`);
const context = await prepareContext(cwd, baseSha, headSha);
await materializeBasePolicy(context.root, process.env.REVIEW_POLICY_ROOT ?? 'spec/review');
const { runtime, model } = await createReviewModel(context.root);
const thinking = (process.env.REVIEW_AGENT_THINKING ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh';
const { overviewAgent, reviewAgents } = await loadReviewAgents(engineRoot, `${context.root}/base/.agentic-review.yml`);
console.log(`[agentic-review] Review Agents: ${reviewAgents.map(({ id, required }) => `${id}${required ? ' (required)' : ''}`).join(', ')}`);

const results = await Promise.allSettled(
  reviewAgents.map(({ id, instructions }) => runReviewer({
    cwd,
    id,
    instructions,
    providesOverview: id === overviewAgent,
    promptPath: `${engineRoot}/prompts/${id}.md`,
    modelRuntime: runtime,
    model,
    thinking,
    contextRoot: context.root,
  })),
);
const failures = results.flatMap((result, index) => result.status === 'rejected'
  ? [{ reviewer: reviewAgents[index]!.id, required: reviewAgents[index]!.required, error: String(result.reason) }]
  : []);
if (failures.length) await writeFile(`${context.root}/results/failures.json`, `${JSON.stringify(failures, null, 2)}\n`);
if (failures.some(({ required }) => required)) throw new Error('Required Review Agent failed');

const reviewerResults = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
const overview = reviewerResults.find(({ reviewer }) => reviewer === overviewAgent)?.overview;
if (!overview) throw new Error('Overview Review Agent did not submit an overview');
const aggregationFindings = reviewerResults.flatMap((result) => result.findings.map((finding, index) => ({
  id: `${result.reviewer}:${index}`,
  reviewer: result.reviewer,
  finding,
})));
if (aggregationFindings.length > 30) throw new Error(`Review has ${aggregationFindings.length} findings; maximum publishable count is 30`);
const notes = [...new Set(reviewerResults.flatMap((result) => result.notes ?? []))];
if (notes.reduce((length, note) => length + note.length, 0) > 3500) throw new Error('Reviewer notes exceed the publishable body budget');
const failedReviewers = failures.map(({ reviewer }) => reviewer);
console.log(`[agentic-review] Aggregating ${aggregationFindings.length} finding(s)`);
const aggregation = await runAggregator({
  cwd,
  promptPath: `${engineRoot}/prompts/aggregator.md`,
  modelRuntime: runtime,
  model,
  findings: aggregationFindings,
});
const findingsById = new Map(aggregationFindings.map(({ id, finding }) => [id, finding]));
const findingGroups = aggregation.map((group) => group.map((id) => findingsById.get(id)!));
console.log(`[agentic-review] Rendering ${findingGroups.length} deduplicated finding(s)`);
await submitPullRequestReview(context.root, buildPullRequestReview({ overview, notes, findingGroups, failedReviewers }));
console.log('[agentic-review] Review request completed');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
