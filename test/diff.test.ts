import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDiffRange, collectDiffSideLines, collectRightSideLines } from '../src/diff.ts';

test('收集 diff 左右两侧可评论行', () => {
  const lines = collectDiffSideLines([
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
  assert.deepEqual([...lines.LEFT.get('src/a.ts') ?? []], [11]);
  assert.deepEqual([...lines.RIGHT.get('src/a.ts') ?? []], [11, 12]);
});

test('支持整文件删除的 LEFT-side 行并忽略 diff 元数据', () => {
  const lines = collectDiffSideLines([
    'diff --git a/src/deleted.ts b/src/deleted.ts',
    'deleted file mode 100644',
    '--- a/src/deleted.ts',
    '+++ /dev/null',
    '@@ -3,2 +0,0 @@',
    '-guard();',
    '-authorize();',
    '',
  ].join('\n'));
  assert.deepEqual([...lines.LEFT.get('src/deleted.ts') ?? []], [3, 4]);
  assert.deepEqual([...lines.RIGHT.get('src/deleted.ts') ?? []], []);
});

test('保留 RIGHT-side 收集兼容接口', () => {
  const lines = collectRightSideLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n'));
  assert.deepEqual([...lines.get('src/a.ts') ?? []], [1]);
});

test('Reviewer finding 必须使用规范化路径和完整指定 side 范围', () => {
  const changed = new Set(['src/a.ts']);
  const lines = {
    LEFT: new Map([['src/a.ts', new Set([9, 10])]]),
    RIGHT: new Map([['src/a.ts', new Set([10, 11])]]),
  };
  assert.doesNotThrow(() => assertDiffRange(changed, lines, 'src/a.ts', 'LEFT', 9, 10));
  assert.doesNotThrow(() => assertDiffRange(changed, lines, 'src/a.ts', 'RIGHT', 10, 11));
  assert.throws(() => assertDiffRange(changed, lines, 'src/a.ts', 'LEFT', 11, 10), /must not exceed/);
  assert.throws(() => assertDiffRange(changed, lines, '../src/a.ts', 'RIGHT', 10, 10), /not in the current diff/);
  assert.throws(() => assertDiffRange(changed, lines, 'src/a.ts', 'LEFT', 10, 11), /not on the LEFT side/);
});
