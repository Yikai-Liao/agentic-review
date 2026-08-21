import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type AppInput = {
  appId: string;
  appSecret: string;
  repository: string;
};

type RefreshInput = AppInput & { refreshToken: string };

type Dependencies = {
  fetchImpl?: typeof fetch;
  setSecret?: (repository: string, name: string, value: string) => Promise<void>;
  mask?: (value: string) => void;
  log?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
  code?: unknown;
  error?: unknown;
  error_description?: unknown;
  msg?: unknown;
};

type DeviceResponse = TokenResponse & {
  device_code?: unknown;
  verification_uri_complete?: unknown;
  verification_uri?: unknown;
  interval?: unknown;
  expires_in?: unknown;
};

const tokenEndpoint = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const deviceEndpoint = 'https://accounts.feishu.cn/oauth/v1/device_authorization';
export const larkScopes = [
  'offline_access',
  'search:docs:read',
  'docx:document:readonly',
  'wiki:node:retrieve',
  'drive:drive.metadata:readonly',
  'base:app:read',
  'base:table:read',
  'base:field:read',
  'base:record:read',
].join(' ');

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function setSecret(repository: string, name: string, value: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('gh', ['secret', 'set', name, '--repo', repository], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`gh secret set ${name} failed: ${code}`)));
    child.stdin.end(value);
  });
}

function parseTokens(response: Response, body: TokenResponse) {
  if (!response.ok || (body.code !== undefined && body.code !== 0) || body.error) {
    throw new Error(`Lark OAuth failed: ${String(body.error_description ?? body.msg ?? body.error ?? body.code ?? response.status)}`);
  }
  if (typeof body.access_token !== 'string' || !body.access_token
    || typeof body.refresh_token !== 'string' || !body.refresh_token) {
    throw new Error('Lark OAuth returned no access_token or refresh_token');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : null,
    refreshExpiresIn: typeof body.refresh_token_expires_in === 'number' ? body.refresh_token_expires_in : null,
  };
}

async function publishTokens(
  repository: string,
  tokens: ReturnType<typeof parseTokens>,
  { setSecret: save = setSecret, mask = (value) => console.log(`::add-mask::${value}`) }: Dependencies,
) {
  mask(tokens.accessToken);
  mask(tokens.refreshToken);
  await save(repository, 'AGENTIC_REVIEW_LARK_REFRESH_TOKEN', tokens.refreshToken);
  await save(repository, 'AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN', tokens.accessToken);
  return { expiresIn: tokens.expiresIn, refreshExpiresIn: tokens.refreshExpiresIn };
}

export async function refreshLarkUserToken(
  { appId, appSecret, refreshToken, repository }: RefreshInput,
  dependencies: Dependencies = {},
) {
  const response = await (dependencies.fetchImpl ?? fetch)(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appId,
      client_secret: appSecret,
    }),
  });
  return publishTokens(repository, parseTokens(response, await response.json() as TokenResponse), dependencies);
}

export async function authorizeLarkUser(
  { appId, appSecret, repository }: AppInput,
  dependencies: Dependencies = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const log = dependencies.log ?? console.log;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const authorization = await fetchImpl(deviceEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ client_id: appId, scope: larkScopes }),
  });
  const device = await authorization.json() as DeviceResponse;
  if (!authorization.ok || device.error || typeof device.device_code !== 'string') {
    throw new Error(`Lark device authorization failed: ${String(device.error_description ?? device.error ?? authorization.status)}`);
  }
  const verificationUrl = device.verification_uri_complete ?? device.verification_uri;
  if (typeof verificationUrl !== 'string' || !verificationUrl) throw new Error('Lark device authorization returned no verification URL');
  log(`Open this URL now to authorize the Review user: ${verificationUrl}`);

  const interval = typeof device.interval === 'number' && device.interval > 0 ? device.interval : 5;
  const expiresIn = typeof device.expires_in === 'number' && device.expires_in > 0 ? device.expires_in : 240;
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: appId,
        client_secret: appSecret,
      }),
    });
    const body = await response.json() as TokenResponse;
    if (body.error === 'authorization_pending') continue;
    return publishTokens(repository, parseTokens(response, body), dependencies);
  }
  throw new Error('Lark device authorization expired');
}

export async function main() {
  const app = {
    appId: required(process.env.LARK_APP_ID, 'LARK_APP_ID'),
    appSecret: required(process.env.LARK_APP_SECRET, 'LARK_APP_SECRET'),
    repository: required(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'),
  };
  const result = process.env.LARK_AUTHORIZE === 'true'
    ? await authorizeLarkUser(app)
    : await refreshLarkUserToken({
      ...app,
      refreshToken: required(process.env.LARK_REFRESH_TOKEN, 'LARK_REFRESH_TOKEN'),
    });
  console.log(`Lark user token ready; access expires in ${result.expiresIn ?? 'unknown'}s, refresh expires in ${result.refreshExpiresIn ?? 'unknown'}s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
