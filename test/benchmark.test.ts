import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadBenchmarkCorpus } from '../src/benchmark.ts';

const corpusPath = path.resolve(import.meta.dirname, '../benchmark/corpus.json');

test('加载固定 benchmark corpus 并拒绝标签与 expectation 不一致', async () => {
  const corpus = await loadBenchmarkCorpus(corpusPath);
  assert.equal(corpus.samples.filter(({ label }) => label === 'defect').length, 5);
  assert.equal(corpus.samples.filter(({ label }) => label === 'clean').length, 1);
  assert.deepEqual(new Set(corpus.samples.filter(({ label }) => label === 'defect').map(({ language }) => language)), new Set(['TypeScript']));

  const invalid = structuredClone(corpus);
  invalid.samples[0]!.label = 'clean';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentic-review-benchmark-'));
  const file = path.join(directory, 'invalid.json');
  await writeFile(file, JSON.stringify(invalid));
  await assert.rejects(() => loadBenchmarkCorpus(file), /label does not match/);
});
