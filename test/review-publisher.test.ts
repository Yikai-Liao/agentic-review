import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { parse } from 'yaml';

const exec = promisify(execFile);

test('发布启动器只执行可信步骤输出，忽略本地脚本篡改；缺失、损坏及发布失败均失败', async t => {
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
