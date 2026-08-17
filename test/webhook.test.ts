import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryDeduplicator, deploymentConfig, shouldDispatch, verifySignature } from '../worker/src/index.ts';

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

test('dispatches only accepted non-draft organization pull requests', () => {
  assert.equal(shouldDispatch(payload, 'Example-Org'), true);
  assert.equal(shouldDispatch({ ...payload, action: 'closed' }, 'Example-Org'), false);
  assert.equal(shouldDispatch({ ...payload, pull_request: { ...payload.pull_request, draft: true } }, 'Example-Org'), false);
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
