import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { parse } from 'yaml';
import { archiveReviewPublisher } from '../scripts/prepare-review-context.ts';

const exec = promisify(execFile);

test('A sparse partial clone still seals the checked-out publisher when the remote is unavailable, without fetching out-of-scope objects', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-publisher-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin');
  const control = path.join(directory, 'control');
  execFileSync('git', ['init', '-q', origin]);
  const git = (...args: string[]) => execFileSync('git', ['-C', origin, ...args], { stdio: 'pipe' });
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  git('config', 'uploadpack.allowFilter', 'true');
  await mkdir(path.join(origin, 'scripts'));
  await writeFile(path.join(origin, 'scripts/publish-review-run.ts'), 'export async function main() {}');
  await writeFile(path.join(origin, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(origin, '.agentic-review.md'), 'Out-of-scope material that publisher packaging must not download.');
  git('add', '.'); git('commit', '-qm', 'control');
  execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', `file://${origin}`, control]);
  execFileSync('git', ['-C', control, 'sparse-checkout', 'set', '--no-cone', '/scripts/', '/package.json']);
  execFileSync('git', ['-C', control, 'checkout', '--quiet', 'HEAD']);
  await assert.rejects(readFile(path.join(control, '.agentic-review.md')), { code: 'ENOENT' });
  execFileSync('git', ['-C', control, 'remote', 'set-url', 'origin', path.join(directory, 'unavailable')]);

  const archive = Buffer.from(await archiveReviewPublisher(control), 'base64');
  assert.equal(execFileSync('tar', ['-xzOf', '-', 'scripts/publish-review-run.ts'], { input: archive, encoding: 'utf8' }),
    'export async function main() {}');
  assert.equal(execFileSync('tar', ['-xzOf', '-', 'package.json'], { input: archive, encoding: 'utf8' }), '{"type":"module"}');
});

test('The publication launcher runs only trusted step output and ignores local script tampering; missing, corrupt, and failed publication all fail', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-publisher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const workspace = path.join(directory, 'workspace');
  const temporary = path.join(directory, 'temporary');
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await mkdir(temporary);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(source, 'scripts/value.ts'), 'export const value: string = "trusted fixed ref";');
  await writeFile(path.join(source, 'scripts/publish-review-run.ts'), `
import { writeFileSync } from 'node:fs';
import { value } from './value.ts';
export async function main() {
  writeFileSync(process.env.MARKER!, value);
  if (process.env.FAIL_PUBLICATION === 'true') process.exitCode = 1;
}
`);
  const archive = execFileSync('tar', ['-czf', '-', '-C', source, 'scripts', 'package.json']).toString('base64');
  for (const name of ['control', 'publisher']) {
    await mkdir(path.join(workspace, name, 'scripts'), { recursive: true });
    await writeFile(path.join(workspace, name, 'scripts/publish-review-run.ts'), 'throw new Error("tampered local code");');
  }
  const workflow = parse(await readFile(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  const script = workflow.jobs.review.steps.find((step: { id?: string }) => step.id === 'publish-review').with.script;
  const marker = path.join(directory, 'executed');
  const invoke = (payload: string | undefined, extra: Record<string, string> = {}) => exec(process.execPath, [
    '-e', `(async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });`,
  ], { cwd: workspace, env: { ...process.env, RUNNER_TEMP: temporary, REVIEW_PUBLISHER_ARCHIVE: payload, MARKER: marker, ...extra } });

  await invoke(archive);
  assert.equal(await readFile(marker, 'utf8'), 'trusted fixed ref');
  for (const payload of [undefined, '', 'broken archive']) {
    await rm(marker, { force: true });
    await assert.rejects(invoke(payload));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
  await assert.rejects(invoke(archive, { FAIL_PUBLICATION: 'true' }));
  assert.equal(await readFile(marker, 'utf8'), 'trusted fixed ref');
});
