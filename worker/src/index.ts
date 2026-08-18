interface DurableObjectTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface DurableObjectStorage {
  transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAll(): Promise<void>;
}

interface DurableObjectState { storage: DurableObjectStorage }
interface DurableObjectStub { fetch(request: Request): Promise<Response> }
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface Env {
  WEBHOOK_SECRET: string;
  DISPATCH_CLIENT_ID: string;
  DISPATCH_PRIVATE_KEY_PKCS8: string;
  CONTROL_REPOSITORY: string;
  CONTROL_WORKFLOW_REF: string;
  ALLOWED_OWNER: string;
  DELIVERIES: DurableObjectNamespace;
}

type PullRequestPayload = {
  action: string;
  installation?: { id: number };
  repository: { id: number; full_name: string; owner: { login: string } };
  pull_request: {
    number: number;
    draft: boolean;
    base: { sha: string };
    head: { sha: string };
  };
};

const acceptedActions = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);
const api = 'https://api.github.com';

type DeploymentConfig = {
  allowedOwner: string;
  controlOwner: string;
  controlRepository: string;
  controlFullName: string;
  workflowRef: string;
};

export default { fetch: handleRequest };

// One Durable Object instance per GitHub delivery serializes replay claims.
export class DeliveryDeduplicator {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'DELETE') {
      await this.state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const claimed = await this.state.storage.transaction(async (transaction) => {
      if (await transaction.get<boolean>('claimed')) return false;
      await transaction.put('claimed', true);
      return true;
    });
    if (!claimed) return new Response(null, { status: 409 });
    try {
      await this.state.storage.setAlarm(Date.now() + 7 * 24 * 60 * 60 * 1000);
    } catch (error) {
      await this.state.storage.deleteAll();
      throw error;
    }
    return new Response(null, { status: 201 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await request.text();
  // Authenticate the raw bytes before parsing attacker-controlled JSON.
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  if (!await verifySignature(body, signature, env.WEBHOOK_SECRET)) return new Response('Invalid signature', { status: 401 });

  const event = request.headers.get('x-github-event');
  if (event === 'ping') return new Response('pong');
  if (event !== 'pull_request') return new Response(null, { status: 204 });

  const config = deploymentConfig(env);
  const payload = JSON.parse(body) as PullRequestPayload;
  if (!shouldDispatch(payload, config.allowedOwner)) return new Response(null, { status: 204 });
  const deliveryId = request.headers.get('x-github-delivery');
  if (!deliveryId) return new Response('Missing delivery id', { status: 400 });

  // Claim before dispatch so concurrent GitHub redeliveries cannot start duplicate workflows.
  const delivery = env.DELIVERIES.get(env.DELIVERIES.idFromName(deliveryId));
  const claim = await delivery.fetch(new Request('https://delivery/claim', { method: 'POST' }));
  if (claim.status === 409) return new Response('Already accepted', { status: 202 });
  if (!claim.ok) return new Response('Delivery claim failed', { status: 502 });

  try {
    await dispatchReview(payload, env, config);
    return new Response('Accepted', { status: 202 });
  } catch (error) {
    try {
      await delivery.fetch(new Request('https://delivery/claim', { method: 'DELETE' }));
    } catch (releaseError) {
      console.error(`Delivery release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
    }
    console.error(error instanceof Error ? error.message : String(error));
    return new Response('Dispatch failed', { status: 502 });
  }
}

export function shouldDispatch(payload: PullRequestPayload, allowedOwner: string): boolean {
  return payload.repository.owner.login.toLowerCase() === allowedOwner.toLowerCase()
    && acceptedActions.has(payload.action)
    && !payload.pull_request.draft;
}

export async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!signature.startsWith('sha256=')) return false;
  const expected = hexToBytes(signature.slice(7));
  if (!expected) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, expected, new TextEncoder().encode(body));
}

async function dispatchReview(payload: PullRequestPayload, env: Env, config: DeploymentConfig): Promise<void> {
  const jwt = await createAppJwt(env.DISPATCH_CLIENT_ID, env.DISPATCH_PRIVATE_KEY_PKCS8);
  const installationsResponse = await githubFetch('/app/installations?per_page=100', {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const installations = await installationsResponse.json() as Array<{ id: number; account: { login: string } }>;
  const installation = installations.find(({ account }) => account.login.toLowerCase() === config.controlOwner.toLowerCase());
  if (!installation) throw new Error(`Dispatcher App is not installed in ${config.controlOwner}`);
  const tokenResponse = await githubFetch(`/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ repositories: [config.controlRepository], permissions: { actions: 'write' } }),
  });
  const { token } = await tokenResponse.json() as { token: string };
  const pr = payload.pull_request;
  await githubFetch(`/repos/${config.controlFullName}/actions/workflows/agentic-review.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ref: config.workflowRef,
      inputs: {
        repository: payload.repository.full_name,
        repository_id: String(payload.repository.id),
        pull_number: String(pr.number),
        base_sha: pr.base.sha,
        head_sha: pr.head.sha,
      },
    }),
  });
}

export function deploymentConfig(
  env: Pick<Env, 'CONTROL_REPOSITORY' | 'CONTROL_WORKFLOW_REF' | 'ALLOWED_OWNER'>,
): DeploymentConfig {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(env.CONTROL_REPOSITORY);
  if (!match) throw new Error('CONTROL_REPOSITORY must be owner/name');
  if (!/^[A-Za-z0-9-]+$/.test(env.ALLOWED_OWNER)) throw new Error('Invalid ALLOWED_OWNER');
  if (!/^[A-Za-z0-9._/-]+$/.test(env.CONTROL_WORKFLOW_REF) || env.CONTROL_WORKFLOW_REF.includes('..')) {
    throw new Error('Invalid CONTROL_WORKFLOW_REF');
  }
  return {
    allowedOwner: env.ALLOWED_OWNER,
    controlOwner: match[1]!,
    controlRepository: match[2]!,
    controlFullName: env.CONTROL_REPOSITORY,
    workflowRef: env.CONTROL_WORKFLOW_REF,
  };
}

// GitHub recommends the App Client ID, rather than the legacy numeric App ID, as JWT iss.
async function createAppJwt(clientId: string, privateKeyPem: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(clientId)) throw new Error('Invalid Dispatcher Client ID');
  if (privateKeyPem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error('Dispatcher private key must be converted from PKCS#1 to PKCS#8');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(privateKeyPem, 'PRIVATE KEY'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function githubFetch(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'qiyin-agentic-review-dispatcher',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response;
}

function pemBytes(pem: string, label: string): ArrayBuffer {
  const base64 = pem
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hexToBytes(hex: string): ArrayBuffer | undefined {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}
