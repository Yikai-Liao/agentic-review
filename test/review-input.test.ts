import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/prepare-review-input.ts';
import { buildReviewRequest, initialReviewCoverage } from '../scripts/review-request.ts';

test('prepared input captures discussion baseline and project rules without generating diffs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-input-'));
  const originalEnv = { ...process.env };
  try {
    const base = path.join(directory, 'base');
    const head = path.join(directory, 'head');
    mkdirSync(base);
    mkdirSync(head);
    Object.assign(process.env, {
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '60',
      REVIEW_TARGET_PATH: head, REVIEW_BASE_PATH: base,
      REVIEW_WORKSPACE_PATH: directory,
      REVIEW_CONTEXT_PATH: path.join(directory, 'review-context.json'),
      REVIEW_INPUT_PATH: path.join(directory, 'input.md'),
      REVIEW_ASSOCIATIONS_PATH: path.join(directory, 'associations.json'),
    });
    const associations = {
      pull_requests: [{ repository: 'owner/repo', number: 59, title: '源 PR', url: 'https://github.com/owner/repo/pull/59' }],
      issues: [],
    };
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify(associations));
    writeFileSync(path.join(base, '.agentic-review.md'), '默认按 code 层审查。');
    writeFileSync(path.join(head, '.agentic-review.md'), '设计文档按 architecture 层审查。');
    writeFileSync(path.join(head, 'AGENTS.md'), '项目约束：开发计划按 plan 层审查。');
    writeFileSync(process.env.REVIEW_CONTEXT_PATH!, JSON.stringify({ request: { text: '只看鉴权' } }));
    writeFileSync(path.join(directory, 'review-progress.json'), JSON.stringify({ ledger: [] }));
    const run = (command: string, args: string[]) => {
      assert.equal(command, 'gh');
      if (args.includes('graphql')) return JSON.stringify([{ data: { repository: { pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } } }]);
      return args.includes('view') ? '{"title":"测试 PR"}' : '[[{"id":1,"body":"明确决定"}]]';
    };
    main(run);
    const input = readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8');
    assert.ok(input.includes('测试 PR'));
    assert.ok(input.includes('## Review request'));
    const index = input.split('## PR association index\n\n')[1].split('\n\n## ')[0];
    assert.deepEqual(JSON.parse(index), associations);
    assert.ok(input.includes('只看鉴权'));
    assert.ok(input.includes('项目约束'));
    assert.ok(input.includes('## Base .agentic-review.md\n\n默认按 code 层审查。'));
    assert.ok(input.includes('## Head .agentic-review.md\n\n设计文档按 architecture 层审查。'));
    assert.ok(input.includes('## Head AGENTS.md\n\n项目约束：开发计划按 plan 层审查。'));
    assert.ok(input.includes('明确决定'));
    assert.ok(input.includes('Workspace resume manifest'));
    assert.ok(input.includes(path.join(directory, 'review-progress.json')));
    const notes = readFileSync(path.join(directory, 'notes.md'), 'utf8');
    assert.ok(!notes.includes('只看鉴权'));
    assert.ok(notes.includes('$REVIEW_CONTEXT_PATH'));
    assert.ok(notes.includes('central/review-rules.md'));
    assert.ok(notes.includes(path.join(directory, 'review-progress.json')));
    const assertInitialNotes = (source: string, instruction = '') => {
      const facts = source.match(/```json\n([\s\S]*?)\n```/);
      assert.ok(facts);
      assert.deepEqual(JSON.parse(facts[1]), { request: {}, context_path: '$REVIEW_CONTEXT_PATH',
        rules_path: fileURLToPath(new URL('../central/review-rules.md', import.meta.url)), progress_path: path.join(directory, 'review-progress.json') });
      // 只排除本用例明确提供的说明，不能把任意 Markdown 引用中的完成结论一并抹掉。
      const scaffold = source.replace(facts[0], '').replace(instruction, '');
      assert.match(scaffold, /^# Review 调查索引\s+## 调查记录\s*$/);
    };
    assertInitialNotes(notes);
    const instruction = '> complete 表示完成状态；调查后才能写“未发现问题”。';
    assert.doesNotThrow(() => assertInitialNotes(notes.replace('## 调查记录',
      `${instruction}\n\n## 调查记录`), instruction));
    for (const premature of ['- B1：complete', '结论：未发现问题。', '> - B1：complete', '> 结论：未发现问题。']) {
      assert.throws(() => assertInitialNotes(`${notes}\n${premature}\n`));
      assert.throws(() => assertInitialNotes(`${premature}\n${notes}`));
      assert.throws(() => assertInitialNotes(notes.replace('## 调查记录', `${premature}\n\n## 调查记录`)));
    }
    const baseline = JSON.parse(readFileSync(path.join(directory, 'discussion-baseline.json'), 'utf8'));
    assert.equal(baseline.repository, 'owner/repo');
    assert.ok(baseline.fingerprints.inline_comments['1']);
    assert.throws(() => main(() => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify({ pull_requests: [], issues: [] }));
    main(run);
    assert.ok(readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8').includes('"pull_requests": []'));
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, 'invalid json');
    assert.throws(() => main(run), SyntaxError);
    rmSync(process.env.REVIEW_ASSOCIATIONS_PATH!);
    assert.throws(() => main(run), /ENOENT/);

    // 大讨论先变成短索引；完整记录仍在原文文件中，不能无界内联给 Agent。
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify(associations));
    const largeDecision = '明确决定：保持原范围。🙂'.repeat(6000);
    main((command, args) => args.includes('view') || args.includes('graphql')
      ? run(command, args)
      : JSON.stringify([[{ id: 1, body: largeDecision }]]));
    const inputIndex = readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8');
    const source = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(directory, entry.name))
      .find(file => file !== process.env.REVIEW_INPUT_PATH && inputIndex.includes(file));
    assert.ok(source, 'large input must identify its complete source');
    const completeInput = readFileSync(source, 'utf8');
    assert.ok(completeInput.includes(largeDecision));
    assert.ok(completeInput.includes('## Head AGENTS.md'));
    assert.ok(completeInput.includes('Workspace resume manifest'));

    // 用真实 Git 验证枚举结果，不固定等价实现的参数与输出形状。
    const git = (...args: string[]) => execFileSync('git', ['-C', head, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('add', '.'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    writeFileSync(path.join(head, '旧文件.ts'), '旧内容');
    git('add', '.'); git('commit', '-qm', 'old head');
    const oldHead = git('rev-parse', 'HEAD');
    rmSync(path.join(head, '旧文件.ts'));
    writeFileSync(path.join(head, '含\n换行.ts'), '新内容');
    git('add', '.'); git('commit', '-qm', 'new head');
    const newHead = git('rev-parse', 'HEAD');
    const previous = path.join(directory, 'previous');
    mkdirSync(previous);
    const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 60,
      baseSha, headSha: oldHead, runId: '10' });
    writeFileSync(path.join(previous, 'review-coverage.json'), JSON.stringify(initialReviewCoverage(request)));
    writeFileSync(process.env.REVIEW_CONTEXT_PATH!, JSON.stringify({ request: { ...request, head_sha: newHead, run_id: '11' } }));
    writeFileSync(process.env.REVIEW_ASSOCIATIONS_PATH!, JSON.stringify(associations));
    process.env.REVIEW_PREVIOUS_WORKSPACE_PATH = previous;
    const withGit = (command: string, args: string[]) => command === 'git'
      ? execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' }) : run(command, args);
    main(withGit);
    const manifestPath = path.join(directory, 'resume-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.changed_paths.sort(), ['旧文件.ts', '含\n换行.ts'].sort());

    // 历史 head 不在当前 clone 中时，摘要保持未知，完整输入和进度仍可准备。
    const unavailable = initialReviewCoverage({ ...request, head_sha: 'f'.repeat(40) });
    unavailable.scope = { kind: 'pr', mode: 'full', rationale: '完整审查', explicit_text: '',
      ranges: [{ targets: ['complete pull request'], comparison_start: baseSha, comparison_end: unavailable.request.head_sha }] };
    unavailable.status = 'published';
    unavailable.ledger = [{ path: '含\n换行.ts', status: 'complete', batches: ['B1'] }];
    unavailable.completed_batches = ['B1'];
    mkdirSync(path.join(previous, 'batches'));
    writeFileSync(path.join(previous, 'batches/B1.md'), '上轮完整证据');
    writeFileSync(path.join(previous, 'review-coverage.json'), JSON.stringify(unavailable));
    writeFileSync(path.join(previous, 'review-result.json'), JSON.stringify({
      body: '未发现问题。', comments: [], thread_updates: [], request_reply: null,
    }));
    writeFileSync(path.join(directory, 'review-progress.json'), JSON.stringify({
      ledger: [{ path: '含\n换行.ts', status: 'pending', batches: [] }],
    }));
    main(withGit);
    const unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(unknown.changed_paths, null);
    assert.deepEqual(unknown.pending_files, ['含\n换行.ts']);
    const ledger = JSON.parse(readFileSync(path.join(directory, 'review-progress.json'), 'utf8')).ledger;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].path, '含\n换行.ts');
    assert.equal(ledger[0].status, 'pending');
    assert.ok(readFileSync(process.env.REVIEW_INPUT_PATH!, 'utf8').includes('测试 PR'));

  } finally {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
