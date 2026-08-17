import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRestrictedReadTools } from '../src/restricted-tools.ts';

test('Reviewer read tools reject paths outside the review root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-review-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agentic-review-outside-'));
  await writeFile(`${root}/inside.txt`, 'inside');
  await writeFile(`${outside}/secret.txt`, 'secret');

  try {
    const tools = await createRestrictedReadTools(root, [root]);
    const read = tools.find(({ name }) => name === 'review_read')!;
    await assert.rejects(
      read.execute('test', { path: `${outside}/secret.txt` }, undefined as never, undefined as never, undefined as never),
      /outside the review sandbox/,
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true }),
      rm(outside, { recursive: true }),
    ]);
  }
});
