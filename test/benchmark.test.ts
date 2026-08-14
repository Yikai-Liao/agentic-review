import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBenchmarkCandidates, loadBenchmarkCorpus, scoreBenchmark } from '../src/benchmark.ts';
import { createRestrictedReadTools } from '../src/restricted-tools.ts';
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

test('Reviewer 读取工具拒绝绝对路径和符号链接逃逸', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentic-review-sandbox-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'expectations.json');
  await mkdir(path.join(allowed, '@..'), { recursive: true });
  await writeFile(path.join(allowed, 'safe.txt'), 'safe');
  await writeFile(path.join(allowed, '@..', 'expectations.json'), 'decoy');
  await writeFile(outside, 'secret');
  await symlink(outside, path.join(allowed, 'escape'));
  const read = (await createRestrictedReadTools(allowed, [allowed])).find(({ name }) => name === 'review_read')!;

  const result = await read.execute('safe', { path: 'safe.txt' }, undefined, undefined, undefined as never);
  assert.match(result.content[0]!.type === 'text' ? result.content[0]!.text : '', /safe/);
  await assert.rejects(() => read.execute('absolute', { path: outside }, undefined, undefined, undefined as never), /outside the review sandbox/);
  await assert.rejects(() => read.execute('at-prefix', { path: '@../expectations.json' }, undefined, undefined, undefined as never), /outside the review sandbox/);
  await assert.rejects(() => read.execute('symlink', { path: 'escape' }, undefined, undefined, undefined as never), /outside the review sandbox/);
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
