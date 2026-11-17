import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { attributeReviewSources } from '../scripts/attribute-review-sources.ts';

test('First-parent attribution: reviewed sources, combined content, and unreviewed sources map to source-reviewed, combined review, and normal review', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'attribute-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  const write = (file: string, content: string) => writeFileSync(path.join(directory, file), content);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const lines = (...values: string[]) => `${values.join('\n')}\n`;
  for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'h.ts', 'w.ts', 'z.ts']) write(file, lines('1', '2', '3', '4', '5', '6', '7', '8', '9'));
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const merge = (branch: string, message: string) => {
    git('merge', '--no-ff', '-q', '-m', message, branch);
    return { head: git('rev-parse', branch), merge: git('rev-parse', 'HEAD') };
  };
  const pull = (branch: string, edit: () => void) => {
    git('checkout', '-q', '-b', branch, base);
    edit();
    git('add', '.'); git('commit', '-qm', branch);
    git('checkout', '-q', 'main');
  };
  pull('p1', () => { write('a.ts', lines('one', '2', '3', '4', '5', '6', '7', '8', '9')); write('b.ts', lines('one', '2', '3', '4', '5', '6', '7', '8', '9')); });
  const p1 = merge('p1', 'merge p1');
  // p2 and p1 change different parts of b.ts; the auto-merged content is a combination no head has.
  pull('p2', () => { write('b.ts', lines('1', '2', '3', '4', '5', '6', '7', '8', 'nine')); write('c.ts', lines('three', '2', '3', '4', '5', '6', '7', '8', '9')); });
  const p2 = merge('p2', 'merge p2');
  // p4 and p5 change the same line of h.ts and conflict; p5 merges with its own version, so the result equals p5's head but drops p4's merged change.
  pull('p4', () => write('h.ts', lines('from p4', '2', '3', '4', '5', '6', '7', '8', '9')));
  const p4 = merge('p4', 'merge p4');
  pull('p5', () => write('h.ts', lines('from p5', '2', '3', '4', '5', '6', '7', '8', '9')));
  git('merge', '--no-ff', '-q', '-X', 'theirs', '-m', 'merge p5', 'p5');
  const p5 = { head: git('rev-parse', 'p5'), merge: git('rev-parse', 'HEAD') };
  // p6 is reviewed on branch y (which carries extra history z.ts), then rebased into main: z.ts never entered the source review diff.
  git('checkout', '-q', '-b', 'y', base);
  write('z.ts', lines('from y', '2', '3', '4', '5', '6', '7', '8', '9'));
  git('add', '.'); git('commit', '-qm', 'y');
  const y = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'p6');
  write('w.ts', lines('from p6', '2', '3', '4', '5', '6', '7', '8', '9'));
  git('add', '.'); git('commit', '-qm', 'p6');
  git('checkout', '-q', 'main');
  const p6 = merge('p6', 'merge p6');
  // p3 is merged without passing review.
  pull('p3', () => write('e.ts', lines('five', '2', '3', '4', '5', '6', '7', '8', '9')));
  const p3 = merge('p3', 'merge p3');
  // A direct commit has no source PR.
  write('d.ts', lines('four', '2', '3', '4', '5', '6', '7', '8', '9'));
  git('add', '.'); git('commit', '-qm', 'direct');
  const head = git('rev-parse', 'HEAD');

  const pullRequests = new Map([[p1.merge, { number: 1, head: p1.head }], [p2.merge, { number: 2, head: p2.head }], [p3.merge, { number: 3, head: p3.head }],
    [p4.merge, { number: 4, head: p4.head }], [p5.merge, { number: 5, head: p5.head }], [p6.merge, { number: 6, head: p6.head }]]);
  // Base at review time: most sources are based directly on base; p6 was reviewed on branch y.
  const reviewedHeads = new Map([[p1.head, [1, base]], [p2.head, [2, base]], [p4.head, [4, base]], [p5.head, [5, base]], [p6.head, [6, y]]] as Array<[string, [number, string]]>);
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body);
    const repository: Record<string, unknown> = {};
    for (const key of Object.keys(variables).filter((name) => /^oid\d+$/.test(name))) {
      const oid = variables[key] as string;
      const entry = `c${key.slice(3)}`;
      if (query.includes('MergedSources')) {
        const found = pullRequests.get(oid);
        repository[entry] = { oid, associatedPullRequests: { pageInfo: { hasNextPage: false }, nodes: found ? [
          { number: found.number, title: `PR ${found.number}`, url: `https://github.com/owner/repo/pull/${found.number}`, state: 'MERGED',
            headRefOid: found.head, mergeCommit: { oid }, repository: { nameWithOwner: 'owner/repo' } },
          // The same commit is also referenced by another open PR, which cannot count as a source.
          { number: 99, title: 'Other', url: 'https://github.com/owner/repo/pull/99', state: 'OPEN', headRefOid: found.head,
            mergeCommit: null, repository: { nameWithOwner: 'owner/repo' } },
        ] : [] } };
      } else {
        const [number, reviewBase] = reviewedHeads.get(oid) ?? [0, ''];
        repository[entry] = { oid, checkSuites: { nodes: number ? [{ app: { slug: 'review-app' }, checkRuns: { nodes: [{
          name: 'Agentic Review / audit', status: 'COMPLETED', conclusion: 'SUCCESS',
          externalId: `1:${number}:${reviewBase}:${oid}:automatic:10:1`,
        }] } }] : [] } };
      }
    }
    return new Response(JSON.stringify({ data: { repository } }));
  }) as unknown as typeof fetch;

  const result = await attributeReviewSources({
    targetPath: directory, repository: 'owner/repo', repositoryId: '1', mergeBase: base, headSha: head,
    appSlug: 'review-app', token: 'token', fetchImpl,
  });
  // a.ts is changed only by reviewed p1; b.ts after p2's merge differs from every head; c.ts matches p2's head.
  // h.ts equals p5's head but overwrites p4's change, so it needs a combined review.
  // w.ts is p6's own change; z.ts is branch y history brought in by p6's rebase, which the source review never covered.
  assert.deepEqual(result.reviewed, ['a.ts', 'c.ts', 'w.ts']);
  assert.deepEqual(result.composition.map((item) => [item.path, item.pull_requests.map((source) => source.number)]), [['b.ts', [2]], ['h.ts', [5]], ['z.ts', [6]]]);
  assert.deepEqual(result.pull_requests.map((source) => source.number), [1, 2, 4, 5, 6]);
  // d.ts comes from a direct commit without a PR and e.ts from unreviewed p3; neither is in the result, so both get a normal review.
  assert.ok(![...result.reviewed, ...result.composition.map((item) => item.path)].some((file) => ['d.ts', 'e.ts'].includes(file)));
});
