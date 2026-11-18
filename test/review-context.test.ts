import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';
import { buildReviewRequest, initialReviewCoverage } from '../scripts/review-request.ts';

const exec = promisify(execFile);

async function fixture(t: TestContext, source: 'automatic' | 'pr_comment' | 'thread') {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-context-'));
  t.after(async () => { await exec('chmod', ['-R', 'u+w', directory]); await rm(directory, { recursive: true, force: true }); });
  const origin = path.join(directory, 'git/owner/repo.git');
  const working = path.join(directory, 'working');
  await mkdir(path.dirname(origin), { recursive: true });
  execFileSync('git', ['init', '-q', working]);
  const git = (...args: string[]) => execFileSync('git', ['-C', working, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await writeFile(path.join(working, 'auth.ts'), 'base');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(path.join(working, 'auth.ts'), 'reviewed');
  git('commit', '-qam', 'reviewed');
  const oldHead = git('rev-parse', 'HEAD');
  await writeFile(path.join(working, 'view.ts'), 'new change');
  git('add', '.'); git('commit', '-qm', 'new change');
  const head = git('rev-parse', 'HEAD');
  const history = { head: oldHead };
  let requestedHead = oldHead;
  if (source === 'pr_comment') {
    git('checkout', '--detach', base);
    await writeFile(path.join(working, 'auth.ts'), 'previous unmerged request');
    git('commit', '-qam', 'previous request');
    requestedHead = git('rev-parse', 'HEAD');
    git('branch', 'previous-request', requestedHead);
    git('checkout', '--detach', head);
  }
  execFileSync('git', ['clone', '--bare', '-q', working, origin]);
  const previous = path.join(directory, 'previous');
  const requested = path.join(directory, 'requested');
  await mkdir(previous); await mkdir(requested);
  const request = buildReviewRequest({ repository: 'owner/repo', pullNumber: 7, baseSha: base, headSha: oldHead, runId: '10' });
  const coverage = { ...initialReviewCoverage(request), status: 'published', complete_audit: true,
    scope: { kind: 'pr', mode: 'full', rationale: 'Full review', explicit_text: '',
      ranges: [{ targets: ['complete pull request'], comparison_start: base, comparison_end: oldHead }] },
    ledger: [{ path: 'auth.ts', status: 'complete' }] };
  await writeFile(path.join(previous, 'review-coverage.json'), JSON.stringify(coverage));
  await writeFile(path.join(previous, 'notes.md'), 'level: code\nThe earlier auth change was investigated.');
  await writeFile(path.join(previous, 'review-result.json'), JSON.stringify({ body: 'Earlier conclusion', comments: [], thread_updates: [], request_reply: null }));
  await cp(previous, requested, { recursive: true });
  await writeFile(path.join(requested, 'review-coverage.json'), JSON.stringify({ ...coverage, status: 'draft', complete_audit: false,
    request: { ...request, head_sha: requestedHead, source: 'pr_comment', comment_id: '123', root_comment_id: '123', run_id: '9' },
    scope: { ...coverage.scope, mode: 'focused', ranges: [{ targets: ['auth.ts'], comparison_start: base, comparison_end: requestedHead }] },
    ledger: [{ path: 'auth.ts', status: 'pending' }] }));
  const artifact = (name: string) => ({ id: 11, name, expired: false, created_at: '2026-11-01T00:00:00Z' });
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/repos/control/review/actions/runs/10/artifacts')) {
        assert.equal(req.headers.authorization, 'Bearer control-readonly');
        res.end(JSON.stringify({ artifacts: [artifact('review-completed-workspace-1-7-automatic-10-1')] })); return;
      }
      if (req.url?.startsWith('/repos/control/review/actions/artifacts?')) {
        assert.equal(req.headers.authorization, 'Bearer control-readonly');
        res.end(JSON.stringify({ artifacts: [artifact('review-workspace-1-7-pr_comment-9-1')] })); return;
      }
      assert.equal(req.headers.authorization, 'Bearer target-readonly');
      if (req.url === '/repos/owner/repo/issues/comments/456') {
        res.end(JSON.stringify({ id: 456, body: 'Please continue the review', issue_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/repos/owner/repo/issues/7` })); return;
      }
      if (req.url === '/repos/owner/repo/pulls/comments/456') {
        res.end(JSON.stringify({ id: 456, in_reply_to_id: 123, body: 'Please recheck',
          pull_request_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/repos/owner/repo/pulls/7` })); return;
      }
      assert.equal(req.url, '/graphql');
      let body = ''; for await (const chunk of req) body += chunk;
      const { query, variables } = JSON.parse(body);
      const repository: Record<string, unknown> = {};
      if (query.includes('AssociatedIssues')) repository.pullRequest = { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } };
      else for (const key of Object.keys(variables).filter(key => /^oid\d+$/.test(key))) {
        const sha = variables[key];
        repository[`c${key.slice(3)}`] = /AssociatedPullRequests|MergedSources/.test(query)
          ? { oid: sha, associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false } } }
          // GitHub shows only the latest Check with a given name; a new IN_PROGRESS on the current head hides the earlier success.
          : { oid: sha, checkSuites: { nodes: sha === history.head && (sha !== head || /\bcheckType\s*:\s*ALL\b/.test(query))
            ? [{ app: { slug: 'review-app' }, checkRuns: { nodes: [{
            name: 'Agentic Review / audit', externalId: `1:7:${base}:${history.head}:automatic:10:1`, status: 'COMPLETED', conclusion: 'SUCCESS',
          }] } }] : [] } };
      }
      res.end(JSON.stringify({ data: { repository } }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bin = path.join(directory, 'bin'); await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'); const args=process.argv.slice(2);
if(args[0]==='run' && args[1]==='download') {
  if(process.env.GH_TOKEN!=='control-readonly') throw Error('incorrect artifact token');
  const name=args[args.indexOf('--name')+1], directory=args[args.indexOf('--dir')+1];
  fs.cpSync(name.includes('-pr_comment-')?process.env.FIXTURE_REQUESTED:process.env.FIXTURE_AUDIT,directory,{recursive:true});
} else if(args[0]==='api') {
  if(process.env.GH_TOKEN!=='target-readonly') throw Error('incorrect discussion token');
  if(process.env.FAIL_DISCUSSION==='true') { console.error('discussion unavailable'); process.exit(1); }
  const thread=process.env.FIXTURE_SOURCE==='thread';
  if(args.includes('graphql')) console.log(JSON.stringify([{data:{repository:{pullRequest:{reviewThreads:{
    nodes:thread?[{id:'thread-123',isResolved:false,isOutdated:false,resolvedBy:null,comments:{nodes:[{databaseId:123}]}}]:[],pageInfo:{hasNextPage:false,endCursor:null}
  }}}}}]));
  else console.log(JSON.stringify([thread&&args.some(arg=>arg.includes('/pulls/7/comments?'))?[{id:123,body:'Original issue',path:'auth.ts'},{id:456,in_reply_to_id:123,body:'Please recheck',path:'auth.ts'}]:[]]));
} else throw Error('unexpected gh command '+args.join(' '));
`, { mode: 0o755 });
  const workspace = path.join(directory, 'run'); const temporary = path.join(directory, 'temp');
  await mkdir(workspace); await mkdir(temporary);
  const snapshot = path.join(temporary, 'snapshot.json');
  await writeFile(snapshot, JSON.stringify({ repository: 'owner/repo', pullNumber: '7', baseSha: base, headSha: head,
    metadata: { title: 'Frozen title', body: 'Description reused from the first snapshot.' } }));
  const outputs = path.join(directory, 'outputs');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'target-readonly', CONTROL_TOKEN: 'control-readonly',
    GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temporary, GITHUB_REPOSITORY: 'control/review', GITHUB_SERVER_URL: `file://${path.join(directory, 'git')}`,
    GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputs, GITHUB_API_URL: api, GITHUB_GRAPHQL_URL: `${api}/graphql`,
    REVIEW_REPOSITORY: 'owner/repo', REVIEW_REPOSITORY_ID: '1', REVIEW_PULL_NUMBER: '7', REVIEW_TRIGGER_SOURCE: source, REVIEW_LANGUAGE: 'zh-CN',
    REVIEW_COMMENT_ID: source === 'automatic' ? '' : '456', REVIEW_COMMENT_ROOT_ID: source === 'thread' ? '123' : source === 'automatic' ? '' : '456', REVIEW_COMMENT_BODY: 'Please continue the review',
    REVIEW_SNAPSHOT_PATH: snapshot, REVIEW_APP_SLUG: 'review-app', FIXTURE_SOURCE: source, FIXTURE_AUDIT: previous, FIXTURE_REQUESTED: requested };
  return { env, workspace, temporary, outputs, previous, head, history, prepare: (extra: Record<string, string> = {}) =>
    exec(process.execPath, ['scripts/prepare-review-context.ts'], { env: { ...env, ...extra } }) };
}

