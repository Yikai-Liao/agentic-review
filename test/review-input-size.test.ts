import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
      assert.ok(index.includes(`${file}.full.md`));
      assert.ok(index.includes('分段读取'));
      assert.deepEqual(readFileSync(`${file}.full.md`), Buffer.from(content));
      assert.deepEqual(readdirSync(directory).sort(), ['review-input.md', 'review-input.md.full.md']);
    }
    const small = 'a'.repeat(32 * 1024);
    writeReviewInput(file, small);
    assert.equal(readFileSync(file, 'utf8'), small);
    assert.equal(existsSync(`${file}.full.md`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
