import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { collectRightSideLines } from './diff.ts';

export function createGitHubReviewTool(contextRoot: string) {
  let submitted = false;
  return defineTool({
    name: 'create_pull_request_review',
    label: 'Create pull request review',
    description: 'Create at most one COMMENT review containing all accepted inline findings.',
    parameters: Type.Object({
      body: Type.String({ maxLength: 1000 }),
      comments: Type.Array(
        Type.Object({
          path: Type.String({ minLength: 1 }),
          line: Type.Integer({ minimum: 1 }),
          startLine: Type.Optional(Type.Integer({ minimum: 1 })),
          side: Type.Literal('RIGHT'),
          body: Type.String({ minLength: 1, maxLength: 5000 }),
        }),
        { minItems: 1, maxItems: 30 },
      ),
    }),
    execute: async (_id, params) => {
      if (submitted) throw new Error('a review was already submitted');
      const changedFiles = new Set((await readFile(`${contextRoot}/changed-files.txt`, 'utf8')).split('\n').filter(Boolean));
      const rightSideLines = collectRightSideLines(await readFile(`${contextRoot}/pr.diff`, 'utf8'));
      for (const comment of params.comments) {
        const normalized = path.posix.normalize(comment.path);
        if (normalized !== comment.path || path.posix.isAbsolute(normalized) || normalized.startsWith('../') || !changedFiles.has(normalized)) {
          throw new Error(`comment path is not in the current diff: ${comment.path}`);
        }
        if (comment.startLine && comment.startLine > comment.line) throw new Error('startLine must not exceed line');
        const validLines = rightSideLines.get(normalized);
        const start = comment.startLine ?? comment.line;
        for (let line = start; line <= comment.line; line += 1) {
          if (!validLines?.has(line)) throw new Error(`comment line is not on the RIGHT side of the diff: ${normalized}:${line}`);
        }
      }
      const token = required('GITHUB_TOKEN');
      const repository = required('GITHUB_REPOSITORY');
      const pull = required('REVIEW_PULL_NUMBER');
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
          body: params.body,
          commit_id: process.env.REVIEW_HEAD_SHA,
          comments: params.comments.map(({ startLine, ...comment }) => ({
            ...comment,
            ...(startLine ? { start_line: startLine, start_side: 'RIGHT' } : {}),
          })),
        }),
      });
      if (!response.ok) throw new Error(`GitHub review failed: ${response.status} ${await response.text()}`);
      submitted = true;
      const review = (await response.json()) as { html_url: string };
      return { content: [{ type: 'text', text: `Review created: ${review.html_url}` }], details: review };
    },
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
