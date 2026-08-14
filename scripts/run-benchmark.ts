import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createBenchmarkCandidates,
  loadBenchmarkCorpus,
  scoreBenchmark,
  type BenchmarkCandidate,
} from '../src/benchmark.ts';
import { prepareContext } from '../src/context.ts';
import { createReviewModel } from '../src/model.ts';
import { materializeBasePolicy } from '../src/policy.ts';
import { runBenchmarkJudge, runReviewerWithMetrics, type SessionMetrics } from '../src/session.ts';

const exec = promisify(execFile);
const engineRoot = path.resolve(import.meta.dirname, '..');
const workRoot = `${engineRoot}/.benchmark`;
await rm(workRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });

const corpus = await loadBenchmarkCorpus(process.env.BENCHMARK_CORPUS ?? `${engineRoot}/benchmark/corpus.json`);
const requestedIds = new Set((process.env.BENCHMARK_SAMPLE_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const samples = requestedIds.size ? corpus.samples.filter(({ id }) => requestedIds.has(id)) : corpus.samples;
if (samples.length !== (requestedIds.size || corpus.samples.length)) throw new Error('BENCHMARK_SAMPLE_IDS contains an unknown sample');

const thinking = parseThinking(process.env.REVIEW_AGENT_THINKING ?? 'high');
const { runtime, model } = await createReviewModel(`${workRoot}/runtime`);
const startedAt = performance.now();
const sampleResults = [];

for (const [index, sample] of samples.entries()) {
  console.error(`[${index + 1}/${samples.length}] ${sample.id}`);
  const repositoryPath = `${workRoot}/repositories/${sample.id}`;
  await checkout(repositoryPath, sample.repository, sample.baseSha, sample.headSha);
  const context = await prepareContext(repositoryPath, sample.baseSha, sample.headSha, `${workRoot}/contexts/${sample.id}`);
  await materializeBasePolicy(context.root, process.env.REVIEW_POLICY_ROOT ?? 'spec/review');

  const review = await runReviewerWithMetrics({
    cwd: repositoryPath,
    id: 'production-semantics',
    promptPath: `${engineRoot}/prompts/production-semantics.md`,
    modelRuntime: runtime,
    model,
    thinking,
    contextRoot: context.root,
  });
  const candidates = createBenchmarkCandidates(sample.expectations, review.result.findings).map(({ expectationIndex, findingIndex }) => ({
    expectationIndex,
    findingIndex,
    expectation: sample.expectations[expectationIndex]!,
    finding: review.result.findings[findingIndex]!,
  }));
  const judged = candidates.length
    ? await runBenchmarkJudge({
        cwd: workRoot,
        promptPath: `${engineRoot}/prompts/benchmark-judge.md`,
        modelRuntime: runtime,
        model,
        candidates,
      })
    : undefined;
  const accepted: BenchmarkCandidate[] = judged?.judgments.map(({ expectationIndex, findingIndex }) => ({ expectationIndex, findingIndex })) ?? [];
  sampleResults.push({
    id: sample.id,
    label: sample.label,
    repository: sample.repository,
    baseSha: sample.baseSha,
    headSha: sample.headSha,
    findings: review.result.findings,
    judgments: judged?.judgments ?? [],
    score: scoreBenchmark(sample.expectations.length, review.result.findings.length, accepted),
    sessions: {
      reviewer: review.metrics,
      judge: judged?.metrics,
    },
  });
}

const totals = sampleResults.reduce((sum, sample) => ({
  matchedExpectations: sum.matchedExpectations + sample.score.matchedExpectations,
  missedExpectations: sum.missedExpectations + sample.score.missedExpectations,
  unmatchedDefectFindings: sum.unmatchedDefectFindings + (sample.label === 'defect' ? sample.score.unmatchedFindings.length : 0),
  cleanFindings: sum.cleanFindings + (sample.label === 'clean' ? sample.findings.length : 0),
  cleanSamples: sum.cleanSamples + Number(sample.label === 'clean'),
  noisyCleanSamples: sum.noisyCleanSamples + Number(sample.label === 'clean' && sample.findings.length > 0),
}), { matchedExpectations: 0, missedExpectations: 0, unmatchedDefectFindings: 0, cleanFindings: 0, cleanSamples: 0, noisyCleanSamples: 0 });
const engineCommit = (await git(engineRoot, ['rev-parse', 'HEAD'])).trim();
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  engineCommit,
  engineDirty: Boolean((await git(engineRoot, ['status', '--porcelain'])).trim()),
  engineTreeHash: await treeHash(),
  corpusVersion: corpus.version,
  metricScope: 'matched/missed expectations are relative to the non-exhaustive manifest; unmatched defect findings require human adjudication; only clean-sample findings are false positives',
  model: model.id,
  thinking,
  durationMs: Math.round(performance.now() - startedAt),
  tokens: sumMetrics(sampleResults.flatMap(({ sessions }) => [sessions.reviewer, sessions.judge].filter((metric): metric is SessionMetrics => metric !== undefined))),
  totals: {
    matchedExpectations: totals.matchedExpectations,
    missedExpectations: totals.missedExpectations,
    manifestRecall: totals.matchedExpectations + totals.missedExpectations === 0 ? null : totals.matchedExpectations / (totals.matchedExpectations + totals.missedExpectations),
    unmatchedDefectFindings: totals.unmatchedDefectFindings,
    cleanFindings: totals.cleanFindings,
    cleanNoiseRate: totals.cleanSamples === 0 ? null : totals.noisyCleanSamples / totals.cleanSamples,
  },
  samples: sampleResults,
};
const output = `${workRoot}/report.json`;
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(output);

async function checkout(directory: string, repository: string, baseSha: string, headSha: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--quiet']);
  await git(directory, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
  await git(directory, ['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', baseSha, headSha]);
  await git(directory, ['checkout', '--quiet', '--detach', headSha]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

async function treeHash(): Promise<string> {
  const files = (await git(engineRoot, ['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0');
    try {
      hash.update('present\0').update(await readFile(path.join(engineRoot, file))).update('\0');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('deleted\0');
    }
  }
  return hash.digest('hex');
}

function parseThinking(value: string): 'low' | 'medium' | 'high' | 'xhigh' {
  if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'xhigh') throw new Error(`invalid REVIEW_AGENT_THINKING: ${value}`);
  return value;
}

function sumMetrics(metrics: SessionMetrics[]) {
  return metrics.reduce((sum, metric) => ({
    input: sum.input + metric.tokens.input,
    output: sum.output + metric.tokens.output,
    cacheRead: sum.cacheRead + metric.tokens.cacheRead,
    cacheWrite: sum.cacheWrite + metric.tokens.cacheWrite,
    total: sum.total + metric.tokens.total,
    reasoning: sum.reasoning + metric.reasoningTokens,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0 });
}
