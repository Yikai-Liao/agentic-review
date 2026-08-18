import assert from 'node:assert/strict';
import test from 'node:test';
import type { Finding } from '../src/schema.ts';
import { validateAggregation, type AggregationFinding } from '../src/session.ts';

const finding: Finding = {
  category: 'authorization',
  path: 'src/a.ts',
  side: 'RIGHT',
  startLine: 10,
  endLine: 12,
  title: '租户过滤被移除',
  evidence: '查询不再使用 tenantId。',
  trigger: '租户 A 查询资源。',
  baseBehavior: '只查询租户 A。',
  headBehavior: '查询所有租户。',
  violatedConstraint: '租户数据必须隔离。',
  impact: '跨租户数据泄漏。',
  suggestedSeverity: 'P1',
};

const inputs: AggregationFinding[] = [
  { id: 'production-semantics:0', reviewer: 'production-semantics', finding },
  { id: 'test-quality:0', reviewer: 'test-quality', finding: { ...finding, startLine: 11, title: '同一租户过滤根因' } },
];

test('Aggregator 必须完整分组且只能合并同 side、等级和重叠位置', () => {
  assert.doesNotThrow(() => validateAggregation([['production-semantics:0', 'test-quality:0']], inputs));
  assert.throws(() => validateAggregation([['production-semantics:0']], inputs), /partition every finding/);
  assert.throws(() => validateAggregation([['production-semantics:0'], ['production-semantics:0']], inputs), /partition every finding/);
  const many = Array.from({ length: 31 }, (_, index) => ({
    id: `reviewer:${index}`,
    reviewer: 'reviewer',
    finding: { ...finding, path: `src/${index}.ts` },
  }));
  assert.doesNotThrow(() => validateAggregation(many.map(({ id }) => [id]), many));
  for (const changed of [
    { path: 'src/b.ts' },
    { suggestedSeverity: 'P2' as const },
    { startLine: 20, endLine: 20 },
    { side: 'LEFT' as const },
  ]) {
    assert.throws(() => validateAggregation([['production-semantics:0', 'test-quality:0']], [
      inputs[0]!,
      { ...inputs[1]!, finding: { ...inputs[1]!.finding, ...changed } },
    ]), /share path, side, and severity|overlapping locations/);
  }

  const large = {
    ...finding,
    evidence: 'e'.repeat(5000),
    trigger: 't'.repeat(3000),
    baseBehavior: 'b'.repeat(3000),
    headBehavior: 'h'.repeat(3000),
    violatedConstraint: 'c'.repeat(3000),
    impact: 'i'.repeat(3000),
  };
  assert.throws(() => validateAggregation([['a', 'b']], [
    { id: 'a', reviewer: 'a', finding: large },
    { id: 'b', reviewer: 'b', finding: { ...large, evidence: `different${large.evidence}` } },
  ]), /comment budget/);
});
