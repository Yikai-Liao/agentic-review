import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBenchmarkCandidates, loadBenchmarkCorpus, scoreBenchmark, sealBenchmarkWorkspace } from '../src/benchmark.ts';
import type { Finding } from '../src/schema.ts';

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

test('对所有候选做一对一最大匹配并计算 manifest 指标', async () => {
  const expectation = (await loadBenchmarkCorpus(corpusPath)).samples[0]!.expectations[0]!;
  const expectations = [expectation, { ...expectation, startLine: expectation.endLine + 20, endLine: expectation.endLine + 20 }];
  const findings = [finding(expectation.path, expectation.startLine), finding('another/root-cause.ts', expectation.endLine + 30)];
  assert.equal(createBenchmarkCandidates(expectations, findings).length, 4);

  const score = scoreBenchmark(2, 2, [
    { expectationIndex: 0, findingIndex: 0 },
    { expectationIndex: 0, findingIndex: 1 },
    { expectationIndex: 1, findingIndex: 0 },
  ]);
  assert.deepEqual(score.matches, [
    { expectationIndex: 0, findingIndex: 1 },
    { expectationIndex: 1, findingIndex: 0 },
  ]);
  assert.equal(score.matchedExpectations, 2);
  assert.equal(score.missedExpectations, 0);
  assert.equal(score.manifestRecall, 1);
});

test('正式 benchmark 在 Reviewer 运行前移除本地答案', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentic-review-sealed-'));
  const corpus = path.join(root, 'benchmark/corpus.json');
  const unrelated = path.join(root, 'unrelated.json');
  await mkdir(path.dirname(corpus), { recursive: true });
  await mkdir(path.join(root, 'docs'));
  await mkdir(path.join(root, '.git'));
  await writeFile(corpus, 'answers');
  await writeFile(path.join(root, 'docs/baseline.md'), 'more answers');
  await writeFile(unrelated, 'keep');

  await sealBenchmarkWorkspace(root, corpus);
  await assert.rejects(() => access(path.join(root, 'benchmark')));
  await assert.rejects(() => access(path.join(root, 'docs')));
  await assert.rejects(() => access(path.join(root, '.git')));
  await access(unrelated);
  await assert.rejects(() => sealBenchmarkWorkspace(root, unrelated), /only the engine benchmark corpus/);
});

function finding(file: string, line: number): Finding {
  return {
    category: 'Code Defect',
    path: file,
    startLine: line,
    endLine: line,
    title: 'finding',
    evidence: 'evidence',
    trigger: 'trigger',
    baseBehavior: 'base',
    headBehavior: 'head',
    violatedConstraint: 'constraint',
    impact: 'impact',
    suggestedSeverity: 'P1',
  };
}
