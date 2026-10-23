import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createOciRegistry, nextLink, normalizeImageRepository, parseBearerChallenge, parseImageRef, registryCredentials } from '../src/adapters/oci.js';
import { RegistryError } from '../src/ports.js';

// SHP-REQ-194..196: any OCI registry — Docker Hub, GHCR, lscr.io — resolved by digest, tags listed,
// every failure a RegistryError so updates fail closed and the candidate checker reports it.

const DIGEST = `sha256:${'a'.repeat(64)}`;

interface Call {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestInit['redirect'];
}

type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), redirect: init?.redirect };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

function challenge(realm: string, service: string, scope: string): Response {
  return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="${realm}",service="${service}",scope="${scope}"` } });
}

describe('image references', () => {
  it('defaults to Docker Hub, with library/ for one-component names', () => {
    expect(parseImageRef('postgres')).toEqual({ host: 'registry-1.docker.io', path: 'library/postgres' });
    expect(parseImageRef('bitnami/redis')).toEqual({ host: 'registry-1.docker.io', path: 'bitnami/redis' });
    expect(parseImageRef('docker.io/postgres')).toEqual({ host: 'registry-1.docker.io', path: 'library/postgres' });
    expect(parseImageRef('docker.io/library/postgres')).toEqual({ host: 'registry-1.docker.io', path: 'library/postgres' });
  });

  it('reads a host with a dot, a port or localhost', () => {
    expect(parseImageRef('ghcr.io/linuxserver/sonarr')).toEqual({ host: 'ghcr.io', path: 'linuxserver/sonarr' });
    expect(parseImageRef('lscr.io/linuxserver/sonarr')).toEqual({ host: 'lscr.io', path: 'linuxserver/sonarr' });
    expect(parseImageRef('registry:5000/toy/app')).toEqual({ host: 'registry:5000', path: 'toy/app' });
    expect(parseImageRef('localhost/x')).toEqual({ host: 'localhost', path: 'x' });
  });

  it("normalises Docker Hub's spellings to the Engine's", () => {
    expect(normalizeImageRepository('docker.io/library/nginx')).toBe('nginx');
    expect(normalizeImageRepository('index.docker.io/library/nginx')).toBe('nginx');
    expect(normalizeImageRepository('library/nginx')).toBe('nginx');
    expect(normalizeImageRepository('docker.io/bitnami/redis')).toBe('bitnami/redis');
    expect(normalizeImageRepository('ghcr.io/a/b')).toBe('ghcr.io/a/b');
  });

  it('parses bearer challenges and Link headers', () => {
    expect(parseBearerChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/postgres:pull"')).toEqual({
      realm: 'https://auth.docker.io/token',
      service: 'registry.docker.io',
      scope: 'repository:library/postgres:pull',
    });
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge('Bearer service="x"')).toBeNull();
    expect(nextLink('</v2/x/tags/list?last=b&n=2>; rel="next"')).toBe('/v2/x/tags/list?last=b&n=2');
    expect(nextLink(null)).toBeNull();
  });
});

describe('resolveDigest', () => {
  it('runs the anonymous challenge for Docker Hub, asks for an index first, and caches the token', async () => {
    const { fetch, calls } = fakeFetch(({ url, headers }) => {
      if (url.startsWith('https://auth.docker.io/token')) return Response.json({ token: 'anon', expires_in: 300 });
      if (headers.get('authorization') !== 'Bearer anon') return challenge('https://auth.docker.io/token', 'registry.docker.io', 'repository:library/postgres:pull');
      return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
    });
    const registry = createOciRegistry({ fetch });
    await expect(registry.resolveDigest('postgres', '17')).resolves.toBe(DIGEST);
    await expect(registry.resolveDigest('postgres', '16')).resolves.toBe(DIGEST);

    const head = calls.find((c) => c.method === 'HEAD');
    expect(head?.url).toBe('https://registry-1.docker.io/v2/library/postgres/manifests/17');
    const accept = head?.headers.get('accept') ?? '';
    expect(accept.indexOf('application/vnd.oci.image.index.v1+json')).toBe(0);
    expect(accept).toContain('application/vnd.docker.distribution.manifest.list.v2+json');
    const token = new URL(calls.find((c) => c.url.startsWith('https://auth.docker.io'))?.url ?? '');
    expect(token.searchParams.get('service')).toBe('registry.docker.io');
    expect(token.searchParams.get('scope')).toBe('repository:library/postgres:pull');
    expect(token.searchParams.has('account')).toBe(false);
    expect(calls.filter((c) => c.url.startsWith('https://auth.docker.io'))).toHaveLength(1);
    expect(head?.redirect).toBe('manual');
  });

  it('a missing tag is null', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 404 }));
    await expect(createOciRegistry({ fetch }).resolveDigest('ghcr.io/a/b', 'nope')).resolves.toBeNull();
  });

  it('follows a redirect by hand, authenticating to the host it lands on (lscr.io → ghcr.io)', async () => {
    const { fetch, calls } = fakeFetch(({ url, headers }) => {
      if (url.startsWith('https://lscr.io/')) return new Response(null, { status: 307, headers: { location: url.replace('https://lscr.io/', 'https://ghcr.io/') } });
      if (url.startsWith('https://ghcr.io/token')) return Response.json({ token: 'gh' });
      if (headers.get('authorization') !== 'Bearer gh') return challenge('https://ghcr.io/token', 'ghcr.io', 'repository:linuxserver/sonarr:pull');
      return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
    });
    await expect(createOciRegistry({ fetch }).resolveDigest('lscr.io/linuxserver/sonarr', 'latest')).resolves.toBe(DIGEST);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['lscr.io', 'ghcr.io', 'ghcr.io', 'ghcr.io']);
    // The lscr.io hop never carried a token.
    expect(calls[0]?.headers.has('authorization')).toBe(false);
  });

  it('computes the digest from the manifest bytes when HEAD carries no header', async () => {
    const body = '{"schemaVersion":2}';
    const { fetch } = fakeFetch(({ method }) => (method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(body, { status: 200 })));
    const digest = await createOciRegistry({ fetch, plainHttpHosts: ['registry:5000'] }).resolveDigest('registry:5000/toy/app', '1.0.0');
    expect(digest).toBe(`sha256:${createHash('sha256').update(body).digest('hex')}`);
  });

  it('sends the DOCKER_CONFIG credential only to the registry’s own realm, Docker Hub included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shp-oci-'));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ auths: { 'https://index.docker.io/v1/': { auth: 'aHViOnNlY3JldA==' }, 'ghcr.io': { auth: 'Z2g6c2VjcmV0' } } }),
    );
    const credentials = registryCredentials(dir);
    expect(credentials('registry-1.docker.io')).toBe('aHViOnNlY3JldA==');
    expect(credentials('ghcr.io')).toBe('Z2g6c2VjcmV0');
    expect(credentials('quay.io')).toBeUndefined();
    expect(registryCredentials(join(dir, 'missing'))('ghcr.io')).toBeUndefined();
    expect(registryCredentials(undefined)('ghcr.io')).toBeUndefined();

    const { fetch, calls } = fakeFetch(({ url, headers }) => {
      if (url.includes('/token')) return Response.json({ token: 't' });
      if (headers.get('authorization') !== 'Bearer t') {
        if (url.includes('docker.io')) return challenge('https://auth.docker.io/token', 'registry.docker.io', 'repository:library/postgres:pull');
        if (url.includes('quay.io')) return challenge('https://evil.example/token', 'quay.io', 'repository:a/b:pull');
        return challenge('https://ghcr.io/token', 'ghcr.io', 'repository:a/b:pull');
      }
      return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
    });
    const registry = createOciRegistry({ fetch, credentials: (host) => (host === 'quay.io' ? 'cXVheTpzZWNyZXQ=' : credentials(host)) });
    await registry.resolveDigest('postgres', '17');
    await registry.resolveDigest('ghcr.io/a/b', 'x');
    await registry.resolveDigest('quay.io/a/b', 'x');
    const tokenAuth = calls.filter((c) => c.url.includes('/token')).map((c) => [new URL(c.url).host, c.headers.get('authorization')]);
    expect(tokenAuth).toEqual([
      ['auth.docker.io', 'Basic aHViOnNlY3JldA=='],
      ['ghcr.io', 'Basic Z2g6c2VjcmV0'],
      // A realm on another host never gets the credential.
      ['evil.example', null],
    ]);
  });

  it('429 is rate_limited with Retry-After; 5xx and network errors are unreachable; a timeout is unreachable', async () => {
    const limited = createOciRegistry({ fetch: fakeFetch(() => new Response(null, { status: 429, headers: { 'retry-after': '120' } })).fetch });
    const err = await limited.resolveDigest('postgres', '17').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });

    const down = createOciRegistry({ fetch: fakeFetch(() => new Response(null, { status: 503 })).fetch });
    await expect(down.resolveDigest('postgres', '17')).rejects.toMatchObject({ kind: 'unreachable' });

    const refused = createOciRegistry({ fetch: fakeFetch(() => Promise.reject(new TypeError('fetch failed'))).fetch });
    await expect(refused.resolveDigest('postgres', '17')).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('fetch failed') as unknown });

    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const slow = createOciRegistry({ fetch: hang, timeoutMs: 20 });
    await expect(slow.resolveDigest('postgres', '17')).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('timed out') as unknown });
  });

  it('a token refused, or a 401 after a token, is denied', async () => {
    const { fetch } = fakeFetch(({ url }) => (url.includes('/token') ? new Response(null, { status: 403 }) : challenge('https://ghcr.io/token', 'ghcr.io', 'repository:a/b:pull')));
    await expect(createOciRegistry({ fetch }).resolveDigest('ghcr.io/a/b', 'x')).rejects.toMatchObject({ kind: 'denied' });
  });
});

describe('listTags', () => {
  it('follows Link pagination on the same registry, and caps pages', async () => {
    const pages: Record<string, { tags: string[]; next?: string }> = {
      '': { tags: ['1.0.0', '1.1.0'], next: '</v2/library/postgres/tags/list?last=1.1.0&n=2>; rel="next"' },
      '1.1.0': { tags: ['1.2.0', 'latest'], next: '</v2/library/postgres/tags/list?last=latest&n=2>; rel="next"' },
      latest: { tags: ['2.0.0'] },
    };
    const { fetch, calls } = fakeFetch(({ url }) => {
      const last = new URL(url).searchParams.get('last') ?? '';
      const page = pages[last] ?? { tags: [] };
      return Response.json({ name: 'library/postgres', tags: page.tags }, { headers: page.next === undefined ? {} : { link: page.next } });
    });
    await expect(createOciRegistry({ fetch, tagsPageSize: 2 }).listTags('postgres')).resolves.toEqual(['1.0.0', '1.1.0', '1.2.0', 'latest', '2.0.0']);
    expect(calls[0]?.url).toBe('https://registry-1.docker.io/v2/library/postgres/tags/list?n=2');

    const capped = createOciRegistry({ fetch, tagsPageSize: 2, maxTagPages: 2 });
    await expect(capped.listTags('postgres')).resolves.toEqual(['1.0.0', '1.1.0', '1.2.0', 'latest']);
  });

  it('never follows a next link to another host', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ tags: ['1'] }, { headers: { link: '<https://evil.example/v2/x/tags/list>; rel="next"' } }));
    await expect(createOciRegistry({ fetch }).listTags('ghcr.io/a/b')).resolves.toEqual(['1']);
    expect(calls).toHaveLength(1);
  });

  it('a rate limit while listing is a RegistryError, not a crash', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 429 }));
    await expect(createOciRegistry({ fetch }).listTags('postgres')).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

describe('a registry that stalls or floods fails closed (SHP-REQ-196)', () => {
  /** A 200 whose body never closes, the verifier's reproduction. */
  const stalled = (): Response => new Response(new ReadableStream({ start: () => undefined }), { status: 200, headers: { 'content-type': 'application/json' } });

  const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`still hanging after ${String(ms)} ms`));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  it('a tag list body that never closes is unreachable at the deadline', async () => {
    const registry = createOciRegistry({ fetch: fakeFetch(() => stalled()).fetch, timeoutMs: 100 });
    const started = Date.now();
    await expect(within(registry.listTags('postgres'), 2_000)).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('timed out') as unknown });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a manifest body that never closes is unreachable at the deadline', async () => {
    const { fetch } = fakeFetch(({ method }) => (method === 'HEAD' ? new Response(null, { status: 200 }) : stalled()));
    await expect(within(createOciRegistry({ fetch, timeoutMs: 100 }).resolveDigest('ghcr.io/a/b', '1'), 2_000)).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('a token body that never closes is unreachable at the deadline', async () => {
    const { fetch } = fakeFetch(({ url }) => (url.includes('/token') ? stalled() : challenge('https://ghcr.io/token', 'ghcr.io', 'repository:a/b:pull')));
    await expect(within(createOciRegistry({ fetch, timeoutMs: 100 }).resolveDigest('ghcr.io/a/b', '1'), 2_000)).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('a fetch that ignores its abort signal still ends at the deadline', async () => {
    const ignoring: typeof fetch = () => new Promise<never>(() => undefined);
    await expect(within(createOciRegistry({ fetch: ignoring, timeoutMs: 100 }).resolveDigest('postgres', '17'), 2_000)).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('an oversize body is refused, declared or streamed; so is a page with too many tags', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    const declared = createOciRegistry({ fetch: fakeFetch(() => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } })).fetch });
    await expect(declared.listTags('postgres')).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('bytes') as unknown });

    const streamed = createOciRegistry({
      fetch: fakeFetch(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(512 * 1024));
              },
            }),
            { status: 200 },
          ),
      ).fetch,
    });
    await expect(within(streamed.listTags('postgres'), 5_000)).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('bytes') as unknown });

    const manifest = createOciRegistry({ fetch: fakeFetch(({ method }) => (method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(Buffer.alloc(1024 * 1024 + 1), { status: 200 }))).fetch });
    await expect(manifest.resolveDigest('ghcr.io/a/b', '1')).rejects.toMatchObject({ kind: 'unreachable' });

    const many = createOciRegistry({ fetch: fakeFetch(() => Response.json({ tags: ['1', '2', '3'] })).fetch, maxTagsPerPage: 2 });
    await expect(many.listTags('postgres')).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('3 tags') as unknown });
  });

  it('an invalid tag is refused without asking the registry', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    await expect(createOciRegistry({ fetch }).resolveDigest('postgres', '../evil')).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('not a valid tag') as unknown });
    expect(calls).toEqual([]);
  });
});

describe('only https, and a token only where it was issued', () => {
  it('refuses a redirect to http, never sending the cached token there', async () => {
    const { fetch, calls } = fakeFetch(({ url, headers }) => {
      if (url.startsWith('https://ghcr.io/token')) return Response.json({ token: 'gh' });
      if (url.startsWith('http://')) return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
      if (headers.get('authorization') !== 'Bearer gh') return challenge('https://ghcr.io/token', 'ghcr.io', 'repository:a/b:pull');
      return new Response(null, { status: 307, headers: { location: url.replace('https://', 'http://') } });
    });
    await expect(createOciRegistry({ fetch }).resolveDigest('ghcr.io/a/b', '1')).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('not https') as unknown });
    expect(calls.some((c) => c.url.startsWith('http://'))).toBe(false);
  });

  it('refuses an http token realm, and never sends a credential over http even to a plain-http host', async () => {
    const { fetch, calls } = fakeFetch(({ url, headers }) => {
      if (url.includes('/token')) return Response.json({ token: 't' });
      if (headers.get('authorization') !== 'Bearer t') {
        if (url.startsWith('https://ghcr.io/')) return challenge('http://ghcr.io/token', 'ghcr.io', 'repository:a/b:pull');
        return challenge('http://registry:5000/token', 'registry', 'repository:toy/app:pull');
      }
      return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
    });
    const registry = createOciRegistry({ fetch, plainHttpHosts: ['registry:5000'], credentials: () => 'c2VjcmV0' });
    await expect(registry.resolveDigest('ghcr.io/a/b', '1')).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('not https') as unknown });
    expect(calls.some((c) => c.url.startsWith('http://ghcr.io'))).toBe(false);
    await expect(registry.resolveDigest('registry:5000/toy/app', '1')).resolves.toBe(DIGEST);
    const token = calls.find((c) => c.url.startsWith('http://registry:5000/token'));
    expect(token?.headers.has('authorization')).toBe(false);
  });

  it('keys the token cache by scheme: a token taken over https is never replayed over http', async () => {
    const { fetch, calls } = fakeFetch(({ url, headers }) => {
      const secure = url.startsWith('https://');
      if (url.includes('/token')) return Response.json({ token: secure ? 'secure' : 'plain' });
      if (headers.get('authorization') !== (secure ? 'Bearer secure' : 'Bearer plain')) {
        return challenge(secure ? 'https://registry:5000/token' : 'http://registry:5000/token', 'r', 'repository:toy/app:pull');
      }
      // Over plain http, tag 1 is handed off to https on the same host.
      if (!secure && url.endsWith('/1')) return new Response(null, { status: 307, headers: { location: url.replace('http://', 'https://') } });
      return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
    });
    const registry = createOciRegistry({ fetch, plainHttpHosts: ['registry:5000'] });
    await expect(registry.resolveDigest('registry:5000/toy/app', '1')).resolves.toBe(DIGEST);
    await expect(registry.resolveDigest('registry:5000/toy/app', '2')).resolves.toBe(DIGEST);
    const overHttp = calls.filter((c) => c.url.startsWith('http://'));
    expect(overHttp.length).toBeGreaterThan(0);
    expect(overHttp.some((c) => c.headers.get('authorization') === 'Bearer secure')).toBe(false);
    // The https hop never carried the http token either.
    expect(calls.filter((c) => c.url.startsWith('https://')).some((c) => c.headers.get('authorization') === 'Bearer plain')).toBe(false);
  });
});
