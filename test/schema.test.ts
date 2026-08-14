import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewerResult } from '../src/schema.ts';

test('接受完整 finding 并拒绝额外字段', () => {
  const finding = {
    category: 'authorization',
    path: 'src/service.ts',
    startLine: 12,
    endLine: 12,
    title: '删除了租户过滤条件',
    evidence: '查询条件不再包含 tenantId。',
    trigger: '租户 A 请求租户 B 的资源。',
    baseBehavior: '仅返回租户 A 的资源。',
    headBehavior: '返回所有租户的资源。',
    violatedConstraint: '租户数据必须隔离。',
    impact: '跨租户数据泄漏。',
    suggestedSeverity: 'P1' as const,
  };
  assert.equal(validateReviewerResult({ reviewer: 'production-semantics', findings: [finding] }).findings.length, 1);
  assert.throws(() => validateReviewerResult({ reviewer: 'production-semantics', findings: [{ ...finding, extra: true }] }));
});
