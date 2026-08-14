import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import type { Finding } from './schema.ts';

const sha = Type.String({ pattern: '^[0-9a-f]{40}$' });

const benchmarkSourceSchema = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9@.-]*$' }),
  repository: Type.String({ pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' }),
  commit: sha,
  path: Type.String({ minLength: 1 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  license: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const expectationSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  side: Type.Literal('right'),
  category: Type.Union([Type.Literal('Code Defect'), Type.Literal('Security')]),
  origin: Type.Union([Type.Literal('human'), Type.Literal('ai')]),
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const benchmarkSampleSchema = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
  source: Type.String({ minLength: 1 }),
  label: Type.Union([Type.Literal('defect'), Type.Literal('clean')]),
  language: Type.String({ minLength: 1 }),
  repository: Type.String({ pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' }),
  pullRequestUrl: Type.String({ minLength: 1 }),
  baseSha: sha,
  headSha: sha,
  changeLineCount: Type.Integer({ minimum: 1 }),
  expectations: Type.Array(expectationSchema),
}, { additionalProperties: false });

export const benchmarkCorpusSchema = Type.Object({
  version: Type.Literal(1),
  sources: Type.Array(benchmarkSourceSchema, { minItems: 1 }),
  samples: Type.Array(benchmarkSampleSchema, { minItems: 1 }),
}, { additionalProperties: false });

export type BenchmarkCorpus = Static<typeof benchmarkCorpusSchema>;
export type BenchmarkExpectation = BenchmarkCorpus['samples'][number]['expectations'][number];
export type BenchmarkCandidate = { expectationIndex: number; findingIndex: number };
export type BenchmarkScore = {
  matchedExpectations: number;
  missedExpectations: number;
  manifestRecall: number | null;
  matches: BenchmarkCandidate[];
  unmatchedExpectations: number[];
  unmatchedFindings: number[];
};
const validator = Compile(benchmarkCorpusSchema);

export async function sealBenchmarkWorkspace(engineRoot: string, corpusFile: string): Promise<void> {
  const root = path.resolve(engineRoot);
  if (path.resolve(corpusFile) !== path.join(root, 'benchmark/corpus.json')) {
    throw new Error('only the engine benchmark corpus can be sealed');
  }
  await Promise.all([
    rm(path.join(root, 'benchmark'), { recursive: true }),
    rm(path.join(root, 'docs'), { recursive: true, force: true }),
    rm(path.join(root, '.git'), { recursive: true, force: true }),
  ]);
}

export async function loadBenchmarkCorpus(file: string): Promise<BenchmarkCorpus> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!validator.Check(value)) {
    throw new Error(`Invalid benchmark corpus: ${JSON.stringify(validator.Errors(value))}`);
  }

  const sourceIds = unique(value.sources.map(({ id }) => id), 'source');
  unique(value.samples.map(({ id }) => id), 'sample');
  for (const sample of value.samples) {
    if (!sourceIds.has(sample.source)) throw new Error(`Unknown benchmark source: ${sample.source}`);
    if (sample.baseSha === sample.headSha) throw new Error(`Benchmark sample has no diff: ${sample.id}`);
    if ((sample.label === 'clean') !== (sample.expectations.length === 0)) {
      throw new Error(`Benchmark label does not match expectations: ${sample.id}`);
    }
    for (const expectation of sample.expectations) {
      if (expectation.startLine > expectation.endLine) throw new Error(`Invalid expectation range: ${sample.id}`);
      const normalized = path.posix.normalize(expectation.path);
      if (normalized !== expectation.path || path.posix.isAbsolute(normalized) || normalized.startsWith('../')) {
        throw new Error(`Invalid expectation path: ${sample.id}`);
      }
    }
  }
  return value;
}

export function createBenchmarkCandidates(expectations: BenchmarkExpectation[], findings: Finding[]): BenchmarkCandidate[] {
  return expectations.flatMap((_expectation, expectationIndex) => findings.map((_finding, findingIndex) => ({ expectationIndex, findingIndex })));
}

export function scoreBenchmark(expectationCount: number, findingCount: number, accepted: BenchmarkCandidate[]): BenchmarkScore {
  const edges = new Map<number, number[]>();
  for (const { expectationIndex, findingIndex } of accepted) {
    if (expectationIndex < 0 || expectationIndex >= expectationCount || findingIndex < 0 || findingIndex >= findingCount) {
      throw new Error('Benchmark judgment index is out of bounds');
    }
    const findings = edges.get(expectationIndex) ?? [];
    if (!findings.includes(findingIndex)) findings.push(findingIndex);
    edges.set(expectationIndex, findings.sort((a, b) => a - b));
  }

  const findingToExpectation = new Map<number, number>();
  function assign(expectationIndex: number, seen: Set<number>): boolean {
    for (const findingIndex of edges.get(expectationIndex) ?? []) {
      if (seen.has(findingIndex)) continue;
      seen.add(findingIndex);
      const previous = findingToExpectation.get(findingIndex);
      if (previous === undefined || assign(previous, seen)) {
        findingToExpectation.set(findingIndex, expectationIndex);
        return true;
      }
    }
    return false;
  }
  for (let expectationIndex = 0; expectationIndex < expectationCount; expectationIndex += 1) {
    assign(expectationIndex, new Set());
  }

  const matches = [...findingToExpectation]
    .map(([findingIndex, expectationIndex]) => ({ expectationIndex, findingIndex }))
    .sort((a, b) => a.expectationIndex - b.expectationIndex || a.findingIndex - b.findingIndex);
  const matchedExpectations = new Set(matches.map(({ expectationIndex }) => expectationIndex));
  const matchedFindings = new Set(matches.map(({ findingIndex }) => findingIndex));
  const unmatchedExpectations = Array.from({ length: expectationCount }, (_, index) => index).filter((index) => !matchedExpectations.has(index));
  const unmatchedFindings = Array.from({ length: findingCount }, (_, index) => index).filter((index) => !matchedFindings.has(index));
  const matchedExpectationsCount = matches.length;
  const missedExpectations = unmatchedExpectations.length;
  return {
    matchedExpectations: matchedExpectationsCount,
    missedExpectations,
    manifestRecall: matchedExpectationsCount + missedExpectations === 0 ? null : matchedExpectationsCount / (matchedExpectationsCount + missedExpectations),
    matches,
    unmatchedExpectations,
    unmatchedFindings,
  };
}

function unique(values: string[], kind: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`Duplicate benchmark ${kind} id`);
  return result;
}
