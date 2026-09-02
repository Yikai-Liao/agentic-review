import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { listReviewAssociations } from '../scripts/list-review-associations.ts';

const commits = ['1'.repeat(40), '2'.repeat(40)];

function response(repository: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data: { repository } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('lists only commit-associated pull requests and closing issues', async () => {
  const cursors: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('AssociatedPullRequests')) {
      assert.deepEqual(body.variables, {
        owner: 'Qiyin-Tech',
        name: 'service',
        oid0: commits[0],
        oid1: commits[1],
        after0: null,
        after1: null,
      });
      return response({
        c0: {
          oid: commits[0],
          associatedPullRequests: {
            nodes: [
              { number: 9, title: 'Current', url: 'https://github.com/Qiyin-Tech/service/pull/9', repository: { nameWithOwner: 'Qiyin-Tech/service' } },
              { number: 4, title: 'Source', url: 'https://github.com/Qiyin-Tech/service/pull/4', repository: { nameWithOwner: 'Qiyin-Tech/service' } },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
        c1: {
          oid: commits[1],
          associatedPullRequests: {
            nodes: [
              { number: 4, title: 'Source', url: 'https://github.com/Qiyin-Tech/service/pull/4', repository: { nameWithOwner: 'Qiyin-Tech/service' } },
              { number: 2, title: 'Shared', url: 'https://github.com/Qiyin-Tech/api/pull/2', repository: { nameWithOwner: 'Qiyin-Tech/api' } },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }

    cursors.push(body.variables.after);
    const first = body.variables.after === null;
    return response({
      pullRequest: {
        closingIssuesReferences: {
          nodes: first
            ? [{ number: 8, title: 'Acceptance', url: 'https://github.com/Qiyin-Tech/service/issues/8', repository: { nameWithOwner: 'Qiyin-Tech/service' } }]
            : [{ number: 3, title: 'Tracking', url: 'https://github.com/Qiyin-Tech/api/issues/3', repository: { nameWithOwner: 'Qiyin-Tech/api' } }],
          pageInfo: first
            ? { hasNextPage: true, endCursor: 'next' }
            : { hasNextPage: false, endCursor: null },
        },
      },
    });
  };

  assert.deepEqual(await listReviewAssociations({
    commits,
    repository: 'Qiyin-Tech/service',
    pullNumber: 9,
    token: 'token',
    fetchImpl,
  }), {
    pull_requests: [
      { repository: 'Qiyin-Tech/api', number: 2, title: 'Shared', url: 'https://github.com/Qiyin-Tech/api/pull/2' },
      { repository: 'Qiyin-Tech/service', number: 4, title: 'Source', url: 'https://github.com/Qiyin-Tech/service/pull/4' },
    ],
    issues: [
      { repository: 'Qiyin-Tech/api', number: 3, title: 'Tracking', url: 'https://github.com/Qiyin-Tech/api/issues/3' },
      { repository: 'Qiyin-Tech/service', number: 8, title: 'Acceptance', url: 'https://github.com/Qiyin-Tech/service/issues/8' },
    ],
  });
  assert.deepEqual(cursors, [null, 'next']);
});

test('paginates commit-associated pull requests', async () => {
  const sha = '3'.repeat(40);
  const afterValues: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('AssociatedPullRequests')) {
      afterValues.push(body.variables.after0);
      const after = body.variables.after0;
      return response({
        c0: {
          oid: sha,
          associatedPullRequests: {
            nodes: after === null
              ? [{ number: 4, title: 'First page', url: 'https://github.com/Qiyin-Tech/service/pull/4', repository: { nameWithOwner: 'Qiyin-Tech/service' } }]
              : [{ number: 5, title: 'Second page', url: 'https://github.com/Qiyin-Tech/service/pull/5', repository: { nameWithOwner: 'Qiyin-Tech/service' } }],
            pageInfo: after === null
              ? { hasNextPage: true, endCursor: 'next-prs' }
              : { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    return response({
      pullRequest: {
        closingIssuesReferences: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  };

  assert.deepEqual(await listReviewAssociations({
    commits: [sha],
    repository: 'Qiyin-Tech/service',
    pullNumber: 9,
    token: 'token',
    fetchImpl,
  }), {
    pull_requests: [
      { repository: 'Qiyin-Tech/service', number: 4, title: 'First page', url: 'https://github.com/Qiyin-Tech/service/pull/4' },
      { repository: 'Qiyin-Tech/service', number: 5, title: 'Second page', url: 'https://github.com/Qiyin-Tech/service/pull/5' },
    ],
    issues: [],
  });
  assert.deepEqual(afterValues, [null, 'next-prs']);
});

test('prepares the association index before running Pi', async () => {
  const workflow = await readFile(new URL('../.github/workflows/agentic-review.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Prepare review association index[\s\S]*?node control\/scripts\/list-review-associations\.ts[\s\S]*?Run Pi review/);
  assert.match(workflow, /REVIEW_ASSOCIATIONS_PATH: \$\{\{ runner\.temp \}\}\/review-associations\.json/);
});
