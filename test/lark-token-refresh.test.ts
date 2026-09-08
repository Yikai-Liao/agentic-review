import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeLarkUser, larkScopes, refreshLarkUserToken } from '../scripts/refresh-lark-user-token.ts';

const input = {
  appId: 'cli_app',
  appSecret: 'app-secret',
  refreshToken: 'refresh-old',
  repository: 'owner/repo',
};

test('rotates the single-use refresh token before publishing the access token', async () => {
  let request: RequestInit | undefined;
  const saved: Array<[string, string, string, string]> = [];
  const masked: string[] = [];
  const result = await refreshLarkUserToken(input, {
    fetchImpl: async (_url, init) => {
      request = init;
      return Response.json({
        code: 0,
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 7200,
        refresh_token_expires_in: 2592000,
      });
    },
    setSecret: async (repository, environment, name, value) => { saved.push([repository, environment, name, value]); },
    mask: (value) => masked.push(value),
  });

  assert.deepEqual(JSON.parse(String(request?.body)), {
    grant_type: 'refresh_token',
    refresh_token: 'refresh-old',
    client_id: 'cli_app',
    client_secret: 'app-secret',
  });
  assert.deepEqual(saved, [
    ['owner/repo', 'lark-rotation', 'AGENTIC_REVIEW_LARK_REFRESH_TOKEN', 'refresh-new'],
    ['owner/repo', 'lark-review', 'AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN', 'access-new'],
  ]);
  assert.deepEqual(masked, ['access-new', 'refresh-new']);
  assert.deepEqual(result, { expiresIn: 7200, refreshExpiresIn: 2592000 });
});

test('retries persistence of a newly rotated refresh token', async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await refreshLarkUserToken(input, {
    fetchImpl: async () => Response.json({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
    }),
    setSecret: async (_repository, _environment, name) => {
      if (name === 'AGENTIC_REVIEW_LARK_REFRESH_TOKEN' && attempts++ === 0) throw new Error('temporary failure');
    },
    mask: () => {},
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('authorizes one user through device flow and stores both tokens', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const messages: string[] = [];
  const saved: string[] = [];
  const sleeps: number[] = [];
  const responses = [
    Response.json({
      device_code: 'device-code',
      verification_uri_complete: 'https://accounts.feishu.cn/device?code=1234',
      expires_in: 240,
      interval: 1,
    }),
    Response.json({ error: 'authorization_pending' }),
    Response.json({ error: 'slow_down' }),
    Response.json({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_in: 7200,
      refresh_token_expires_in: 2592000,
    }),
  ];
  await authorizeLarkUser(input, {
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body) });
      return responses.shift()!;
    },
    setSecret: async (_repository, _environment, name) => { saved.push(name); },
    mask: () => {},
    log: (message) => messages.push(message),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });

  assert.equal(requests[0].url, 'https://accounts.feishu.cn/oauth/v1/device_authorization');
  assert.equal(new URLSearchParams(requests[0].body).get('scope'), larkScopes);
  assert.equal(requests[1].url, 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
  assert.match(messages[0], /accounts\.feishu\.cn\/device/);
  assert.deepEqual(sleeps, [1000, 1000, 6000]);
  assert.deepEqual(saved, [
    'AGENTIC_REVIEW_LARK_REFRESH_TOKEN',
    'AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN',
  ]);
});

test('does not update secrets when refresh fails', async () => {
  let writes = 0;
  await assert.rejects(refreshLarkUserToken(input, {
    fetchImpl: async () => Response.json({ code: 20073, msg: 'refresh token already consumed' }),
    setSecret: async () => { writes += 1; },
    mask: () => {},
  }), /already consumed/);
  assert.equal(writes, 0);
});

test('fails without publishing UAT or consuming refresh again when persistence is exhausted', async () => {
  let requests = 0;
  const writes: string[] = [];
  await assert.rejects(refreshLarkUserToken(input, {
    fetchImpl: async () => {
      requests += 1;
      return Response.json({ access_token: 'access-new', refresh_token: 'refresh-new' });
    },
    setSecret: async (_repository, _environment, name) => {
      writes.push(name);
      throw new Error('secret storage unavailable');
    },
    mask: () => {},
    sleep: async () => {},
  }), /secret storage unavailable/);
  assert.equal(requests, 1);
  assert.deepEqual(writes, Array(5).fill('AGENTIC_REVIEW_LARK_REFRESH_TOKEN'));
});
