import path from 'node:path';
import { loadBenchmarkCorpus } from '../src/benchmark.ts';
import { collectRightSideLines } from '../src/diff.ts';

const corpus = await loadBenchmarkCorpus(path.resolve(import.meta.dirname, '../benchmark/corpus.json'));
const headers: Record<string, string> = {
  Accept: 'application/vnd.github.v3.diff',
  'X-GitHub-Api-Version': '2022-11-28',
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

for (const sample of corpus.samples) {
  const response = await fetch(
    `https://api.github.com/repos/${sample.repository}/compare/${sample.baseSha}...${sample.headSha}`,
    { headers },
  );
  if (!response.ok) throw new Error(`Cannot fetch ${sample.id}: ${response.status} ${await response.text()}`);
  const lines = collectRightSideLines(await response.text());
  for (const expectation of sample.expectations) {
    for (let line = expectation.startLine; line <= expectation.endLine; line += 1) {
      if (!lines.get(expectation.path)?.has(line)) {
        throw new Error(`Expectation is not on the RIGHT diff: ${sample.id} ${expectation.path}:${line}`);
      }
    }
  }
  console.log(`verified ${sample.id}`);
}
