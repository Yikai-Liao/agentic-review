import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkoutReviewTarget, prepareReviewBase } from '../scripts/prepare-review-sources.ts';

test('base 共用已下载对象；缺少固定快照时补取，保持目标版本并禁止 checkout hook', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin');
  const target = path.join(directory, 'target');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '-q', origin]);
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  await writeFile(path.join(origin, 'file.ts'), 'base');
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  await writeFile(path.join(origin, 'file.ts'), 'head');
  git(origin, 'commit', '-qam', 'head');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  await checkoutReviewTarget(target, origin, baseSha, headSha);
  const marker = path.join(directory, 'hook-executed');
  await writeFile(path.join(target, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const base = path.join(directory, 'base');
  await prepareReviewBase(target, base, baseSha);
  assert.equal(await readFile(path.join(base, 'file.ts'), 'utf8'), 'base');
  assert.equal(git(target, 'rev-parse', 'HEAD'), headSha);
  assert.equal(git(base, 'rev-parse', '--git-common-dir'), path.join(target, '.git'));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });

  // 模拟取得 PR 快照后 base 分支推进，target 首次 fetch 未包含该对象。
  await writeFile(path.join(origin, 'file.ts'), 'new base');
  git(origin, 'commit', '-qam', 'new base');
  const newBaseSha = git(origin, 'rev-parse', 'HEAD');
  const newBase = path.join(directory, 'new-base');
  await prepareReviewBase(target, newBase, newBaseSha);
  assert.equal(await readFile(path.join(newBase, 'file.ts'), 'utf8'), 'new base');
  assert.equal(git(target, 'rev-parse', 'HEAD'), headSha);
  assert.equal(git(target, 'rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(git(target, 'remote', 'get-url', 'origin'), origin);
  assert.equal(git(target, 'config', '--get-all', 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assert.rejects(prepareReviewBase(target, path.join(directory, 'missing-base'), 'f'.repeat(40)));
});
