import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse } from 'yaml';
import { prepare, blind, check } from '../evals/evaluate.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-evaluation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (file: string, value: string) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await write('rules.md', '基线规则较长'); await write('shared.md', '相同封装');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const config = {
    baseline: git('rev-parse', 'HEAD'), hypothesis: '摘要更清楚', model: 'test', reasoning: 'high',
    vary: ['rules.md'], shared: ['shared.md'], cases: 'cases.json', rubric: 'rubric.md', repetitions: 2, maxPromptChars: 30,
  };
  await write('rules.md', '短规则');
  await write('cases.json', JSON.stringify([
    { id: 'A', kind: 'summary', input: '固定事实A', expected: '仅评委可见的标准A' },
    { id: 'B', kind: 'evidence', input: '固定事实B', expected: '仅评委可见的标准B' },
  ]));
  await write('rubric.md', '事实完整，表达清楚。');
  const dir = 'evals/experiments/trial';
  await write(`${dir}/experiment.json`, JSON.stringify(config));
  await write(`${dir}/input-audit.md`, 'A/B 为单元测试占位事实，不用于模型质量结论。');
  const outputs = async () => {
    for (const variant of ['baseline', 'candidate']) for (const repeat of [1, 2]) for (const id of ['A', 'B']) {
      await write(`${dir}/outputs/${variant}/r${repeat}/${id}.md`, `${variant} ${repeat} ${id}`);
    }
  };
  const judges = async (mode: 'keep' | 'tie' | 'failed-case' = 'keep') => {
    const mappings = JSON.parse(await readFile(path.join(root, dir, 'judges/mapping.json'), 'utf8'));
    for (const judge of [1, 2, 3]) {
      const m = mappings[judge];
      const candidatePass = mode !== 'failed-case';
      await write(`${dir}/judges/${judge}.json`, JSON.stringify({
        packetSha256: m.packetSha256, overall: mode === 'tie' ? 'tie' : m.candidate,
        cases: ['A/1', 'B/1', 'A/2', 'B/2'].map(id => ({
          id, xPass: m.candidate === 'X' ? candidatePass : false, yPass: m.candidate === 'Y' ? candidatePass : false,
          preference: mode === 'tie' ? 'tie' : m.candidate, margin: 'clear', reason: '固定的测试评价', concerns: [],
        })),
      }));
    }
  };
  return { root, dir, config, write, outputs, judges, git };
}

test('Git ignores local experiment runs while keeping reusable evaluation assets', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', await readFile(new URL('../.gitignore', import.meta.url), 'utf8'));
  await f.write('evals/cases/review-expression.json', '[]');
  await f.write('evals/RESULTS.md', '精简结果');
  await prepare(f.root, 'trial'); await f.outputs(); await blind(f.root, 'trial'); await f.judges();
  assert.equal((await check(f.root, 'trial')).recommendation, 'keep');
  f.git('add', '.');
  assert.equal(f.git('ls-files', 'evals/experiments'), '');
  assert.equal(f.git('ls-files', 'evals/cases/review-expression.json'), 'evals/cases/review-expression.json');
  assert.equal(f.git('ls-files', 'evals/RESULTS.md'), 'evals/RESULTS.md');
});

test('evaluation freezes Git baseline, shared context and private expectations without overwriting', async t => {
  const f = await fixture(t);
  const result = await prepare(f.root, 'trial');
  assert.deepEqual(result.promptChars, { baseline: 10, candidate: 7 });
  assert.equal(await readFile(path.join(f.root, f.dir, 'rules/baseline/rules.md'), 'utf8'), '基线规则较长');
  assert.equal(await readFile(path.join(f.root, f.dir, 'rules/candidate/rules.md'), 'utf8'), '短规则');
  const generation = await readFile(path.join(f.root, f.dir, 'tasks/candidate-1.md'), 'utf8');
  assert.ok(generation.includes('固定事实A'));
  assert.ok(!generation.includes('仅评委可见'));
  assert.ok(!generation.includes(f.root));
  await assert.rejects(prepare(f.root, 'trial'), /EEXIST/);
});

