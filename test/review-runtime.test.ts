import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import { parse } from 'yaml';

function readReviewWorkflow() {
  const entryUrl = new URL('../.github/workflows/agentic-review.yml', import.meta.url);
  const entrySource = readFileSync(entryUrl, 'utf8');
  const entry = parse(entrySource);
  // Check the actual executor; credential injection must not be missed when the entry only calls a reusable workflow.
  const execution = entry.jobs.review.uses;
  const source = execution
    ? readFileSync(new URL(`../${execution}`, import.meta.url), 'utf8')
    : entrySource;
  return { source, workflow: parse(source) };
}

test('The full Pi JSONL is archived after success, failure, and cancellation without relying on the success export path', () => {
  const { workflow } = readReviewWorkflow();
  const steps = workflow.jobs.review.steps;
  const agent = steps.find((step: any) => step.id === 'pi-review');
  const archive = steps.find((step: any) => step.id === 'review-session');
  assert.equal(agent.with.export_session_jsonl, true, 'Enabling export makes the Action use the persisted SessionManager');
  assert.notEqual(agent.with.share_session, true);
  assert.deepEqual(archive.with.path.trim().split('\n'), [
    '~/.pi/agent/sessions/**/*.jsonl',
    '~/.pi/agent/sessions/**/pi-fold-evidence/**',
  ]);
  assert.equal(archive.with['include-hidden-files'], true);
  assert.equal(archive.with['if-no-files-found'], 'error');
  assert.equal(archive.with['retention-days'], 7);
  assert.ok(steps.indexOf(archive) > steps.indexOf(agent));
  const expression = archive.if.replace(/^\$\{\{|\}\}$/g, '').replace(/always\(\)/g, 'true');
  const parsed = new Parser(new Lexer(expression).lex().tokens, ['steps'], []).parse();
  for (const [outcome, expected] of [['success', true], ['failure', true], ['cancelled', true], ['skipped', false], ['', false]]) {
    const context = JSON.parse(JSON.stringify({ steps: { 'pi-review': { outcome } } }), data.reviver);
    const result = new Evaluator(parsed, context).evaluate();
    assert.ok(result instanceof data.BooleanData);
    assert.equal(result.value, expected, `Archive condition: ${outcome}`);
  }
});

