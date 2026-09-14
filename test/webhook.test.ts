import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryDeduplicator, commentMention, deploymentConfig, shouldDispatch, shouldDispatchComment, validBotMention, verifySignature } from '../worker/src/index.ts';

const payload = {
  action: 'opened',
  repository: { id: 1, full_name: 'Example-Org/example', owner: { login: 'Example-Org' } },
  pull_request: {
    number: 2,
    draft: false,
    base: { sha: 'base' },
    head: { sha: 'head' },
  },
};

test('reads organization and control repository from deployment configuration', () => {
  assert.deepEqual(deploymentConfig({
    CONTROL_REPOSITORY: 'Another-Org/review-engine',
    CONTROL_WORKFLOW_REF: 'stable',
    ALLOWED_OWNER: 'Target-Org',
  }), {
    allowedOwner: 'Target-Org',
    controlOwner: 'Another-Org',
    controlRepository: 'review-engine',
    controlFullName: 'Another-Org/review-engine',
    workflowRef: 'stable',
  });
});

test('dispatches accepted organization pull request events, including drafts', () => {
  assert.equal(shouldDispatch(payload, 'Example-Org'), true);
  assert.equal(shouldDispatch({ ...payload, action: 'closed' }, 'Example-Org'), false);
  assert.equal(shouldDispatch({ ...payload, pull_request: { ...payload.pull_request, draft: true } }, 'Example-Org'), true);
  assert.equal(shouldDispatch({ ...payload, action: 'converted_to_draft', pull_request: { ...payload.pull_request, draft: true } }, 'Example-Org'), true);
  assert.equal(shouldDispatch(payload, 'Different-Org'), false);
});

test('claims each webhook delivery atomically until released', async () => {
  const values = new Map<string, unknown>();
  const deduplicator = new DeliveryDeduplicator({
    storage: {
      transaction: async (callback) => callback({
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
      }),
      setAlarm: async () => {},
      deleteAll: async () => { values.clear(); },
    },
  });
  const claim = () => deduplicator.fetch(new Request('https://delivery/claim', { method: 'POST' }));
  assert.equal((await claim()).status, 201);
  assert.equal((await claim()).status, 409);
  assert.equal((await deduplicator.fetch(new Request('https://delivery/claim', { method: 'DELETE' }))).status, 204);
  assert.equal((await claim()).status, 201);
});

test('verifies GitHub webhook signatures', async () => {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const signature = `sha256=${Buffer.from(digest).toString('hex')}`;
  assert.equal(await verifySignature(body, signature, 'secret'), true);
  assert.equal(await verifySignature(body, signature, 'wrong'), false);
});

test('accepts real mentions and rejects quoted/code examples and bot loops', () => {
  assert.equal(commentMention('请 @review-app[bot] 复核', '@review-app[bot]'), true);
  assert.equal(commentMention('`@review-app[bot]`\n> @review-app[bot]', '@review-app[bot]'), false);
  const comment = {
    action: 'created',
    repository: payload.repository,
    issue: { number: 2, pull_request: { url: 'https://api.github.test/repos/Example-Org/example/pulls/2' } },
    comment: { id: 11, body: '@review-app', user: { login: 'human', type: 'User' } },
  } as any;
  assert.equal(shouldDispatchComment(comment, 'Example-Org', '@review-app', 'issue_comment'), true);
  assert.equal(shouldDispatchComment({ ...comment, comment: { ...comment.comment, user: { login: 'review-app[bot]', type: 'Bot' } } }, 'Example-Org', '@review-app', 'issue_comment'), false);
  assert.equal(validBotMention('@review-app[bot]'), true);
  assert.equal(validBotMention('review-app'), false);
});


test('mentions inside fenced code remain ignored through EOF and mismatched closing fences', () => {
  const mention = '@review-app';
  for (const body of [
    '```text\n@review-app',
    '~~~\n@review-app',
    '````\n```\n@review-app\n````',
    '```\n~~~\n@review-app',
    '   ~~~text\r\n@review-app',
    '```\n```still code\n@review-app',
  ]) assert.equal(commentMention(body, mention), false, body);
  for (const body of [
    '```\nexample\n```\n@review-app',
    '~~~\nexample\n~~~~\n@review-app',
    '@review-app\n```\nexample',
    '> ```\n@review-app',
  ]) assert.equal(commentMention(body, mention), true, body);
});
