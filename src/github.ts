import { readFile, writeFile } from 'node:fs/promises';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { assertRightSideRange, collectRightSideLines } from './diff.ts';

export const pullRequestReviewSchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 1000, pattern: '^## (✅|⚠️) Agentic Review' }),
  comments: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      line: Type.Integer({ minimum: 1 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      side: Type.Literal('RIGHT'),
      body: Type.String({ minLength: 1, maxLength: 5000 }),
    }, { additionalProperties: false }),
    { maxItems: 30 },
  ),
}, { additionalProperties: false });

export type PullRequestReview = Static<typeof pullRequestReviewSchema>;
const reviewValidator = Compile(pullRequestReviewSchema);

export function validatePullRequestReview(value: unknown): PullRequestReview {
  if (!reviewValidator.Check(value)) throw new Error(`Invalid pull request review: ${JSON.stringify(reviewValidator.Errors(value))}`);
  return value;
}

export function createGitHubReviewTool(contextRoot: string) {
  let submitted = false;
  return defineTool({
    name: 'create_pull_request_review',
    label: 'Create pull request review',
    description: 'Create exactly one COMMENT review with a summary and any accepted inline findings.',
    parameters: pullRequestReviewSchema,
    execute: async (_id, params) => {
      if (submitted) throw new Error('a review was already submitted');
      await validateLocations(contextRoot, params);
      const outputPath = process.env.REVIEW_OUTPUT_PATH;
      const message = outputPath
        ? await writeFile(outputPath, `${JSON.stringify(params, null, 2)}\n`).then(() => `Review staged: ${outputPath}`)
        : await publishGitHubReview(contextRoot, params);
      console.log(`[agentic-review] ${outputPath ? 'Staged' : 'Published'} Review with ${params.comments.length} inline comment(s)`);
      submitted = true;
      return { content: [{ type: 'text', text: message }], details: {} };
    },
  });
}

export async function publishGitHubReview(contextRoot: string, review: PullRequestReview): Promise<string> {
  review = validatePullRequestReview(review);
  await validateLocations(contextRoot, review);
  const token = required('GITHUB_TOKEN');
  const repository = required('GITHUB_REPOSITORY');
  const pull = required('REVIEW_PULL_NUMBER');
  const headSha = required('REVIEW_HEAD_SHA');
  const current = await githubRequest(`/repos/${repository}/pulls/${pull}`, token);
  const currentPull = (await current.json()) as { head: { sha: string } };
  if (currentPull.head.sha !== headSha) throw new Error(`stale review head: ${headSha}`);
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/pulls/${pull}/reviews`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      event: 'COMMENT',
      body: review.body,
      commit_id: headSha,
      comments: review.comments.map(({ path, line, startLine, side, body }) => ({
        path,
        line,
        side,
        body,
        ...(startLine ? { start_line: startLine, start_side: 'RIGHT' } : {}),
      })),
    }),
  });
  if (!response.ok) throw new Error(`GitHub review failed: ${response.status} ${await response.text()}`);
  const result = (await response.json()) as { html_url: string };
  return `Review created: ${result.html_url}`;
}

async function githubRequest(path: string, token: string): Promise<Response> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
  return response;
}

async function validateLocations(contextRoot: string, review: PullRequestReview): Promise<void> {
  const changedFiles = new Set((await readFile(`${contextRoot}/changed-files.txt`, 'utf8')).split('\n').filter(Boolean));
  const rightSideLines = collectRightSideLines(await readFile(`${contextRoot}/pr.diff`, 'utf8'));
  for (const comment of review.comments) {
    assertRightSideRange(changedFiles, rightSideLines, comment.path, comment.startLine ?? comment.line, comment.line);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
