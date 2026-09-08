import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);

test('trusted request and publisher CLIs bind the snapshot and reject incomplete coverage before GitHub writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-pipeline-'));
  const writes: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.equal(request.url, '/repos/owner/repo/pulls/7/reviews');
    writes.push(JSON.parse(body));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ html_url: 'https://github.test/review/1' }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const target = path.join(directory, 'target');
    const workspace = path.join(directory, 'workspace');
    await mkdir(target);
    await mkdir(workspace);
    const git = (...args: string[]) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(path.join(target, 'auth.ts'), 'base');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(path.join(target, 'auth.ts'), 'head');
    git('add', '.'); git('commit', '-qm', 'head');
    const head = git('rev-parse', 'HEAD');
    const coveragePath = path.join(workspace, 'review-coverage.json');
    const outputPath = path.join(directory, 'outputs');
    const env = {
      ...process.env, REVIEW_TARGET_PATH: target, REVIEW_COVERAGE_PATH: coveragePath,
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '7', REVIEW_BASE_SHA: base, REVIEW_HEAD_SHA: head,
      REVIEW_TRIGGER_SOURCE: 'automatic', GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputPath,
      REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH: '', REVIEW_COMMENT_ID: '', REVIEW_COMMENT_ROOT_ID: '', REVIEW_COMMENT_BODY: '',
    };
    await exec(process.execPath, ['scripts/review-request.ts'], { env });
    const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => line.split('=')));
    assert.equal(outputs.comparison_start, base);
    const coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.deepEqual(coverage.ledger, [{ path: 'auth.ts', status: 'pending', batches: [] }]);
    coverage.scope = { id: '20:1:scope', kind: 'pr', mode: 'full', rationale: '完整审查', inherited_from_run: null,
      explicit_text: '', ranges: [{ targets: ['complete pull request'], comparison_start: base, comparison_end: head }], decided_at: coverage.updated_at };
    coverage.status = 'draft';
    // Agent 重写 JSON 时键顺序可以变化，身份校验应比较字段值。
    coverage.request = Object.fromEntries(Object.entries(coverage.request).reverse());
    await writeFile(coveragePath, JSON.stringify(coverage));
    const resultPath = path.join(workspace, 'review-result.json');
    await writeFile(resultPath, JSON.stringify({ body: '已审查鉴权变化。', scope_id: coverage.scope.id, comments: [], thread_updates: [], request_reply: null }));
    const publishEnv = { ...env, REPOSITORY: 'owner/repo', PULL_NUMBER: '7', BASE_SHA: base, HEAD_SHA: head,
      REVIEW_INVENTORY_DIGEST: outputs.inventory_digest, REVIEW_COMPARISON_START: outputs.comparison_start,
      REVIEW_RUN_ID: '20', REVIEW_RUN_ATTEMPT: '1', REVIEW_RESULT_PATH: resultPath, REVIEW_BOT_LOGIN: 'review-app[bot]',
      REVIEW_RUN_URL: 'https://github.test/run', REVIEW_WORKSPACE_URL: 'https://github.test/workspace', REVIEW_MODEL: 'test',
      GH_TOKEN: 'test-token', GITHUB_API_URL: `http://127.0.0.1:${address.port}` };
    const publish = () => exec(process.execPath, ['scripts/publish-review.ts'], { env: publishEnv });
    await assert.rejects(publish(), /Incomplete coverage/);
    assert.equal(writes.length, 0);
    coverage.ledger[0] = { path: 'auth.ts', status: 'complete', batches: ['auth'] };
    coverage.completed_batches = ['auth'];
    await mkdir(path.join(workspace, 'batches'));
    await writeFile(path.join(workspace, 'batches/auth.md'), '已核对鉴权调用方和失败路径。');
    await writeFile(coveragePath, JSON.stringify(coverage));
    await publish();
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { commit_id: string }).commit_id, head);
    const published = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.equal(published.status, 'published');
    assert.equal(published.complete_audit, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('trusted inventory includes reverted incremental files and intervals from repeated failures', async () => {
  const { buildReviewRequest, initialReviewCoverage, prepareDefaultReviewPlan, reviewInventory } = await import('../scripts/review-request.ts');
  const { inventoryDigest, validateCoverageCompletion } = await import('../scripts/review-coverage.ts');
  const directory = await mkdtemp(path.join(tmpdir(), 'review-reverted-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(path.join(directory, 'auth.ts'), 'base');
    git('add', '.'); git('commit', '-qm', 'base');
    const a = git('rev-parse', 'HEAD');
    await writeFile(path.join(directory, 'auth.ts'), 'changed');
    await writeFile(path.join(directory, 'payments.ts'), 'payments');
    git('add', '.'); git('commit', '-qm', 'first');
    const b = git('rev-parse', 'HEAD');
    await writeFile(path.join(directory, 'auth.ts'), 'base');
    git('add', '.'); git('commit', '-qm', 'revert auth');
    const c = git('rev-parse', 'HEAD');
    assert.equal(git('diff', '--name-only', a, c), 'payments.ts');
    const oldRequest = buildReviewRequest({ source: 'pr_comment', commentId: '1', rootCommentId: '1',
      repository: 'owner/repo', pullNumber: 7, baseSha: a, headSha: b, runId: '10' });
    const old = { ...initialReviewCoverage(oldRequest), status: 'draft',
      scope: { id: '10:1:scope', kind: 'pr', mode: 'focused', rationale: '只看鉴权', inherited_from_run: null,
        explicit_text: '只看鉴权', ranges: [{ targets: ['auth.ts'], comparison_start: a, comparison_end: b }],
        decided_at: oldRequest.requested_at } };
    const nextRequest = { ...oldRequest, head_sha: c };
    const publishedPlan = prepareDefaultReviewPlan(nextRequest, { ...old, status: 'published',
      scope: { ...old.scope, kind: 'pr', mode: 'focused' } }, () => true);
    assert.deepEqual(publishedPlan.ranges.map((range) => [range.comparison_start, range.comparison_end]), [[b, c]]);
    assert.deepEqual(reviewInventory(directory, nextRequest, publishedPlan), ['auth.ts', 'payments.ts']);
    const oldWorkspace = path.join(directory, 'previous');
    const workspace = path.join(directory, 'workspace');
    await mkdir(oldWorkspace);
    await mkdir(workspace);
    await writeFile(path.join(oldWorkspace, 'review-coverage.json'), JSON.stringify(old));
    const coveragePath = path.join(workspace, 'review-coverage.json');
    const outputPath = path.join(directory, 'outputs');
    const env = { ...process.env, REVIEW_TARGET_PATH: directory, REVIEW_COVERAGE_PATH: coveragePath,
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '7', REVIEW_BASE_SHA: a, REVIEW_HEAD_SHA: c,
      REVIEW_TRIGGER_SOURCE: 'pr_comment', REVIEW_COMMENT_ID: '2', REVIEW_COMMENT_ROOT_ID: '2', REVIEW_COMMENT_BODY: '',
      GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputPath,
      REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH: oldWorkspace, REVIEW_PREVIOUS_RUN_ID: '10',
      REVIEW_PREVIOUS_RUN_ATTEMPT: '1', REVIEW_PREVIOUS_SOURCE: 'pr_comment', REVIEW_PREVIOUS_PUBLISHED: 'false' };
    await exec(process.execPath, ['scripts/review-request.ts'], { env });
    const coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
    const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => line.split('=')));
    assert.deepEqual(coverage.ledger.map((entry: { path: string }) => entry.path), ['auth.ts', 'payments.ts']);
    assert.equal(outputs.inventory_digest, inventoryDigest(['auth.ts', 'payments.ts']));
    coverage.scope = { ...old.scope, id: '20:1:scope', mode: 'incremental', ranges: coverage.default_plan.ranges };
    coverage.status = 'draft';
    coverage.ledger[1].status = 'out_of_scope';
    await assert.rejects(validateCoverageCompletion(coverage, workspace, outputs.inventory_digest), /Incomplete coverage: auth.ts/);
    await assert.rejects(validateCoverageCompletion({ ...coverage, ledger: [coverage.ledger[1]] }, workspace, outputs.inventory_digest), /inventory/);
    // 第二轮保存实际范围后仍失败；第三轮必须继续携带 A→B 和 B→C。
    await writeFile(path.join(oldWorkspace, 'review-coverage.json'), JSON.stringify(coverage));
    await writeFile(path.join(directory, 'payments.ts'), 'new payments');
    git('add', 'payments.ts'); git('commit', '-qm', 'third');
    const d = git('rev-parse', 'HEAD');
    await exec(process.execPath, ['scripts/review-request.ts'], { env: { ...env,
      REVIEW_HEAD_SHA: d, GITHUB_RUN_ID: '30', REVIEW_PREVIOUS_RUN_ID: '20' } });
    const third = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.deepEqual(third.default_plan.ranges.map((range: { comparison_start: string; comparison_end: string }) =>
      [range.comparison_start, range.comparison_end]), [[a, b], [b, c], [c, d]]);
    assert.deepEqual(third.ledger.map((entry: { path: string }) => entry.path), ['auth.ts', 'payments.ts']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
