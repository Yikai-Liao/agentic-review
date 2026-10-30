import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeReviewInput } from '../scripts/write-review-input.ts';

test('oversized input exposes a short source pointer and preserves the original without paging', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-input-size-'));
  try {
    const file = path.join(directory, 'review-input.md');
    for (const content of [
      '文🙂'.repeat(100_000),
      'src/权限与资源.ts\n'.repeat(10_000),
    ]) {
      writeReviewInput(file, content);
      const index = readFileSync(file, 'utf8');
      assert.ok(Buffer.byteLength(index) < 1024);
      const sources = readdirSync(directory).filter(name => name !== path.basename(file));
      assert.equal(sources.length, 1);
      const source = path.join(directory, sources[0]);
      assert.ok(index.includes(source));
      assert.deepEqual(readFileSync(source), Buffer.from(content));
    }
    const small = 'a'.repeat(32 * 1024);
    writeReviewInput(file, small);
    assert.equal(readFileSync(file, 'utf8'), small);
    assert.equal(readdirSync(directory).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
