import { mkdir, writeFile } from 'node:fs/promises';
import { findingSchema, reviewerResultSchema } from '../src/schema.ts';

await mkdir('schemas', { recursive: true });
await Promise.all([
  writeFile('schemas/finding.schema.json', `${JSON.stringify(findingSchema, null, 2)}\n`),
  writeFile('schemas/reviewer-result.schema.json', `${JSON.stringify(reviewerResultSchema, null, 2)}\n`),
]);