for (const source of ['automatic', 'pr_comment', 'thread'] as const) test(`Full preparation entry: ${source} restores the right scope, reuses the snapshot, and delivers usable input`, async t => {
  const f = await fixture(t, source);
  await f.prepare();
  const context = JSON.parse(await readFile(path.join(f.temporary, 'review-context/review-context.json'), 'utf8'));
  const progress = JSON.parse(await readFile(path.join(f.workspace, 'review-workspace/review-progress.json'), 'utf8'));
  assert.deepEqual(progress.ledger.map((entry: { path: string }) => entry.path), ['auth.ts', 'view.ts']);
  assert.equal(progress.ledger[0].status, source === 'automatic' ? 'complete' : 'pending');
  if (source === 'pr_comment') {
    assert.equal(context.default_plan.reason, 'resume_failed_scope');
    assert.equal(context.default_plan.ranges.length, 2);
  }
  if (source === 'thread') {
    assert.equal(context.request.root_comment_id, '123');
    assert.equal(context.default_plan.reason, 'thread_default');
    assert.equal(progress.scope.mode, 'focused');
  }
  const materials = JSON.parse(await readFile(path.join(f.temporary, 'review-input.json'), 'utf8')).materials;
  const metadata = materials.find((material: { title: string }) => material.title === 'Untrusted PR metadata');
  assert.match(await readFile(metadata.path, 'utf8'), /Frozen title/);
  const output = await readFile(f.outputs, 'utf8');
  const publisher = output.match(/^publisher_archive=(.+)$/m)?.[1];
  assert.ok(publisher);
  // Linux caps a single environment string at 128 KiB; the real publication payload must pass from the runner to later Actions.
  assert.ok(Buffer.byteLength(`REVIEW_PUBLISHER_ARCHIVE=${publisher}\0`) <= 128 * 1024);
  const restored = await mkdtemp(path.join(f.temporary, 'publisher-'));
  execFileSync('tar', ['-xzf', '-', '-C', restored], { input: Buffer.from(publisher, 'base64') });
  assert.deepEqual((await readdir(restored)).sort(), ['package.json', 'scripts']);
  const scripts = await readdir(new URL('../scripts/', import.meta.url));
  assert.deepEqual((await readdir(path.join(restored, 'scripts'))).sort(), scripts.sort());
  for (const filename of ['package.json', ...scripts.map(file => `scripts/${file}`)]) {
    assert.deepEqual(await readFile(path.join(restored, filename)), await readFile(new URL(`../${filename}`, import.meta.url)));
  }
  assert.match(output, /context_digest=[0-9a-f]{64}/);
  const promptPath = output.match(/^prompt_path=(.+)$/m)?.[1];
  assert.equal(promptPath, path.join(f.temporary, 'review-prompt.md'));
  const prompt = await loadReviewPrompt(fileURLToPath(new URL('..', import.meta.url)), 'zh-CN');
  assert.equal(await readFile(promptPath!, 'utf8'), prompt);
  assert.ok(!output.includes(prompt));
  const config = await readFile(path.join(f.workspace, 'review-target/.git/config'), 'utf8');
  assert.doesNotMatch(config, /target-readonly|extraheader|credential/);
});