test('evaluation rejects oversized rules, duplicate cases and escaped input paths', async t => {
  const f = await fixture(t);
  await f.write(`${f.dir}/experiment.json`, JSON.stringify({ ...f.config, maxPromptChars: 1 }));
  await assert.rejects(prepare(f.root, 'trial'), /超预算/);
  await assert.rejects(access(path.join(f.root, f.dir, 'lock.json')));
  await f.write(`${f.dir}/experiment.json`, JSON.stringify(f.config));
  const item = { id: 'A', kind: 'summary', input: 'a', expected: 'b' };
  await f.write('cases.json', JSON.stringify([item, item]));
  await assert.rejects(prepare(f.root, 'trial'), /ID 重复/);
  await f.write('cases.json', JSON.stringify([item]));
  await f.write(`${f.dir}/experiment.json`, JSON.stringify({ ...f.config, vary: ['../outside.md'] }));
  await assert.rejects(prepare(f.root, 'trial'), /路径/);
});

test('preparation requires a nonempty input audit and freezes it without exposing it to generators', async t => {
  const f = await fixture(t);
  await f.write(`${f.dir}/input-audit.md`, '  ');
  await assert.rejects(prepare(f.root, 'trial'), /输入充分性/);
  await f.write(`${f.dir}/input-audit.md`, '人工审计：事实来源与缺口已检查。');
  await prepare(f.root, 'trial');
  const task = await readFile(path.join(f.root, f.dir, 'tasks/candidate-1.md'), 'utf8');
  assert.ok(!task.includes('人工审计'));
  await f.write(`${f.dir}/input-audit.md`, '改变审计结论');
  await assert.rejects(blind(f.root, 'trial'), /冻结输入发生漂移/);
});

test('blind evaluation requires every nonempty output and hides variant labels', async t => {
  const f = await fixture(t);
  await prepare(f.root, 'trial');
  await assert.rejects(blind(f.root, 'trial'), /ENOENT/);
  await f.outputs();
  await f.write(`${f.dir}/outputs/candidate/r2/B.md`, '  ');
  await assert.rejects(blind(f.root, 'trial'), /输出为空/);
  await f.outputs();
  await blind(f.root, 'trial');
  const mapping = JSON.parse(await readFile(path.join(f.root, f.dir, 'judges/mapping.json'), 'utf8'));
  assert.notEqual(mapping['1'].candidate, mapping['2'].candidate);
  const packet = await readFile(path.join(f.root, f.dir, 'judges/1.md'), 'utf8');
  assert.ok(packet.includes('仅评委可见的标准A'));
  assert.ok(!packet.includes('rules/candidate'));
  await assert.rejects(blind(f.root, 'trial'), /EEXIST/);
});

test('neutral judge templates cannot cast votes or pass the gate unchanged', async t => {
  const f = await fixture(t);
  await prepare(f.root, 'trial');
  for (const variant of ['baseline', 'candidate']) for (const repeat of [1, 2]) for (const id of ['A', 'B']) {
    await f.write(`${f.dir}/outputs/${variant}/r${repeat}/${id}.md`, `相同输出 ${id}`);
  }
  await blind(f.root, 'trial');
  for (const judge of [1, 2, 3]) {
    const packet = await readFile(path.join(f.root, f.dir, `judges/${judge}.md`), 'utf8');
    const template = JSON.parse(packet.slice(packet.lastIndexOf('\n{\n')));
    assert.equal(template.overall, null);
    for (const item of template.cases) {
      assert.deepEqual([item.xPass, item.yPass, item.preference, item.margin, item.reason], [null, null, null, null, '']);
    }
    await f.write(`${f.dir}/judges/${judge}.json`, JSON.stringify(template));
  }
  await assert.rejects(check(f.root, 'trial'), /版本或偏好无效/);
  await f.judges('tie');
  const tied = await check(f.root, 'trial');
  assert.equal(tied.recommendation, 'revise');
  assert.deepEqual(tied.votes, { candidate: 0, baseline: 0, tie: 3 });
});

