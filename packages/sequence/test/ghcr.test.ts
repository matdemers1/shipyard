import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createRegistryAdapter, dockerConfigCredentials } from '../src/adapters/ghcr.js';
import { RefusalError } from '../src/ports.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ghcr');

function loadFixture(name: string): { status: number; headers?: Record<string, string>; body?: unknown } {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

const IMAGE_REPO = 'ghcr.io/matdemers1/shipyard/server';
const TAG = 'sha-30593dd333296f7f9ef5613ea1c211e9f32d310b';
const MISSING_TAG = 'sha-0000000000000000000000000000000000000000';

const www401 = loadFixture('www-authenticate-401');
const tokenFixture = loadFixture('token');
const headManifest = loadFixture('head-manifest');
const indexFixture = loadFixture('index');
const manifestAmd64 = loadFixture('manifest-amd64');
const configBlob = loadFixture('config-blob');
const missing404 = loadFixture('missing-manifest-404');

const RECORDED_DIGEST = headManifest.headers?.['docker-content-digest'] ?? '';
const RECORDED_REVISION = (
  (configBlob.body as { config: { Labels: Record<string, string> } }).config.Labels[
    'org.opencontainers.image.revision'
  ]
);

/** Builds a fake `fetch` that replays the recorded GHCR fixtures for the tag under test. */
function makeFakeFetch(opts: { onTokenFetch?: () => void } = {}) {
  let tokenCalls = 0;
  const fake = vi.fn((input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const hasAuth = new Headers(init?.headers).has('Authorization');

    if (url.startsWith('https://ghcr.io/token')) {
      tokenCalls += 1;
      opts.onTokenFetch?.();
      return jsonResponse(tokenFixture.status, tokenFixture.body, {});
    }

    if (url.includes(`/manifests/${TAG}`) && method === 'HEAD') {
      if (!hasAuth) return emptyResponse(www401.status, www401.headers ?? {});
      return emptyResponse(headManifest.status, headManifest.headers ?? {});
    }

    if (url.includes(`/manifests/${MISSING_TAG}`) && method === 'HEAD') {
      if (!hasAuth) return emptyResponse(www401.status, www401.headers ?? {});
      return emptyResponse(missing404.status, missing404.headers ?? {});
    }

    if (url.includes(`/manifests/${RECORDED_DIGEST}`)) {
      if (!hasAuth) return emptyResponse(www401.status, www401.headers ?? {});
      return jsonResponse(indexFixture.status, indexFixture.body, indexFixture.headers ?? {});
    }

    const amd64Digest = findAmd64Digest(indexFixture.body);
    if (url.includes(`/manifests/${amd64Digest}`)) {
      if (!hasAuth) return emptyResponse(www401.status, www401.headers ?? {});
      return jsonResponse(manifestAmd64.status, manifestAmd64.body, manifestAmd64.headers ?? {});
    }

    const configDigest = (manifestAmd64.body as { config: { digest: string } }).config.digest;
    if (url.includes(`/blobs/${configDigest}`)) {
      if (!hasAuth) return emptyResponse(www401.status, www401.headers ?? {});
      return jsonResponse(configBlob.status, configBlob.body, {});
    }

    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
  return { fake, tokenCalls: () => tokenCalls };
}

function findAmd64Digest(indexBody: unknown): string {
  const manifests = (indexBody as { manifests: { digest: string; platform?: { architecture: string } }[] }).manifests;
  const found = manifests.find((m) => m.platform?.architecture === 'amd64');
  if (found === undefined) throw new Error('fixture index has no amd64 manifest');
  return found.digest;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }),
  );
}

function emptyResponse(status: number, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(new Response(null, { status, headers }));
}