test('A new in-progress Check on the same snapshot does not hide the earlier successful review, and full preparation carries over all completed entries', async t => {
  const f = await fixture(t, 'automatic');
  f.history.head = f.head;
  const file = path.join(f.previous, 'review-coverage.json');
  const coverage = JSON.parse(await readFile(file, 'utf8'));
  coverage.request.head_sha = f.head;
  coverage.scope.ranges[0].comparison_end = f.head;
  coverage.ledger.push({ path: 'view.ts', status: 'complete' });
  await writeFile(file, JSON.stringify(coverage));
  await f.prepare();
  const manifest = JSON.parse(await readFile(path.join(f.workspace, 'review-workspace/resume-manifest.json'), 'utf8'));
  const progress = JSON.parse(await readFile(path.join(f.workspace, 'review-workspace/review-progress.json'), 'utf8'));
  assert.equal(manifest.inherited_from_run, '10:1');
  assert.equal(manifest.same_snapshot, true);
  assert.deepEqual(manifest.pending_files, []);
  assert.deepEqual(progress.ledger, [{ path: 'auth.ts', status: 'complete' }, { path: 'view.ts', status: 'complete' }]);
});

test('A failed discussion read still pins this request and scope first; preparation fails and delivers no prompt', async t => {
  const f = await fixture(t, 'automatic');
  await assert.rejects(f.prepare({ FAIL_DISCUSSION: 'true' }), /discussion unavailable/);
  const output = await readFile(f.outputs, 'utf8');
  assert.match(output, /context_digest=[0-9a-f]{64}/);
  assert.match(output, /^publisher_archive=.+$/m);
  assert.doesNotMatch(output, /^prompt_path=/m);
  const progress = JSON.parse(await readFile(path.join(f.workspace, 'review-workspace/review-progress.json'), 'utf8'));
  assert.deepEqual(progress.ledger.map((entry: { status: string }) => entry.status), ['pending', 'pending']);
});

test('A downloaded completed workspace from another run blocks baseline adoption and agent startup', async t => {
  const f = await fixture(t, 'automatic');
  const file = path.join(f.previous, 'review-coverage.json');
  const coverage = JSON.parse(await readFile(file, 'utf8'));
  coverage.request.run_id = '99';
  await writeFile(file, JSON.stringify(coverage));
  await assert.rejects(f.prepare(), /not the selected completed audit checkpoint/);
  assert.doesNotMatch(await readFile(f.outputs, 'utf8'), /prompt<</);
});
