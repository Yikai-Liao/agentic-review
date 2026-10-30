import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

test('central Review starts without Lark tools, credentials or a rotation dependency', () => {
  const entryUrl = new URL('../.github/workflows/agentic-review.yml', import.meta.url);
  const entrySource = readFileSync(entryUrl, 'utf8');
  const entry = parse(entrySource);
  // 检查实际执行体；入口只负责调用 reusable workflow 时也不能漏掉凭据注入。
  const execution = entry.jobs.review.uses;
  const source = execution
    ? readFileSync(new URL(`../${execution}`, import.meta.url), 'utf8')
    : entrySource;
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'review']);
  assert.equal(workflow.jobs.review.needs, undefined);
  assert.equal(workflow.jobs.review.environment, undefined);
  assert.doesNotMatch(source, /LARKSUITE_|AGENTIC_REVIEW_LARK_|lark-cli/);
  const agent = workflow.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  assert.ok(agent);
  assert.equal(agent.env.GH_TOKEN, '${{ steps.read-token.outputs.token }}');
  assert.equal(workflow.jobs.publish.needs, 'review');
  // 本地操作手册仍从可信执行配置取得归档 pin，暂停 Agent 准备不应破坏恢复入口。
  assert.match(workflow.env.LARK_CLI_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(workflow.env.LARK_CLI_SHA256_LINUX_AMD64, /^[0-9a-f]{64}$/);
});

test('Lark token rotation remains scheduled and isolated from the Review Agent', () => {
  const source = readFileSync(new URL('../.github/workflows/lark-token-refresh.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  const assertHourly = (schedule: Array<{ cron: string }>) => {
    assert.equal(schedule.length, 1);
    // 每小时一次，分钟可调整；每天一次和每小时多次都不满足续期约定。
    assert.match(schedule[0].cron, /^(?:[0-5]?\d) \* \* \* \*$/);
  };
  assertHourly(workflow.on.schedule);
  assertHourly([{ cron: '43 * * * *' }]);
  assert.throws(() => assertHourly([{ cron: '17 0 * * *' }]));
  assert.throws(() => assertHourly([{ cron: '*/30 * * * *' }]));
  assert.deepEqual(workflow.on.repository_dispatch.types, ['authorize-lark-user', 'refresh-lark-user']);
  const refresh = workflow.jobs.refresh;
  assert.equal(refresh.environment, 'lark-rotation');
  assert.equal(refresh.concurrency['cancel-in-progress'], false);
  const rotate = refresh.steps.find((step: { run?: string }) => step.run === 'node scripts/refresh-lark-user-token.ts');
  assert.ok(rotate);
  assert.equal(rotate.env.LARK_REFRESH_TOKEN, '${{ secrets.AGENTIC_REVIEW_LARK_REFRESH_TOKEN }}');
  assert.equal(rotate.env.LARK_APP_SECRET, '${{ secrets.AGENTIC_REVIEW_LARK_APP_SECRET }}');
});
