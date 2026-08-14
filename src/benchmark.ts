import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';

const sha = Type.String({ pattern: '^[0-9a-f]{40}$' });

const benchmarkSourceSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  repository: Type.String({ pattern: '^[^/]+/[^/]+$' }),
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
  id: Type.String({ minLength: 1 }),
  source: Type.String({ minLength: 1 }),
  label: Type.Union([Type.Literal('defect'), Type.Literal('clean')]),
  language: Type.String({ minLength: 1 }),
  repository: Type.String({ pattern: '^[^/]+/[^/]+$' }),
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
const validator = Compile(benchmarkCorpusSchema);

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

function unique(values: string[], kind: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`Duplicate benchmark ${kind} id`);
  return result;
}
