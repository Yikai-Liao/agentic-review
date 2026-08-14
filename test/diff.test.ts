import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRightSideLines } from '../src/diff.ts';

test('只收集 diff 右侧可评论行', () => {
  const lines = collectRightSideLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,4 @@',
    ' context',
    '-removed',
    '+added',
    '+another',
    ' tail',
  ].join('\n'));
  assert.deepEqual([...lines.get('src/a.ts') ?? []], [10, 11, 12, 13]);
  assert.equal(lines.get('src/a.ts')?.has(14), false);
});