function assertAgentCredentials(workflow: any) {
  const review = workflow.jobs.review;
  // Actions can read github.token directly; job permissions override the workflow, so repository defaults are not relied on.
  // https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions
  const permissions = review.permissions ?? workflow.permissions;
  assert.ok(permissions === 'read-all' || (permissions && typeof permissions === 'object'
    && Object.values(permissions).every(permission => permission === 'read' || permission === 'none')),
  'Review GITHUB_TOKEN must be explicitly read-only');
  const agent = review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  assert.ok(agent);
  const environment = { ...workflow.env, ...review.env, ...agent.env };
  const normalizeReference = (value: unknown) => String(value)
    .replace(/\[['"]([^'"]+)['"]\]/g, '.$1').replace(/\s/g, '');

  function assertSafeSource(value: unknown, ancestors = new Set<string>()) {
    const expressions = String(value).match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
    for (const expression of expressions) {
      const normalized = normalizeReference(expression).replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
      assert.doesNotMatch(normalized, /(?<![\w.])secrets\b/i, 'unapproved Agent secret source');
      // Configuration variables can hold tokens too; only sources agreed to be non-sensitive are allowed, never guessed from env names.
      const variables = /(?<![\w.])vars\.([\w-]+)/gi;
      for (const reference of normalized.matchAll(variables)) {
        assert.ok(['REVIEW_AGENT_MODEL', 'REVIEW_AGENT_BASE_URL', 'REVIEW_THINKING_LEVEL', 'REVIEW_FAST_MODE', 'REVIEW_LANGUAGE'].includes(reference[1].toUpperCase()),
          'unapproved Agent variable source');
      }
      assert.doesNotMatch(normalized.replace(variables, ''), /(?<![\w.])vars\b/i, 'unapproved Agent variable source');
      const outputReference = /(?<![\w.])steps\.([\w-]+)\.outputs\.[\w-]+/gi;
      // Whole or dynamic step contexts may contain write tokens; only traceable outputs and credential-free status fields are accepted.
      const otherReferences = normalized.replace(outputReference, '')
        .replace(/(?<![\w.])steps\.[\w-]+\.(?:outcome|conclusion)\b/gi, '');
      assert.doesNotMatch(otherReferences, /(?<![\w.])steps\b/i, 'Agent step source must name a specific output');
      for (const reference of normalized.matchAll(outputReference)) {
        const id = reference[1];
        assert.ok(!ancestors.has(id), 'cyclic Agent output source');
        const producer = review.steps.find((step: { id?: string }) => step.id === id);
        assert.ok(producer, 'unknown Agent output source');
        if (producer.uses?.startsWith('actions/create-github-app-token@')) {
          assert.equal(normalizeReference(producer.with.owner), '${{steps.target.outputs.owner}}', 'Agent token must remain in the target owner');
          assert.equal(normalizeReference(producer.with['client-id']), '${{vars.AGENTIC_REVIEW_CLIENT_ID}}', 'Agent token must use the Review App');
          assert.equal(normalizeReference(producer.with['private-key']), '${{secrets.AGENTIC_REVIEW_APP_PRIVATE_KEY}}', 'Agent token must use the Review App');
          const permissions = Object.entries(producer.with).filter(([key]) => key.startsWith('permission-'));
          assert.ok(permissions.length > 0, 'Agent token permissions must be explicit');
          assert.ok(permissions.every(([, permission]) => permission === 'read'), 'Agent token must be read-only');
          continue;
        }
        // Outputs can be renamed freely; check the producing step's inputs instead of judging credentials by output name.
        const path = new Set([...ancestors, id]);
        for (const fields of [producer.env, producer.with, { run: producer.run }]) {
          for (const input of Object.values(fields ?? {})) assertSafeSource(input, path);
        }
      }
    }
  }

  for (const [location, fields] of [['env', environment], ['with', agent.with]] as const) {
    for (const [name, value] of Object.entries(fields)) {
      // The only secret allowed directly is the model API key, regardless of variable naming.
      if (location === 'with' && name === 'token') {
        assert.match(String(value).replace(/\s/g, ''), /^\$\{\{secrets(?:\.REVIEW_AGENT_API_KEY|\[['"]REVIEW_AGENT_API_KEY['"]\])\}\}$/i);
      } else {
        assertSafeSource(value);
      }
    }
  }
  assert.equal(normalizeReference(environment.GH_TOKEN), '${{steps.read-token.outputs.token}}');
  assert.equal(normalizeReference(agent.with.github_token), '${{steps.read-token.outputs.token}}');
}

test('central Review starts without Lark tools, credentials or a rotation dependency', () => {
  const { source, workflow } = readReviewWorkflow();
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['review']);
  assert.equal(workflow.jobs.review.needs, undefined);
  assert.equal(workflow.jobs.review.environment, undefined);
  assert.doesNotMatch(source, /LARKSUITE_|AGENTIC_REVIEW_LARK_|lark-cli/);
  const agent = workflow.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  assert.ok(agent);
  assertAgentCredentials(workflow);
  // The local runbook still takes the archive pin from the trusted execution config; pausing agent preparation must not break the restore entry.
  assert.match(workflow.env.LARK_CLI_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(workflow.env.LARK_CLI_SHA256_LINUX_AMD64, /^[0-9a-f]{64}$/);
});


test('Publication mints a separate token after the agent ends, restores trusted scripts and sealed context, and reuses the local result', () => {
  const { workflow } = readReviewWorkflow();
  const steps = workflow.jobs.review.steps;
  const index = (id: string) => steps.findIndex((step: { id?: string }) => step.id === id);
  const step = (id: string) => steps[index(id)];
  assert.ok(index('pi-review') < index('publication-token'));
  assert.ok(index('publication-token') < index('publish-review'));
  assert.ok(index('review-context') < index('pi-review'));
  const checkouts = steps.filter((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.ref, '${{ github.sha }}');
  assert.equal(checkouts[0].with['persist-credentials'], false);
  assert.equal(checkouts[0].with.path, 'control');
  assert.equal(step('publish-review').env.REVIEW_CONTEXT_DIGEST, '${{ steps.review-context.outputs.context_digest }}');
  assert.equal(step('publish-review').env.REVIEW_CONTEXT_PATH, '${{ runner.temp }}/review-context/review-context.json');
  assert.equal(step('review-context').run, 'node control/scripts/prepare-review-context.ts');
  assert.equal(step('publish-review').env.REVIEW_PROGRESS_PATH, '${{ github.workspace }}/review-workspace/review-progress.json');
  assert.equal(step('publish-review').env.REVIEW_PUBLISHER_ARCHIVE, '${{ steps.review-context.outputs.publisher_archive }}');
  assert.equal(step('publish-review').env.REVIEW_RESULT_PATH, step('pi-review').env.REVIEW_RESULT_PATH);
  assert.equal(step('publish-review').env.GH_TOKEN, '${{ steps.publication-token.outputs.token }}');
  const token = step('publication-token').with;
  assert.equal(token.owner, '${{ steps.target.outputs.owner }}');
  assert.equal(token.repositories, '${{ steps.target.outputs.name }}');
  assert.deepEqual(Object.fromEntries(Object.entries(token).filter(([key]) => key.startsWith('permission-'))), {
    'permission-contents': 'write', 'permission-pull-requests': 'write', 'permission-checks': 'write',
  });
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
    target.FEISHU_USER_TOKEN = "${{ vars['REVIEW_WRITE_TOKEN'] }}";
    assert.throws(() => assertAgentCredentials(changed), /unapproved Agent variable source/, level);
  }
  for (const context of ['secrets', 'steps', 'vars']) {
    const changed = structuredClone(workflow);
    const agent = changed.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
    agent.env.EXTRA_CONTEXT = `\${{ toJSON(${context}) }}`;
    assert.throws(() => assertAgentCredentials(changed), `whole ${context} context contains credentials`);
  }
  // A write token handed over through step output, or an existing token with widened permissions, must fail too.
  const writeToken = structuredClone(workflow);
  const agent = writeToken.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
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
  harmlessAgent.env.DIAGNOSTIC_LABEL = "${{ 'steps and secrets' }}";
  harmlessAgent.env.MODEL_LABEL = "${{ vars['REVIEW_AGENT_MODEL'] }}";
  harmlessAgent.env.API_ENDPOINT = '${{ vars.REVIEW_AGENT_BASE_URL }}';
  harmlessAgent.env.EXTRA_TOKEN = '${{ steps.forward-read-token.outputs.value }}';
  assert.doesNotThrow(() => assertAgentCredentials(harmless));
});

test('read-only Agent tokens stay within the target owner and Review App installation', () => {
  const { workflow } = readReviewWorkflow();
  for (const [key, value] of [
    ['owner', 'other-installed-owner'],
    ['client-id', '${{ vars.OTHER_APP_CLIENT_ID }}'],
    ['private-key', '${{ secrets.OTHER_APP_PRIVATE_KEY }}'],
  ]) {
    const changed = structuredClone(workflow);
    const token = structuredClone(changed.jobs.review.steps.find((step: { id?: string }) => step.id === 'read-token'));
    token.id = 'extra-read-token';
    token.with[key] = value;
    changed.jobs.review.steps.unshift(token);
    const agent = changed.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
    agent.env.EXTRA_TOKEN = '${{ steps.extra-read-token.outputs.token }}';
    assert.throws(() => assertAgentCredentials(changed), /target owner|Review App/);
  }
  const narrowed = structuredClone(workflow);
  narrowed.jobs.review.steps.find((step: { id?: string }) => step.id === 'read-token')
    .with.repositories = '${{ steps.target.outputs.name }}';
  assert.doesNotThrow(() => assertAgentCredentials(narrowed));
  const indexed = structuredClone(narrowed);
  const indexedToken = indexed.jobs.review.steps.find((step: { id?: string }) => step.id === 'read-token');
  indexedToken.with.owner = "${{ steps['target'].outputs['owner'] }}";
  indexedToken.with['client-id'] = "${{ vars['AGENTIC_REVIEW_CLIENT_ID'] }}";
  indexedToken.with['private-key'] = "${{ secrets['AGENTIC_REVIEW_APP_PRIVATE_KEY'] }}";
  const indexedAgent = indexed.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
  indexedAgent.env.GH_TOKEN = "${{ steps['read-token'].outputs['token'] }}";
  indexedAgent.with.github_token = "${{ steps['read-token'].outputs['token'] }}";
  assert.doesNotThrow(() => assertAgentCredentials(indexed));
});

test('Review workflow token remains read-only after workflow and job permission changes', () => {
  const { workflow } = readReviewWorkflow();
  for (const level of ['workflow', 'job']) {
    for (const permissions of ['write-all', { contents: 'write' }]) {
      const changed = structuredClone(workflow);
      const target = level === 'workflow' ? changed : changed.jobs.review;
      target.permissions = permissions;
      const agent = changed.jobs.review.steps.find((step: { id?: string }) => step.id === 'pi-review');
      agent.env.EXTRA_TOKEN = '${{ github.token }}';
      assert.throws(() => assertAgentCredentials(changed), /read-only/);
    }
  }
  const scoped = structuredClone(workflow);
  scoped.permissions = 'write-all';
  scoped.jobs.review.permissions = { actions: 'read', contents: 'read' };
  assert.doesNotThrow(() => assertAgentCredentials(scoped));
  scoped.jobs.review.permissions = 'read-all';
  assert.doesNotThrow(() => assertAgentCredentials(scoped));
  delete scoped.jobs.review.permissions;
  delete scoped.permissions;
  assert.throws(() => assertAgentCredentials(scoped), /explicitly read-only/);
});

test('Lark token rotation remains scheduled and isolated from the Review Agent', () => {
  const source = readFileSync(new URL('../.github/workflows/lark-token-refresh.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  const assertHourly = (schedule: Array<{ cron: string }>) => {
    assert.equal(schedule.length, 1);
    // Once an hour with an adjustable minute; daily or several times an hour both break the renewal contract.
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
