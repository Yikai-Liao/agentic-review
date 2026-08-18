import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadReviewAgents } from '../src/review-agents.ts';

const defaults = `overviewAgent: production-semantics
reviewAgents:
  - id: production-semantics
    required: true
  - id: test-quality
    required: false
`;

test('下游 base 配置完整覆盖中央默认并可配置 required 与指令', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-agents-'));
  const repositoryConfig = path.join(root, 'repository.yml');
  try {
    await mkdir(path.join(root, 'prompts'));
    await Promise.all(['production-semantics', 'test-quality', 'performance'].map((id) => writeFile(path.join(root, 'prompts', `${id}.md`), id)));
    await writeFile(path.join(root, '.agentic-review.yml'), defaults);

    assert.deepEqual(await loadReviewAgents(root), {
      overviewAgent: 'production-semantics',
      reviewAgents: [
        { id: 'production-semantics', required: true },
        { id: 'test-quality', required: false },
      ],
    });

    await writeFile(repositoryConfig, `overviewAgent: performance
reviewAgents:
  - id: performance
    required: true
    instructions: repository facts
  - id: test-quality
    required: false
`);
    await writeFile(path.join(root, '.agentic-review.yml'), 'invalid: candidate self-review must not read this\n');
    const configured = await loadReviewAgents(root, repositoryConfig);
    assert.equal(configured.overviewAgent, 'performance');
    assert.equal(configured.reviewAgents[0]!.instructions, 'repository facts');
    assert.equal(configured.reviewAgents[1]!.required, false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('拒绝未知、重复或非 required 的 overview Agent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-agents-invalid-'));
  try {
    await mkdir(path.join(root, 'prompts'));
    await writeFile(path.join(root, 'prompts', 'known.md'), 'known');
    await writeFile(path.join(root, 'prompts', 'aggregator.md'), 'not a Review Agent');

    await writeFile(path.join(root, '.agentic-review.yml'), 'overviewAgent: aggregator\nreviewAgents:\n  - id: aggregator\n    required: true\n');
    await assert.rejects(() => loadReviewAgents(root), /Unknown Review Agent/);

    await writeFile(path.join(root, '.agentic-review.yml'), 'overviewAgent: missing\nreviewAgents:\n  - id: missing\n    required: true\n');
    await assert.rejects(() => loadReviewAgents(root), /Unknown Review Agent/);

    await writeFile(path.join(root, '.agentic-review.yml'), 'overviewAgent: known\nreviewAgents:\n  - id: known\n    required: true\n  - id: known\n    required: false\n');
    await assert.rejects(() => loadReviewAgents(root), /Duplicate Review Agent/);

    await writeFile(path.join(root, '.agentic-review.yml'), 'overviewAgent: known\nreviewAgents:\n  - id: known\n    required: false\n');
    await assert.rejects(() => loadReviewAgents(root), /overviewAgent must be required/);
  } finally {
    await rm(root, { recursive: true });
  }
});
