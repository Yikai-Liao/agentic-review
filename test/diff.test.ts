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

test('不把 diff 元数据和结尾空行当作右侧代码', () => {
  const lines = collectRightSideLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -3,0 +4 @@',
    '+next',
    '',
  ].join('\n'));
  assert.deepEqual([...lines.get('src/a.ts') ?? []], [1]);
  assert.deepEqual([...lines.get('src/b.ts') ?? []], [4]);
});
