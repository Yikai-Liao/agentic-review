import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);

for (const source of ['automatic', 'pr_comment'] as const) {
test(`${source}: model progress cannot rewrite request identity and publication still rejects incomplete coverage`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-pipeline-'));
  const writes: unknown[] = [];
  let failReview = false;
  let failCoveragePath: string | undefined;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method === 'GET' && request.url?.startsWith('/repos/owner/repo/pulls/7/reviews?')) {
      response.setHeader('Content-Type', 'application/json');
      response.end('[]');
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/repos/owner/repo/pulls/7/comments?')) {
      response.setHeader('Content-Type', 'application/json'); response.end('[]'); return;
    }
    if (request.method === 'POST' && request.url === '/repos/owner/repo/pulls/7/comments') {
      const finding = JSON.parse(body);
      writes.push(finding);
      response.setHeader('Content-Type', 'application/json');
      response.statusCode = finding.line === 1 ? 422 : 201;
      response.end(JSON.stringify(finding.line === 1 ? { message: 'invalid diff line' } : { html_url: 'https://github.test/finding' }));
      return;
    }
    assert.equal(request.url, '/repos/owner/repo/pulls/7/reviews');
    writes.push(JSON.parse(body));
    response.setHeader('Content-Type', 'application/json');
    if (failCoveragePath) {
      await rm(failCoveragePath);
      await mkdir(failCoveragePath);
    }
    response.statusCode = failReview ? 503 : 201;
    response.end(JSON.stringify(failReview ? { message: 'review unavailable' } : { html_url: 'https://github.test/review/1' }));
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
    const contextPath = path.join(directory, 'context', 'review-context.json');
    const progressPath = path.join(workspace, 'review-progress.json');
    const coveragePath = path.join(workspace, 'review-coverage.json');
    const outputPath = path.join(directory, 'outputs');
    const env = {
      ...process.env, REVIEW_TARGET_PATH: target, REVIEW_CONTEXT_PATH: contextPath, REVIEW_PROGRESS_PATH: progressPath,
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '7', REVIEW_BASE_SHA: base, REVIEW_HEAD_SHA: head,
      REVIEW_TRIGGER_SOURCE: source, GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputPath,
      REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH: '', REVIEW_COMMENT_ID: source === 'automatic' ? '' : '123',
      REVIEW_COMMENT_ROOT_ID: source === 'automatic' ? '' : '123',
      REVIEW_COMMENT_BODY: source === 'automatic' ? '' : '@agentic-review 请核对文档与 PR 的关系\r\nhttps://example.feishu.cn/wiki/test',
    };
    await exec(process.execPath, ['scripts/review-request.ts'], { env });
    const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => line.split('=')));
    assert.equal(outputs.comparison_start, base);
    const sealedContext = await readFile(contextPath, 'utf8');
    assert.equal(JSON.parse(sealedContext).request.text, env.REVIEW_COMMENT_BODY);
    const progress = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.deepEqual(Object.keys(progress), ['ledger', 'scope']);
    assert.deepEqual(progress.ledger, [{ path: 'auth.ts', status: 'pending', batches: [] }]);
    progress.scope = { mode: 'full', rationale: '完整审查', explicit_text: '',
      ranges: [{ targets: ['complete pull request'], comparison_start: base, comparison_end: head }] };
    // 模型可以整段重写进度，但文件中没有要原样搬运的请求或机器状态。
    await writeFile(progressPath, JSON.stringify(progress, null, 2));
    const resultPath = path.join(workspace, 'review-result.json');
    await writeFile(resultPath, JSON.stringify({ body: '已审查鉴权变化。', comments: [], thread_updates: [], request_reply: null }));
    const publishEnv = { ...env, REPOSITORY: 'owner/repo', PULL_NUMBER: '7', BASE_SHA: base, HEAD_SHA: head,
      REVIEW_INVENTORY_DIGEST: outputs.inventory_digest, REVIEW_COMPARISON_START: outputs.comparison_start,
      REVIEW_RUN_ID: '20', REVIEW_RUN_ATTEMPT: '1', REVIEW_RESULT_PATH: resultPath, REVIEW_COVERAGE_PATH: coveragePath, REVIEW_BOT_LOGIN: 'review-app[bot]',
      REVIEW_RUN_URL: 'https://github.test/run', REVIEW_WORKSPACE_URL: 'https://github.test/workspace', REVIEW_MODEL: 'test',
      REVIEW_PI_ACTION_REF: 'shaftoe/pi-coding-agent-action@v9.8.7',
      GITHUB_STEP_SUMMARY: path.join(directory, 'summary'), GH_TOKEN: 'test-token', GITHUB_API_URL: `http://127.0.0.1:${address.port}` };
    const publish = () => exec(process.execPath, ['scripts/publish-review.ts'], { env: publishEnv });
    const assemble = () => exec(process.execPath, ['scripts/prepare-review-publication.ts'], { env: publishEnv });
    await assert.rejects(exec(process.execPath, ['scripts/prepare-review-publication.ts'], { env: { ...publishEnv, PULL_NUMBER: '8' } }), /context does not match/);
    await assert.rejects(exec(process.execPath, ['scripts/prepare-review-publication.ts'], { env: { ...publishEnv, HEAD_SHA: base } }), /context does not match/);
    await assemble();
    await assert.rejects(publish(), /Incomplete coverage/);
    assert.equal(writes.length, 0);
    progress.ledger[0] = { path: 'auth.ts', status: 'complete', batches: ['auth'] };
    await mkdir(path.join(workspace, 'batches'));
    await writeFile(path.join(workspace, 'batches/auth.md'), '已核对鉴权调用方和失败路径。');
    await writeFile(progressPath, JSON.stringify({ ...progress, request: { text: '改写请求' } }));
    await assert.rejects(assemble(), /progress fields/);
    await writeFile(progressPath, JSON.stringify(progress));
    await assemble();
    assert.deepEqual(JSON.parse(await readFile(coveragePath, 'utf8')).completed_batches, ['auth']);
    await publish();
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { commit_id: string }).commit_id, head);
    assert.match((writes[0] as { body: string }).body, /\| Action v9\.8\.7/);
    const published = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.equal(published.status, 'published');
    assert.equal(published.complete_audit, source === 'automatic');
    assert.equal(published.request.text, env.REVIEW_COMMENT_BODY);
    assert.equal(await readFile(contextPath, 'utf8'), sealedContext);
    // 一条 finding 失败也必须发布后续 finding 和正文，但退出失败且不能推进 checkpoint。
    await assemble();
    await writeFile(resultPath, JSON.stringify({ body: '审查正文', comments: [1, 2].map(line => ({
      path: 'auth.ts', line, start_line: null, body: `finding ${line}`,
    })), thread_updates: [], request_reply: null }));
    const beforePartial = writes.length;
    await assert.rejects(publish(), /invalid diff line/);
    assert.equal(writes.length - beforePartial, 3);
    const partialCoverage = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.equal(partialCoverage.status, 'draft');
    assert.equal(partialCoverage.complete_audit, false);
    const reportPath = path.join(workspace, 'publication-report.json');
    const partial = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(partial.operations.filter((item: any) => item.status === 'failed').length, 1);
    assert.equal(partial.operations.find((item: any) => item.id === 'Review 正文').status, 'succeeded');
    assert.match(await readFile(publishEnv.GITHUB_STEP_SUMMARY, 'utf8'), /GitHub 发布操作未全部完成/);
    failReview = true;
    await assert.rejects(publish(), /review unavailable/);
    const multiple = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(multiple.operations.filter((item: any) => item.status === 'failed').length, 2);
    assert.equal(multiple.operations.find((item: any) => item.id.startsWith('finding 2')).status, 'succeeded');
    // GitHub 全部成功时，任一报告出口失败仍须回写 draft，不能保留已有 published 状态。
    failReview = false;
    await writeFile(resultPath, JSON.stringify({ body: '审查正文', comments: [], thread_updates: [], request_reply: null }));
    for (const outlet of ['report', 'summary']) {
      await writeFile(coveragePath, JSON.stringify(published));
      if (outlet === 'report') {
        await rm(reportPath);
        await mkdir(reportPath);
      }
      const before: number = writes.length;
      await assert.rejects(exec(process.execPath, ['scripts/publish-review.ts'], {
        env: { ...publishEnv, GITHUB_STEP_SUMMARY: outlet === 'summary' ? workspace : publishEnv.GITHUB_STEP_SUMMARY },
      }), outlet === 'report' ? /保存发布报告/ : /写入 Actions 摘要/);
      assert.equal(writes.length - before, 1);
      const failed = JSON.parse(await readFile(coveragePath, 'utf8'));
      assert.equal(failed.status, 'draft');
      assert.equal(failed.complete_audit, false);
      if (outlet === 'report') {
        await rm(reportPath, { recursive: true });
      } else {
        const operations = JSON.parse(await readFile(reportPath, 'utf8')).operations;
        assert.equal(operations.find((item: any) => item.id === 'Review 正文').status, 'succeeded');
        assert.equal(operations.find((item: any) => item.id === '写入 Actions 摘要').status, 'failed');
        assert.match(operations.find((item: any) => item.id === '写入 Actions 摘要').error, /EISDIR/);
        assert.equal(operations.find((item: any) => item.id === '保存覆盖状态').status, 'succeeded');
      }
    }
    failCoveragePath = coveragePath;
    await assert.rejects(publish(), /保存覆盖状态/);
    const coverageFailure = JSON.parse(await readFile(reportPath, 'utf8')).operations.find((item: any) => item.id === '保存覆盖状态');
    assert.equal(coverageFailure.status, 'failed');
    assert.match(coverageFailure.error, /EISDIR/);
    failCoveragePath = undefined;
    await rm(coveragePath, { recursive: true });
    await assemble();
    await publish();
    const recovered = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.equal(recovered.status, 'published');
    assert.equal(recovered.complete_audit, source === 'automatic');

  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
}