test('paired recommendation requires three judges, majority improvement and passing every case', async t => {
  const f = await fixture(t);
  await prepare(f.root, 'trial'); await f.outputs(); await blind(f.root, 'trial');
  await assert.rejects(check(f.root, 'trial'), /ENOENT/);
  await f.judges();
  const result = await check(f.root, 'trial');
  assert.equal(result.recommendation, 'keep');
  assert.deepEqual(result.votes, { candidate: 3, baseline: 0, tie: 0 });
  assert.equal(Object.keys(result.cases).length, 4);
  await f.judges('tie');
  assert.equal((await check(f.root, 'trial')).recommendation, 'revise');
  await f.judges('failed-case');
  assert.equal((await check(f.root, 'trial')).recommendation, 'revise');
});

test('an acceptable case may prefer the baseline without vetoing an overall improvement', async t => {
  const f = await fixture(t);
  await prepare(f.root, 'trial'); await f.outputs(); await blind(f.root, 'trial'); await f.judges();
  for (const judge of [1, 2, 3]) {
    const file = `${f.dir}/judges/${judge}.json`;
    const value = JSON.parse(await readFile(path.join(f.root, file), 'utf8'));
    value.cases[0].preference = value.overall === 'X' ? 'Y' : 'X';
    value.cases[0].xPass = true;
    value.cases[0].yPass = true;
    value.cases[0].margin = 'slight';
    value.cases[0].concerns = ['两份均合格，旧版额外定位略便于追溯。'];
    await f.write(file, JSON.stringify(value));
  }
  const result = await check(f.root, 'trial');
  assert.equal(result.recommendationPolicy, 'all-pass-overall-better');
  assert.equal(result.recommendation, 'keep');
  assert.equal(result.cases['A/1'].baselinePreferred, 3);
  assert.equal(result.concerns.length, 3);
});

test('modified output, judge packet or frozen rules cannot reuse prior judgments', async t => {
  const f = await fixture(t);
  await prepare(f.root, 'trial'); await f.outputs(); await blind(f.root, 'trial'); await f.judges();
  await f.write(`${f.dir}/outputs/candidate/r1/A.md`, '改过的输出');
  await assert.rejects(check(f.root, 'trial'), /输出.*漂移/);
  await f.outputs();
  const packetPath = `${f.dir}/judges/1.md`;
  const packet = await readFile(path.join(f.root, packetPath), 'utf8');
  await f.write(packetPath, `${packet}\n追加指令`);
  await assert.rejects(check(f.root, 'trial'), /评判材料.*漂移/);
  await f.write(packetPath, packet);
  await f.write(`${f.dir}/rules/candidate/rules.md`, '偷偷更换规则');
  await assert.rejects(check(f.root, 'trial'), /冻结输入.*漂移/);
});

test('duplicate or stale judge results fail instead of counting extra votes', async t => {
  const f = await fixture(t);
  await prepare(f.root, 'trial'); await f.outputs(); await blind(f.root, 'trial'); await f.judges();
  const file = `${f.dir}/judges/1.json`;
  const original = JSON.parse(await readFile(path.join(f.root, file), 'utf8'));
  const duplicate = structuredClone(original);
  duplicate.cases[1] = duplicate.cases[0];
  await f.write(file, JSON.stringify(duplicate));
  await assert.rejects(check(f.root, 'trial'), /用例缺失或重复/);
  await f.write(file, JSON.stringify({ ...original, packetSha256: 'stale' }));
  await assert.rejects(check(f.root, 'trial'), /版本或偏好无效/);
});