describe('createRegistryAdapter (GHCR)', () => {
  it('resolves the digest to the recorded Docker-Content-Digest', async () => {
    const { fake } = makeFakeFetch();
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch });
    const digest = await adapter.resolveDigest(IMAGE_REPO, TAG);
    expect(digest).toBe(RECORDED_DIGEST);
    expect(RECORDED_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('returns null for a missing tag', async () => {
    const { fake } = makeFakeFetch();
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch });
    const digest = await adapter.resolveDigest(IMAGE_REPO, MISSING_TAG);
    expect(digest).toBeNull();
  });

  it('reads amd64 labels off the index, including the revision label', async () => {
    const { fake } = makeFakeFetch();
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch });
    const digest = await adapter.resolveDigest(IMAGE_REPO, TAG);
    if (digest === null) throw new Error('expected a digest');
    const config = await adapter.imageConfig(IMAGE_REPO, digest);
    expect(config.digest).toBe(digest);
    expect(config.labels['org.opencontainers.image.revision']).toBe(RECORDED_REVISION);
    expect(RECORDED_REVISION).toBe('30593dd333296f7f9ef5613ea1c211e9f32d310b');
  });

  it('fetches the token once and reuses it across two calls', async () => {
    const { fake, tokenCalls } = makeFakeFetch();
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch });
    await adapter.resolveDigest(IMAGE_REPO, TAG);
    await adapter.resolveDigest(IMAGE_REPO, TAG);
    expect(tokenCalls()).toBe(1);
  });

  it('skips auth entirely for a plain-http host', async () => {
    const calls: string[] = [];
    const fake = vi.fn((input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      expect(url.startsWith('http://registry:5000')).toBe(true);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return emptyResponse(200, { 'docker-content-digest': RECORDED_DIGEST });
    });
    const adapter = createRegistryAdapter({
      fetch: fake as unknown as typeof fetch,
      plainHttpHosts: ['registry:5000'],
    });
    const digest = await adapter.resolveDigest('registry:5000/app/server', 'sha-abc');
    expect(digest).toBe(RECORDED_DIGEST);
    expect(calls.length).toBe(1);
  });

  it('refuses with ghcr_unreachable naming the host on a 503', async () => {
    const fake = vi.fn((): Promise<Response> => emptyResponse(503, {}));
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch });
    await expect(adapter.resolveDigest(IMAGE_REPO, TAG)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RefusalError);
      const refusal = (err as RefusalError).refusal;
      expect(refusal.code).toBe('ghcr_unreachable');
      expect(refusal.message).toContain('ghcr.io');
      return true;
    });
  });

  it('refuses with ghcr_unreachable naming the host on a network error', async () => {
    const fake = vi.fn((): Promise<Response> => Promise.reject(new Error('getaddrinfo ENOTFOUND ghcr.io')));
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch });
    await expect(adapter.resolveDigest(IMAGE_REPO, TAG)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RefusalError);
      const refusal = (err as RefusalError).refusal;
      expect(refusal.code).toBe('ghcr_unreachable');
      expect(refusal.message).toContain('ghcr.io');
      return true;
    });
  });

  it('refuses with ghcr_unreachable naming the host on a timeout', async () => {
    const fake = vi.fn(
      (_input: string | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch, timeoutMs: 5 });
    await expect(adapter.resolveDigest(IMAGE_REPO, TAG)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RefusalError);
      const refusal = (err as RefusalError).refusal;
      expect(refusal.code).toBe('ghcr_unreachable');
      expect(refusal.message).toContain('ghcr.io');
      return true;
    });
  });

  it('a null digest becomes a refusal when a caller maps a missing image to image_missing', async () => {
    const { fake } = makeFakeFetch();
    const adapter = createRegistryAdapter({ fetch: fake as unknown as typeof fetch });
    const digest = await adapter.resolveDigest(IMAGE_REPO, MISSING_TAG);
    expect(digest).toBeNull();
    // The gate (SHP-T-1.4+) is the one that turns null into `refusal('image_missing', …)`;
    // this just shows the seam the adapter promises: null, never a throw, for an absent tag.
    const mapped = digest === null ? 'image_missing' : 'ok';
    expect(mapped).toBe('image_missing');
  });

  it('sends the host\'s credential to its token endpoint as Basic auth (private images, SHP-T-4.11)', async () => {
    const { fake } = makeFakeFetch();
    const registry = createRegistryAdapter({ fetch: fake as unknown as typeof fetch, credentials: (host) => (host === 'ghcr.io' ? 'dXNlcjp0b2tlbg==' : undefined) });
    await registry.resolveDigest(IMAGE_REPO, TAG);
    const tokenCall = fake.mock.calls.find(([url]) => String(url).startsWith('https://ghcr.io/token'));
    expect(new Headers(tokenCall?.[1]?.headers).get('Authorization')).toBe('Basic dXNlcjp0b2tlbg==');
    // Only the token endpoint ever sees it; registry calls carry the bearer token.
    for (const [url, init] of fake.mock.calls) {
      if (String(url).startsWith('https://ghcr.io/token')) continue;
      expect(new Headers(init?.headers).get('Authorization') ?? '').not.toContain('Basic');
    }
  });

  it('stays anonymous without a credential', async () => {
    const { fake } = makeFakeFetch();
    const registry = createRegistryAdapter({ fetch: fake as unknown as typeof fetch, credentials: () => undefined });
    await registry.resolveDigest(IMAGE_REPO, TAG);
    const tokenCall = fake.mock.calls.find(([url]) => String(url).startsWith('https://ghcr.io/token'));
    expect(new Headers(tokenCall?.[1]?.headers).has('Authorization')).toBe(false);
  });

  it('reads auths from a docker config directory, and treats a missing one as none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shp-dockercfg-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ auths: { 'ghcr.io': { auth: 'abc=' }, 'other.io': {} } }));
    const creds = dockerConfigCredentials(dir);
    expect(creds('ghcr.io')).toBe('abc=');
    expect(creds('other.io')).toBeUndefined();
    expect(dockerConfigCredentials(join(dir, 'nope'))('ghcr.io')).toBeUndefined();
    expect(dockerConfigCredentials(undefined)('ghcr.io')).toBeUndefined();
  });
});
