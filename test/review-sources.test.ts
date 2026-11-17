import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkoutReviewTarget, prepareReviewBase } from '../scripts/prepare-review-sources.ts';
import { runGh, type Run } from '../scripts/refresh-review-discussion.ts';

test('After merge and source branch deletion, checkout still uses the original PR snapshot, not the merge commit or latest branch', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-merged-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  await writeFile(path.join(origin, 'file.ts'), 'base\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-qb', 'feature');
  await writeFile(path.join(origin, 'file.ts'), 'PR head\n');
  git(origin, 'commit', '-qam', 'feature');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  // GitHub keeps PR refs; deleting the source branch does not delete the PR's commits.
  git(origin, 'update-ref', 'refs/pull/7/head', headSha);
  git(origin, 'checkout', '-q', 'main');
  git(origin, 'merge', '--squash', 'feature'); git(origin, 'commit', '-qm', 'squash merge');
  const mergeSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'branch', '-D', 'feature');
  await writeFile(path.join(origin, 'file.ts'), 'later change\n');
  git(origin, 'commit', '-qam', 'later change');
  assert.throws(() => git(origin, 'show-ref', '--verify', 'refs/heads/feature'));

  const target = path.join(directory, 'target');
  const base = path.join(directory, 'base');
  await checkoutReviewTarget(target, origin, baseSha, headSha);
  await prepareReviewBase(target, base, baseSha);
  assert.equal(git(target, 'rev-parse', 'HEAD'), headSha);
  assert.notEqual(headSha, mergeSha);
  assert.equal(await readFile(path.join(target, 'file.ts'), 'utf8'), 'PR head\n');
  assert.equal(await readFile(path.join(base, 'file.ts'), 'utf8'), 'base\n');
  assert.equal(git(target, 'merge-base', baseSha, headSha), baseSha);
  assert.equal(git(target, 'diff', '--name-only', `${baseSha}...${headSha}`), 'file.ts');
});

for (const side of ['head', 'base'] as const) test(`When only ${side} contains private LFS files, pointers are kept and no object download starts`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-lfs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin');
  execFileSync('git', ['init', '-q', origin]);
  const git = (...args: string[]) => execFileSync('git', ['-C', origin,
    '-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false',
    ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 42\n`;
  await writeFile(path.join(origin, '.gitattributes'), '*.bin filter=lfs diff=lfs -text\n');
  await writeFile(path.join(origin, 'source.ts'), 'base');
  if (side === 'base') await writeFile(path.join(origin, 'asset.bin'), pointer);
  git('add', '.'); git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  await writeFile(path.join(origin, 'source.ts'), 'head');
  if (side === 'head') await writeFile(path.join(origin, 'asset.bin'), pointer);
  else await rm(path.join(origin, 'asset.bin'));
  git('add', '.'); git('commit', '-qm', 'head');
  const headSha = git('rev-parse', 'HEAD');

  // Simulate the runner's system-level required LFS filter; any invocation is recorded and the download refused.
  const marker = path.join(directory, 'lfs-started');
  const filter = path.join(directory, 'lfs-filter');
  await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const run: Run = (command, args) => runGh(command, [
    '-c', `filter.lfs.process=${filter}`, '-c', `filter.lfs.smudge=${filter}`, '-c', 'filter.lfs.required=true', ...args,
  ]);
  const target = path.join(directory, 'target');
  const base = path.join(directory, 'base');
  await checkoutReviewTarget(target, origin, baseSha, headSha, run);
  await prepareReviewBase(target, base, baseSha, run);
  assert.equal(await readFile(path.join(target, 'source.ts'), 'utf8'), 'head');
  assert.equal(await readFile(path.join(base, 'source.ts'), 'utf8'), 'base');
  const pointerTree = side === 'head' ? target : base;
  assert.equal(await readFile(path.join(pointerTree, 'asset.bin'), 'utf8'), pointer);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });

  // A control checkout does trigger the filter, so an inactive configuration is not mistaken for protection.
  await rm(path.join(pointerTree, 'asset.bin'));
  await assert.rejects(run('git', ['-C', pointerTree, 'checkout', '--', 'asset.bin']));
  await readFile(marker);
});

test('base reuses downloaded objects; a missing pinned snapshot is fetched, the target version is kept, and checkout hooks are disabled', async t => {
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

  // Simulate the base branch advancing after the PR snapshot, so the first target fetch lacks the object.
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