test('production sparse checkout and actual prompt loader exclude maintenance skills and evaluations', async t => {
  const f = await fixture(t);
  const workflow = await readFile(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8');
  const checkout = workflow.split('      - name: Checkout control-plane rules\n')[1].split('\n      - name:')[0];
  assert.ok(checkout.includes('sparse-checkout-cone-mode: false'));
  const patterns = checkout.match(/sparse-checkout: \|\n((?:            .+\n?)+)/)![1].split('\n').map(line => line.trim()).filter(Boolean);
  const levels = ['requirements', 'architecture', 'plan', 'code'].map(level => `skills/agentic-review/references/levels/${level}.md`);
  const codeMethods = [...['alignment', 'security', 'reliability', 'performance'].map(name => `skills/agentic-review/references/focuses/${name}.md`), 'skills/agentic-review/references/levels/code/behavior.md'];
  const production = ['central/review-rules.md', 'skills/agentic-review/SKILL.md', ...['protocol', 'findings', 'review-state', 'evidence-access'].map(name => `skills/agentic-review/references/${name}.md`), ...levels, ...codeMethods, ...['github-context', 'review-result'].map(name => `central/${name}.md`), '.github/pi-extensions/review-tools.ts', '.github/pi-extensions/review-input.ts', 'scripts/write-review-input.ts', 'scripts/publish-review.ts', 'package.json', 'pnpm-lock.yaml'];
  const maintenance = ['.agents/skills/darwin-skill/SKILL.md', 'evals/evaluate.ts', 'evals/experiments/example/notes.md', 'AGENTS.md', 'README.md'];
  for (const file of production) await f.write(file, `PRODUCTION ${file}\n`);
  for (const file of maintenance) await f.write(file, 'DARWIN_MAINTENANCE_SENTINEL\n');
  f.git('add', '.'); f.git('commit', '-qm', 'runtime fixture');
  const workspace = path.join(f.root, 'workspace');
  await mkdir(workspace);
  execFileSync('git', ['clone', '-q', '--no-checkout', f.root, path.join(workspace, 'control')]);
  execFileSync('git', ['sparse-checkout', 'set', '--no-cone', '--stdin'], { cwd: path.join(workspace, 'control'), input: `${patterns.join('\n')}\n` });
  execFileSync('git', ['checkout', '-q'], { cwd: path.join(workspace, 'control') });
  for (const file of production) await access(path.join(workspace, 'control', file));
  for (const file of maintenance) await assert.rejects(access(path.join(workspace, 'control', file)));
  const prompt = await loadReviewPrompt(path.join(workspace, 'control'));
  assert.ok(prompt.includes('PRODUCTION skills/agentic-review/SKILL.md'));
  assert.ok(prompt.includes('PRODUCTION skills/agentic-review/references/levels/code.md'));
  for (const file of codeMethods) assert.ok(prompt.includes(`PRODUCTION ${file}`));
  for (const file of levels.filter(file => !file.endsWith('/code.md'))) assert.ok(!prompt.includes(`PRODUCTION ${file}`));
  assert.ok(!prompt.includes('DARWIN_MAINTENANCE_SENTINEL'));
});

test('production Pi runtime enables bounded provider retries and one-hour review', async () => {
  const workflow = await readFile(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8');
  const runtime = workflow.split('      - name: Configure Pi runtime\n')[1].split('\n      - name:')[0];
  assert.match(runtime, /cat > "\$HOME\/\.pi\/agent\/settings\.json"/);
  assert.match(runtime, /"enabled": false/);
  assert.match(runtime, /"maxRetries": 3[\s\S]*"maxRetryDelayMs": 120000/);

  const assertReviewTimeouts = (source: string) => {
    const reviewJob = (parse(source) as {
      jobs?: { review?: { 'timeout-minutes'?: number; steps?: Array<{ id?: string; 'timeout-minutes'?: number }> } };
    }).jobs?.review;
    assert.ok(reviewJob, 'review job must exist');
    assert.equal(reviewJob['timeout-minutes'], 75);

    const piStep = reviewJob.steps?.find(step => step.id === 'pi-review');
    assert.ok(piStep, 'pi-review step must exist');
    assert.equal(piStep['timeout-minutes'], 60);
  };

  assertReviewTimeouts(workflow);
  const reordered = [
    'jobs:',
    '  review:',
    '    timeout-minutes: 75 # 为结果上传预留时间',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - timeout-minutes: 60 # Agent 审查时间',
    '        id: pi-review',
    '  publish:',
    '    timeout-minutes: 10',
  ].join('\n');
  assertReviewTimeouts(reordered);
  assert.throws(() => assertReviewTimeouts(reordered.replace('timeout-minutes: 75', 'timeout-minutes: 74')));
  assert.throws(() => assertReviewTimeouts(reordered.replace('timeout-minutes: 60', 'timeout-minutes: 59')));
});
