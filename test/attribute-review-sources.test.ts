import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { attributeReviewSources } from '../scripts/attribute-review-sources.ts';

test('按第一父步骤归因：已审来源、叠加内容与未审来源分别归为来源已审、叠加审查与普通审查', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'attribute-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  const write = (file: string, content: string) => writeFileSync(path.join(directory, file), content);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const lines = (...values: string[]) => `${values.join('\n')}\n`;
  for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'h.ts']) write(file, lines('1', '2', '3', '4', '5', '6', '7', '8', '9'));
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
  // p2 与 p1 修改 b.ts 的不同位置，自动合并后的内容是任何一个 head 都没有的组合。
  pull('p2', () => { write('b.ts', lines('1', '2', '3', '4', '5', '6', '7', '8', 'nine')); write('c.ts', lines('three', '2', '3', '4', '5', '6', '7', '8', '9')); });
  const p2 = merge('p2', 'merge p2');
  // p4 与 p5 修改 h.ts 的同一行并冲突，p5 合入时整体采用自己的版本：最终内容等于 p5 的 head，但丢弃了已合入的 p4 改动。
  pull('p4', () => write('h.ts', lines('from p4', '2', '3', '4', '5', '6', '7', '8', '9')));
  const p4 = merge('p4', 'merge p4');
  pull('p5', () => write('h.ts', lines('from p5', '2', '3', '4', '5', '6', '7', '8', '9')));
  git('merge', '--no-ff', '-q', '-X', 'theirs', '-m', 'merge p5', 'p5');
  const p5 = { head: git('rev-parse', 'p5'), merge: git('rev-parse', 'HEAD') };
  // p3 合入但没有通过审查。
  pull('p3', () => write('e.ts', lines('five', '2', '3', '4', '5', '6', '7', '8', '9')));
  const p3 = merge('p3', 'merge p3');
  // 直接提交没有来源 PR。
  write('d.ts', lines('four', '2', '3', '4', '5', '6', '7', '8', '9'));
  git('add', '.'); git('commit', '-qm', 'direct');
  const head = git('rev-parse', 'HEAD');

  const pullRequests = new Map([[p1.merge, { number: 1, head: p1.head }], [p2.merge, { number: 2, head: p2.head }], [p3.merge, { number: 3, head: p3.head }],
    [p4.merge, { number: 4, head: p4.head }], [p5.merge, { number: 5, head: p5.head }]]);
  const reviewedHeads = new Map([[p1.head, 1], [p2.head, 2], [p4.head, 4], [p5.head, 5]]);
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
          // 同一提交还被其他仍开放的 PR 引用，不能当作来源。
          { number: 99, title: '其他', url: 'https://github.com/owner/repo/pull/99', state: 'OPEN', headRefOid: found.head,
            mergeCommit: null, repository: { nameWithOwner: 'owner/repo' } },
        ] : [] } };
      } else {
        const number = reviewedHeads.get(oid);
        repository[entry] = { oid, checkSuites: { nodes: number ? [{ app: { slug: 'review-app' }, checkRuns: { nodes: [{
          name: 'Agentic Review / audit', status: 'COMPLETED', conclusion: 'SUCCESS',
          // 来源 PR 的 base 与当前 PR 不同。
          externalId: `1:${number}:${'f'.repeat(40)}:${oid}:automatic:10:1`,
        }] } }] : [] } };
      }
    }
    return new Response(JSON.stringify({ data: { repository } }));
  }) as unknown as typeof fetch;

  const result = await attributeReviewSources({
    targetPath: directory, repository: 'owner/repo', repositoryId: '1', mergeBase: base, headSha: head,
    appSlug: 'review-app', token: 'token', fetchImpl,
  });
  // a.ts 只由已审的 p1 改动；b.ts 经 p2 叠加后与任一 head 都不同；c.ts 与 p2 的 head 一致。
  // h.ts 的合入结果等于 p5 的 head，但覆盖了 p4 的改动，因此要叠加审查。
  assert.deepEqual(result.reviewed, ['a.ts', 'c.ts']);
  assert.deepEqual(result.composition.map((item) => [item.path, item.pull_requests.map((source) => source.number)]), [['b.ts', [2]], ['h.ts', [5]]]);
  assert.deepEqual(result.pull_requests.map((source) => source.number), [1, 2, 4, 5]);
  // d.ts 来自没有 PR 的直接提交，e.ts 来自未审的 p3，二者都不在结果中，按普通审查处理。
  assert.ok(![...result.reviewed, ...result.composition.map((item) => item.path)].some((file) => ['d.ts', 'e.ts'].includes(file)));
});
