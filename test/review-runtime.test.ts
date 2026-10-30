import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

function readReviewWorkflow() {
  const entryUrl = new URL('../.github/workflows/agentic-review.yml', import.meta.url);
  const entrySource = readFileSync(entryUrl, 'utf8');
  const entry = parse(entrySource);
  // 检查实际执行体；入口只负责调用 reusable workflow 时也不能漏掉凭据注入。
  const execution = entry.jobs.review.uses;
  const source = execution
    ? readFileSync(new URL(`../${execution}`, import.meta.url), 'utf8')
    : entrySource;
  return { source, workflow: parse(source) };
}

function assertAgentCredentials(workflow: any) {
  const review = workflow.jobs.review;
  const agent = review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  assert.ok(agent);
  const environment = { ...workflow.env, ...review.env, ...agent.env };

  function assertSafeSource(value: unknown, ancestors = new Set<string>()) {
    const expressions = String(value).match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
    for (const expression of expressions) {
      assert.doesNotMatch(expression, /\bsecrets\s*(?:\.|\[)/i, 'unapproved Agent secret source');
      const normalized = expression.replace(/\s/g, '').replace(/\[['"]([^'"]+)['"]\]/g, '.$1');
      for (const reference of normalized.matchAll(/steps\.([\w-]+)\.outputs\.[\w-]+/gi)) {
        const id = reference[1];
        assert.ok(!ancestors.has(id), 'cyclic Agent output source');
        const producer = review.steps.find((step: { id?: string }) => step.id === id);
        assert.ok(producer, 'unknown Agent output source');
        if (producer.uses?.startsWith('actions/create-github-app-token@')) {
          const permissions = Object.entries(producer.with).filter(([key]) => key.startsWith('permission-'));
          assert.ok(permissions.length > 0, 'Agent token permissions must be explicit');
          assert.ok(permissions.every(([, permission]) => permission === 'read'), 'Agent token must be read-only');
          continue;
        }
        // 输出可以任意改名；检查生产步骤的输入，不能靠 output 名称判断是否为凭据。
        const path = new Set([...ancestors, id]);
        for (const fields of [producer.env, producer.with, { run: producer.run }]) {
          for (const input of Object.values(fields ?? {})) assertSafeSource(input, path);
        }
      }
    }
  }

  for (const [location, fields] of [['env', environment], ['with', agent.with]] as const) {
    for (const [name, value] of Object.entries(fields)) {
      // 唯一允许直接传入的 Secret 是模型 API key，与变量取名无关。
      if (location === 'with' && name === 'token') {
        assert.match(String(value).replace(/\s/g, ''), /^\$\{\{secrets(?:\.REVIEW_AGENT_API_KEY|\[['"]REVIEW_AGENT_API_KEY['"]\])\}\}$/i);
      } else {
        assertSafeSource(value);
      }
    }
  }
  assert.equal(environment.GH_TOKEN, '${{ steps.read-token.outputs.token }}');
  assert.equal(agent.with.github_token, '${{ steps.read-token.outputs.token }}');
}

test('central Review starts without Lark tools, credentials or a rotation dependency', () => {
  const { source, workflow } = readReviewWorkflow();
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'review']);
  assert.equal(workflow.jobs.review.needs, undefined);
  assert.equal(workflow.jobs.review.environment, undefined);
  assert.doesNotMatch(source, /LARKSUITE_|AGENTIC_REVIEW_LARK_|lark-cli/);
  const agent = workflow.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  assert.ok(agent);
  assertAgentCredentials(workflow);
  assert.equal(workflow.jobs.publish.needs, 'review');
  // 本地操作手册仍从可信执行配置取得归档 pin，暂停 Agent 准备不应破坏恢复入口。
  assert.match(workflow.env.LARK_CLI_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(workflow.env.LARK_CLI_SHA256_LINUX_AMD64, /^[0-9a-f]{64}$/);
});

test('Agent credential checks reject renamed secrets in inherited env and action inputs', () => {
  const { workflow } = readReviewWorkflow();
  for (const level of ['workflow', 'job', 'step', 'input']) {
    const changed = structuredClone(workflow);
    const review = changed.jobs.review;
    const agent = review.steps.find((step: { id?: string }) => step.id === 'pi-review');
    const target = level === 'workflow' ? (changed.env ??= {})
      : level === 'job' ? (review.env ??= {})
      : level === 'step' ? (agent.env ??= {}) : agent.with;
    target.FEISHU_USER_TOKEN = "${{ secrets['FEISHU_USER_ACCESS_TOKEN'] }}";
    assert.throws(() => assertAgentCredentials(changed), level);
  }
  // 写令牌经步骤输出转交、或现有 token 被放宽权限，同样必须失败。
  const writeToken = structuredClone(workflow);
  const agent = writeToken.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  const publicationToken = workflow.jobs.publish.steps.find((step: { id?: string }) => step.id === 'publication-token');
  writeToken.jobs.review.steps.unshift(structuredClone(publicationToken));
  agent.env.EXTRA_TOKEN = '${{ steps.publication-token.outputs.token }}';
  assert.throws(() => assertAgentCredentials(writeToken), /read-only/);
  const source = '${{ steps.publication-token.outputs.token }}';
  for (const relay of [
    { env: { FORWARDED: source }, run: 'echo "publication_token=$FORWARDED" >> "$GITHUB_OUTPUT"' },
    { uses: 'actions/github-script@v9.0.0', with: { script: `core.setOutput('publication_token', '${source}');` } },
    { run: `echo "publication_token=${source}" >> "$GITHUB_OUTPUT"` },
  ]) {
    const forwarded = structuredClone(writeToken);
    forwarded.jobs.review.steps.unshift({ id: 'forward-token', ...relay });
    const forwardedAgent = forwarded.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
    forwardedAgent.env.EXTRA_TOKEN = "${{ steps['forward-token'].outputs['publication_token'] }}";
    assert.throws(() => assertAgentCredentials(forwarded), /read-only/);
  }
  const widened = structuredClone(workflow);
  widened.jobs.review.steps.find((step: { id?: string }) => step.id === 'read-token').with['permission-contents'] = 'write';
  assert.throws(() => assertAgentCredentials(widened), /read-only/);
  const harmless = structuredClone(workflow);
  harmless.jobs.review.steps.unshift({
    id: 'forward-read-token',
    env: { FORWARDED: '${{ steps.read-token.outputs.token }}' },
    run: 'echo "value=$FORWARDED" >> "$GITHUB_OUTPUT"',
  });
  const harmlessAgent = harmless.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  harmlessAgent.env.REVIEW_DIAGNOSTICS = 'enabled';
  harmlessAgent.env.EXTRA_TOKEN = '${{ steps.forward-read-token.outputs.value }}';
  assert.doesNotThrow(() => assertAgentCredentials(harmless));
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
  const assertTriggers = (types: string[]) => assert.deepEqual(new Set(types), new Set(['authorize-lark-user', 'refresh-lark-user']));
  assertTriggers(workflow.on.repository_dispatch.types);
  assertTriggers(['refresh-lark-user', 'authorize-lark-user']);
  assert.throws(() => assertTriggers(['authorize-lark-user']));
  assert.throws(() => assertTriggers(['refresh-lark-user']));
  const refresh = workflow.jobs.refresh;
  assert.equal(refresh.environment, 'lark-rotation');
  assert.equal(refresh.concurrency['cancel-in-progress'], false);
  const rotate = refresh.steps.find((step: { run?: string }) => step.run === 'node scripts/refresh-lark-user-token.ts');
  assert.ok(rotate);
  assert.equal(rotate.env.LARK_REFRESH_TOKEN, '${{ secrets.AGENTIC_REVIEW_LARK_REFRESH_TOKEN }}');
  assert.equal(rotate.env.LARK_APP_SECRET, '${{ secrets.AGENTIC_REVIEW_LARK_APP_SECRET }}');
});
