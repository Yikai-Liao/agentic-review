import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);

for (const source of ['automatic', 'pr_comment'] as const) {
test(`${source}: the CLI publishes by the trusted request and maintains review completion state`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-pipeline-'));
  const writes: unknown[] = [];
  let failReview = false;
  let failCollapse = false;
  let latestRun = 20;
  let failChecks = false;
  let failCoveragePath: string | undefined;
  const reviews: Array<{ id: number; body: string; html_url: string; user: { login: string } }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url?.includes('/check-runs?')) {
      const url = new URL(request.url, 'http://127.0.0.1');
      assert.equal(url.searchParams.get('filter'), 'all');
      const head = url.pathname.split('/')[5];
      response.statusCode = failChecks ? 503 : 200;
      response.end(JSON.stringify(failChecks ? { message: 'checks unavailable' } : { check_runs: [20, ...(latestRun === 21 ? [21] : [])].map(runId => ({
        id: runId, external_id: `1:7:base:${head}:automatic:${runId}:1`, app: { slug: 'review-app' },
      })) }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/repos/owner/repo/pulls/7/reviews?')) {
      response.end(JSON.stringify(reviews));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/repos/owner/repo/pulls/7/comments?')) {
      response.end('[]'); return;
    }
    if (request.method === 'POST' && request.url === '/graphql') {
      response.end(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
      return;
    }
    if (request.method === 'PUT' && request.url?.startsWith('/repos/owner/repo/pulls/7/reviews/')) {
      writes.push(JSON.parse(body));
      response.statusCode = failCollapse ? 503 : 200;
      response.end(JSON.stringify(failCollapse ? { message: 'old review unavailable' } : {}));
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/repos/owner/repo/pulls/7/reviews');
    writes.push(JSON.parse(body));
    if (failCoveragePath) {
      await rm(failCoveragePath);
      await mkdir(failCoveragePath);
    }
    response.statusCode = failReview ? 503 : 201;
    response.end(JSON.stringify(failReview ? { message: 'review unavailable' } : { id: 2, html_url: 'https://github.test/review/2' }));
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
    const attributionPath = path.join(directory, 'attribution.json');
    await writeFile(attributionPath, JSON.stringify({ reviewed: [], composition: [], pull_requests: [] }));
    const progressPath = path.join(workspace, 'review-progress.json');
    const coveragePath = path.join(workspace, 'review-coverage.json');
    const outputPath = path.join(directory, 'outputs');
    const env = {
      ...process.env, REVIEW_TARGET_PATH: target, REVIEW_ATTRIBUTION_PATH: attributionPath, REVIEW_CONTEXT_PATH: contextPath, REVIEW_PROGRESS_PATH: progressPath,
      REVIEW_REPOSITORY: 'owner/repo', REVIEW_REPOSITORY_ID: '1', REVIEW_PULL_NUMBER: '7', REVIEW_BASE_SHA: base, REVIEW_HEAD_SHA: head,
      REVIEW_TRIGGER_SOURCE: source, GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputPath,
      REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH: '', REVIEW_COMMENT_ID: source === 'automatic' ? '' : '123',
      REVIEW_COMMENT_ROOT_ID: source === 'automatic' ? '' : '123',
      REVIEW_COMMENT_BODY: source === 'automatic' ? '' : '@agentic-review please check how the doc relates to the PR\r\nhttps://example.feishu.cn/wiki/test',
    };
    await exec(process.execPath, ['scripts/review-request.ts'], { env });
    const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => line.split('=')));
    assert.equal(outputs.comparison_start, base);
    const sealedContext = await readFile(contextPath, 'utf8');
    assert.equal(JSON.parse(sealedContext).request.text, env.REVIEW_COMMENT_BODY);
    const progress = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.deepEqual(Object.keys(progress), ['ledger', 'scope']);
    assert.deepEqual(progress.ledger, [{ path: 'auth.ts', status: 'pending' }]);
    progress.scope = { mode: 'full', rationale: 'Full review', explicit_text: '',
      ranges: [{ targets: ['complete pull request'], comparison_start: base, comparison_end: head }] };
    // The model may rewrite progress wholesale, but the file holds no request or machine state to copy verbatim.
    await writeFile(progressPath, JSON.stringify(progress, null, 2));
    const resultPath = path.join(workspace, 'review-result.json');
    await writeFile(resultPath, JSON.stringify({ body: 'Reviewed the auth change.', comments: [], thread_updates: [], request_reply: null }));
    const usage = { input: 3, output: 132, cacheRead: 1972, cacheWrite: 41123, totalTokens: 43230,
      cost: { input: 0.000006, output: 0.00132, cacheRead: 0.0001972, cacheWrite: 0.1028075, total: 0.1043307 } };
    const usagePath = path.join(workspace, 'review-usage.json');
    await writeFile(usagePath, JSON.stringify({ turns: 1, priceKnown: true, first: usage, total: usage }));
    const publishEnv = { ...env, REPOSITORY: 'owner/repo', PULL_NUMBER: '7', BASE_SHA: base, HEAD_SHA: head,
      REVIEW_INVENTORY_DIGEST: outputs.inventory_digest, REVIEW_COMPARISON_START: outputs.comparison_start,
      REVIEW_CONTEXT_DIGEST: outputs.context_digest,
      REVIEW_RUN_ID: '20', REVIEW_RUN_ATTEMPT: '1', REVIEW_RESULT_PATH: resultPath, REVIEW_COVERAGE_PATH: coveragePath, REVIEW_BOT_LOGIN: 'review-app[bot]',
      REVIEW_RUN_URL: 'https://github.test/run', REVIEW_WORKSPACE_URL: 'https://github.test/workspace', REVIEW_MODEL: 'test',
      REVIEW_COST: '0.00321', REVIEW_LANGUAGE: 'zh-CN',
      GITHUB_STEP_SUMMARY: path.join(directory, 'summary'), GH_TOKEN: 'test-token', GITHUB_API_URL: `http://127.0.0.1:${address.port}` };
    const publish = () => exec(process.execPath, ['scripts/publish-review.ts'], { env: publishEnv });
    const assemble = () => exec(process.execPath, ['scripts/prepare-review-publication.ts'], { env: publishEnv });
    if (source === 'automatic') {
      // Changing only the default scope with the same request identity must also be caught by the preparation digest.
      const tampered = JSON.parse(sealedContext);
      tampered.default_plan.ranges[0].targets = ['only files the model chose'];
      await chmod(contextPath, 0o600);
      await writeFile(contextPath, JSON.stringify(tampered));
      await assert.rejects(assemble(), /trusted preparation digest/);
      assert.equal(writes.length, 0);
      await writeFile(contextPath, sealedContext);
      await chmod(contextPath, 0o400);
      await assert.rejects(exec(process.execPath, ['scripts/prepare-review-publication.ts'], {
        env: { ...publishEnv, REVIEW_CONTEXT_DIGEST: '' },
      }), /Missing REVIEW_CONTEXT_DIGEST/);
      await assert.rejects(exec(process.execPath, ['scripts/publish-review-run.ts'], {
        env: { ...publishEnv, PI_REVIEW_OUTCOME: 'failure' },
      }), /workspace saved for recovery/);
      assert.match(await readFile(outputPath, 'utf8'), /workspace_ready=true/);
      assert.equal(writes.length, 0);
      await assert.rejects(exec(process.execPath, ['scripts/prepare-review-publication.ts'], { env: { ...publishEnv, PULL_NUMBER: '8' } }), /context does not match/);
      await assert.rejects(exec(process.execPath, ['scripts/prepare-review-publication.ts'], { env: { ...publishEnv, HEAD_SHA: base } }), /context does not match/);
      await assemble();
      // When the time budget runs out, the reviewed part is published, a trusted list names unreviewed files, and it never becomes a complete audit checkpoint.
      await publish();
      assert.equal(writes.length, 1);
      const partialBody = (writes[0] as { body: string }).body;
      assert.match(partialBody, /只完成了部分审查：已覆盖 0\/1 个文件/);
      assert.match(partialBody, /- `auth\.ts`/);
      const partialPublished = JSON.parse(await readFile(coveragePath, 'utf8'));
      assert.equal(partialPublished.status, 'published');
      assert.equal(partialPublished.complete_audit, false);
      assert.match(await readFile(outputPath, 'utf8'), /coverage_pending=1\ncoverage_total=1/);
      writes.length = 0;
      await writeFile(progressPath, JSON.stringify({ ...progress, request: { text: 'rewritten request' } }));
      await assert.rejects(assemble(), /progress fields/);
    }
    progress.ledger[0] = { path: 'auth.ts', status: 'complete' };
    await writeFile(progressPath, JSON.stringify(progress));
    await assemble();
    assert.deepEqual(JSON.parse(await readFile(coveragePath, 'utf8')).ledger, progress.ledger);
    const bodyFinding = 'No issues to address.\n\n### Behavior after merge\n\nThe auth.ts write path keeps its permission constraints.';
    await writeFile(resultPath, JSON.stringify({ body: bodyFinding, comments: [], thread_updates: [], request_reply: null }));
    await rm(usagePath);
    await assert.rejects(publish(), /review-usage.json/);
    assert.equal(writes.length, 0, 'Missing cost breakdowns must not publish seemingly complete stats');
    await writeFile(usagePath, JSON.stringify({ turns: 1, priceKnown: true, first: usage, total: usage }));
    await publish();
    assert.equal(writes.length, 1);
    assert.ok((writes[0] as { body: string }).body.includes(bodyFinding));
    assert.equal((writes[0] as { commit_id: string }).commit_id, head);
    assert.match((writes[0] as { body: string }).body, /费用约 \$0\.0032/);
    // Usage details reach the Check only through step output; the PR body keeps one line of run info.
    assert.doesNotMatch((writes[0] as { body: string }).body, /首轮缓存命中/);
    const checkTextOutput = (await readFile(outputPath, 'utf8')).split(/^check_text<<(check_text_[\w-]+)\n/m);
    assert.match(checkTextOutput.at(-1)!, new RegExp(`首轮缓存命中 4\\.6%[\\s\\S]*成功 \\d+；失败 0[\\s\\S]*\\n${checkTextOutput.at(-2)}\\n$`));
    assert.doesNotMatch((writes[0] as { body: string }).body, /\| Action v|\| 审查范围:/);
    const published = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.equal(published.status, 'published');
    assert.equal(published.complete_audit, source === 'automatic');
    assert.equal(published.request.text, env.REVIEW_COMMENT_BODY);
    assert.equal(await readFile(contextPath, 'utf8'), sealedContext);
    // PR comment requests keep their own reply; only complete automatic reviews are subject to the supersession check.
    if (source === 'pr_comment') return;
    // When a newer run has started or the Check read fails, the CLI exits with failure, writes nothing to the PR, and keeps no coverage completion.
    for (const checksUnavailable of [false, true]) {
      latestRun = 21;
      failChecks = checksUnavailable;
      const before: number = writes.length;
      await assert.rejects(publish(), checksUnavailable ? /checks unavailable/ : /has already started reviewing this head/);
      assert.equal(writes.length, before);
      const blocked = JSON.parse(await readFile(coveragePath, 'utf8'));
      assert.equal(blocked.status, 'draft');
      assert.equal(blocked.complete_audit, false);
    }
    latestRun = 20;
    failChecks = false;
    // New findings publish with the body at once; if collapsing the old summary fails, the new summary still publishes but the run exits with failure and cannot advance the checkpoint.
    await assemble();
    reviews.push({ id: 1, html_url: 'https://github.test/review/1', user: { login: 'review-app[bot]' },
      body: '<!-- agentic-review-publication:old --><!-- agentic-review:automatic-summary -->\n## 自动审查：没有需要处理的问题\n\nEarlier conclusion' });
    failCollapse = true;
    await writeFile(resultPath, JSON.stringify({ body: 'Review body', comments: [{
      path: 'auth.ts', line: 1, start_line: null, label: 'P2', title: 'Unauthorized requests reach the write path', body: 'finding',
    }], thread_updates: [], request_reply: null }));
    const beforePartial = writes.length;
    await assert.rejects(publish(), /old review unavailable/);
    assert.equal(writes.length - beforePartial, 2);
    const bundled = writes[beforePartial] as { comments: Array<{ path: string; line: number; body: string }> };
    assert.deepEqual(bundled.comments.map(({ path, line }) => ({ path, line })), [{ path: 'auth.ts', line: 1 }]);
    assert.match(bundled.comments[0].body, /\*\*P2：Unauthorized requests reach the write path\*\*/);
    const partialCoverage = JSON.parse(await readFile(coveragePath, 'utf8'));
    assert.equal(partialCoverage.status, 'draft');
    assert.equal(partialCoverage.complete_audit, false);
    const reportPath = path.join(workspace, 'publication-report.json');
    const partial = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(partial.operations.find((item: any) => item.id === 'Review 正文').status, 'succeeded');
    assert.equal(partial.operations.find((item: any) => item.id === '收起旧 Review 1').status, 'failed');
    assert.match(await readFile(publishEnv.GITHUB_STEP_SUMMARY, 'utf8'), /GitHub 发布操作未全部完成/);
    reviews.length = 0;
    failCollapse = false;
    failReview = true;
    await assert.rejects(publish(), /review unavailable/);
    const failedReview = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(failedReview.operations.find((item: any) => item.id === 'Review 正文').status, 'failed');
    // Even when every GitHub write succeeds, any failed report outlet must write back draft instead of keeping the published state.
    failReview = false;
    await writeFile(resultPath, JSON.stringify({ body: 'Review body', comments: [], thread_updates: [], request_reply: null }));
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
      scope: { kind: 'pr', mode: 'focused', rationale: 'Auth only',
        explicit_text: 'Auth only', ranges: [{ targets: ['auth.ts'], comparison_start: a, comparison_end: b }] } };
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
    const attributionPath = path.join(directory, 'attribution.json');
    await writeFile(attributionPath, JSON.stringify({ reviewed: [], composition: [], pull_requests: [] }));
    const progressPath = path.join(workspace, 'review-progress.json');
    const outputPath = path.join(directory, 'outputs');
    const env = { ...process.env, REVIEW_TARGET_PATH: directory, REVIEW_ATTRIBUTION_PATH: attributionPath, REVIEW_CONTEXT_PATH: contextPath, REVIEW_PROGRESS_PATH: progressPath,
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
    await assert.rejects(validateCoverageCompletion(coverage, outputs.inventory_digest), /Incomplete coverage: auth.ts/);
    await assert.rejects(validateCoverageCompletion({ ...coverage, ledger: [coverage.ledger[1]] }, outputs.inventory_digest), /inventory/);
    // The second round saves its actual scope and still fails; the third must keep carrying A→B and B→C.
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
    // A working draft partially published within the time budget is a valid previous record, and the next round inherits its unreviewed scope too.
    await chmod(oldWorkspace, 0o700);
    await writeFile(path.join(oldWorkspace, 'review-coverage.json'), JSON.stringify({ ...coverage, status: 'published' }));
    await exec(process.execPath, ['scripts/review-request.ts'], { env: { ...env, REVIEW_PREVIOUS_PUBLISHED: 'true',
      REVIEW_HEAD_SHA: d, GITHUB_RUN_ID: '40', REVIEW_PREVIOUS_RUN_ID: '20', REVIEW_CONTEXT_PATH: path.join(directory, 'context-40.json') } });
    const afterPartial = await readReviewProgress(path.join(directory, 'context-40.json'), progressPath);
    assert.equal(afterPartial.default_plan!.reason, 'resume_failed_scope');
    assert.deepEqual(afterPartial.default_plan!.ranges.map((range: { comparison_start: string; comparison_end: string }) =>
      [range.comparison_start, range.comparison_end]), [[a, b], [b, c], [c, d]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