test('trusted inventory includes reverted incremental files and intervals from repeated failures', async () => {
  const { buildReviewRequest, initialReviewCoverage, prepareDefaultReviewPlan, reviewInventory } = await import('../scripts/review-request.ts');
  const { inventoryDigest, readReviewProgress, validateCoverageCompletion } = await import('../scripts/review-coverage.ts');
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
      scope: { kind: 'pr', mode: 'focused', rationale: '只看鉴权',
        explicit_text: '只看鉴权', ranges: [{ targets: ['auth.ts'], comparison_start: a, comparison_end: b }] } };
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
    const contextPath = path.join(directory, 'context-20.json');
    const progressPath = path.join(workspace, 'review-progress.json');
    const outputPath = path.join(directory, 'outputs');
    const env = { ...process.env, REVIEW_TARGET_PATH: directory, REVIEW_CONTEXT_PATH: contextPath, REVIEW_PROGRESS_PATH: progressPath,
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_PULL_NUMBER: '7', REVIEW_BASE_SHA: a, REVIEW_HEAD_SHA: c,
      REVIEW_TRIGGER_SOURCE: 'pr_comment', REVIEW_COMMENT_ID: '2', REVIEW_COMMENT_ROOT_ID: '2', REVIEW_COMMENT_BODY: '',
      GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputPath,
      REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH: oldWorkspace, REVIEW_PREVIOUS_RUN_ID: '10',
      REVIEW_PREVIOUS_RUN_ATTEMPT: '1', REVIEW_PREVIOUS_SOURCE: 'pr_comment', REVIEW_PREVIOUS_PUBLISHED: 'false' };
    await exec(process.execPath, ['scripts/review-request.ts'], { env });
    const coverage = await readReviewProgress(contextPath, progressPath);
    const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => line.split('=')));
    assert.deepEqual(coverage.ledger.map((entry: { path: string }) => entry.path), ['auth.ts', 'payments.ts']);
    assert.equal(outputs.inventory_digest, inventoryDigest(['auth.ts', 'payments.ts']));
    coverage.scope = { ...old.scope, kind: 'pr', mode: 'incremental', ranges: coverage.default_plan!.ranges };
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
      REVIEW_HEAD_SHA: d, GITHUB_RUN_ID: '30', REVIEW_PREVIOUS_RUN_ID: '20', REVIEW_CONTEXT_PATH: path.join(directory, 'context-30.json') } });
    const third = await readReviewProgress(path.join(directory, 'context-30.json'), progressPath);
    assert.deepEqual(third.default_plan!.ranges.map((range: { comparison_start: string; comparison_end: string }) =>
      [range.comparison_start, range.comparison_end]), [[a, b], [b, c], [c, d]]);
    assert.deepEqual(third.ledger.map((entry: { path: string }) => entry.path), ['auth.ts', 'payments.ts']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
