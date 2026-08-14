import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeBasePolicy } from '../src/policy.ts';

test('只从 base 快照复制仓库规则并阻止路径逃逸', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentic-review-'));
  await mkdir(path.join(root, 'base/spec/review'), { recursive: true });
  await writeFile(path.join(root, 'base/spec/review/project.md'), 'base policy');
  await materializeBasePolicy(root, 'spec/review');
  assert.equal(await readFile(path.join(root, 'policy/project.md'), 'utf8'), 'base policy');
  await assert.rejects(() => materializeBasePolicy(root, '../secrets'));
});
