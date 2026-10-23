import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RegistryError, type StackRegistryPort } from '../ports.js';

/**
 * A registry adapter for any OCI distribution registry (SHP-ADR-010, SHP-REQ-194..196): the
 * tracked services of an adopted stack come from Docker Hub, GHCR, lscr.io or anywhere else, not
 * only from the D3 images `ghcr.ts` verifies. It resolves `image:tag` to the manifest digest
 * (`HEAD /v2/<path>/manifests/<tag>`, asking for an OCI index or Docker manifest list first so the
 * digest is the one `docker pull` records) and lists tags (`GET /v2/<path>/tags/list`, following
 * `Link` pagination up to a page cap).
 *
 * Authentication is the registry's own challenge: a 401 names a realm, service and scope in
 * `WWW-Authenticate: Bearer …`; a token is fetched from that realm — anonymously, or with the
 * host's credential from `$DOCKER_CONFIG/config.json` when one is configured — cached per scheme,
 * host and repository, and the request retried once. Redirects are followed by hand, so each host a
 * request lands on (lscr.io hands off to ghcr.io) runs its own challenge and a token is never
 * replayed to a host that did not issue it. A credential goes only to a realm on the registry's own
 * host (Docker Hub's realm is `auth.docker.io`), and is never logged.
 *
 * Each exchange — headers and body — runs inside one deadline, and a body is read only up to a cap
 * (a tag page 4 MiB and 10 000 tags, a manifest or token 1 MiB): a registry that stalls mid-body or
 * sends without end is `unreachable`, so an update refuses and the candidate checker moves on.
 * Only https is asked — a redirect or a token realm elsewhere is refused — except a host configured
 * for plain http; the token cache is keyed by scheme and host, and a credential never goes over http.
 *
 * Every failure is a `RegistryError`: `unreachable` (network, timeout, 5xx, a malformed answer),
 * `rate_limited` (429, with `Retry-After`), or `denied` (401/403 after a token). The candidate
 * checker reports it as the service's error; the update path refuses `registry_unreachable`.
 */

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** Body caps (SHP-REQ-196): more than this is refused as `unreachable`, never read on. */
const MAX_TAG_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 1024 * 1024;
const DEFAULT_MAX_TAGS_PER_PAGE = 10_000;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const DOCKER_HUB_AUTH = 'auth.docker.io';
/** How a docker config spells Docker Hub in `auths`, newest spelling first. */
const DOCKER_HUB_AUTH_KEYS = ['https://index.docker.io/v1/', 'https://index.docker.io/v1', 'index.docker.io', 'docker.io', 'registry-1.docker.io'];

export interface ImageRef {
  /** The registry API host (`registry-1.docker.io` for Docker Hub), with a port when one was given. */
  host: string;
  /** The repository path on that registry (`library/postgres`). */
  path: string;
}

/**
 * `[host[:port]/]path` as the distribution grammar reads it: the first component is a registry host
 * when it has a `.` or a `:`, or is `localhost`; otherwise the image is on Docker Hub, where a
 * one-component name lives under `library/`.
 */
export function parseImageRef(image: string): ImageRef {
  const slash = image.indexOf('/');
  const first = slash === -1 ? '' : image.slice(0, slash);
  if (slash !== -1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    const host = DOCKER_HUB_ALIASES.has(first) ? DOCKER_HUB_REGISTRY : first;
    const path = image.slice(slash + 1);
    return { host, path: host === DOCKER_HUB_REGISTRY && !path.includes('/') ? `library/${path}` : path };
  }
  return { host: DOCKER_HUB_REGISTRY, path: slash === -1 ? `library/${image}` : image };
}

/**
 * One spelling for every way of naming a repository, the way the Engine writes RepoDigests:
 * `docker.io/library/nginx`, `index.docker.io/library/nginx` and `library/nginx` are all `nginx`.
 * Two image strings name the same repository exactly when their normal forms are equal.
 */
export function normalizeImageRepository(repo: string): string {
  const hubless = repo.replace(/^(?:index\.|registry-1\.)?docker\.io\//, '');
  return hubless.startsWith('library/') && hubless.split('/').length === 2 ? hubless.slice('library/'.length) : hubless;
}

/**
 * Registry credentials from a docker config directory (`$DOCKER_CONFIG/config.json` `auths`, the
 * base64 `user:secret` form), looked up by registry host — Docker Hub under any of its spellings.
 * A missing or unreadable file means no credentials (anonymous), never an error. Credential helpers
 * (`credsStore`, `credHelpers`) are not run: the agent executes nothing but docker and compose.
 */
export function registryCredentials(configDir: string | undefined): (host: string) => string | undefined {
  if (configDir === undefined || configDir === '') return () => undefined;
  let auths: Record<string, { auth?: unknown } | undefined> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as { auths?: Record<string, { auth?: unknown }> };
    auths = parsed.auths ?? {};
  } catch {
    return () => undefined;
  }
  const lookup = (key: string): string | undefined => {
    const auth = auths[key]?.auth;
    return typeof auth === 'string' && auth.length > 0 ? auth : undefined;
  };
  return (host) => {
    const keys = host === DOCKER_HUB_REGISTRY ? DOCKER_HUB_AUTH_KEYS : [host, `https://${host}`, `https://${host}/`];
    for (const key of keys) {
      const found = lookup(key);
      if (found !== undefined) return found;
    }
    return undefined;
  };
}

export interface OciRegistryOptions {
  fetch?: typeof fetch;
  /** Per exchange, headers and body, token fetches included. Default 10 s. */
  timeoutMs?: number;
  /** Hosts reached over plain HTTP (a local `registry:2` in e2e). */
  plainHttpHosts?: string[];
  /** The registry's credential (`auths[host].auth`), by registry host. Default: none. */
  credentials?: (host: string) => string | undefined;
  /** Tags asked for per page. Default 1000. */
  tagsPageSize?: number;
  /** Pages followed before the list stops. Default 20. */
  maxTagPages?: number;
  /** Tags one page may carry before it is refused. Default 10 000 (or the page size, if larger). */
  maxTagsPerPage?: number;
  /** Epoch ms, for token expiry. Default `Date.now`. */
  now?: () => number;
}

interface Challenge {
  realm: string;
  service: string | undefined;
  scope: string | undefined;
}

/** `Bearer realm="…",service="…",scope="…"` → its parameters; null for anything else. */
export function parseBearerChallenge(header: string): Challenge | null {
  const m = /^\s*Bearer\s+(.*)$/i.exec(header);
  if (m === null) return null;
  const params = new Map<string, string>();
  for (const p of (m[1] ?? '').matchAll(/([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) {
    const key = p[1];
    if (key !== undefined) params.set(key.toLowerCase(), p[2] ?? p[3] ?? '');
  }
  const realm = params.get('realm');
  if (realm === undefined || realm === '') return null;
  return { realm, service: params.get('service'), scope: params.get('scope') };
}

function retryAfterMs(headers: Headers): number | undefined {
  const header = headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' || err.name === 'TimeoutError' ? 'timed out' : err.message;
  return String(err);
}

/** The `rel="next"` target of a `Link` header, or null. */
export function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/** A response read whole, inside the request's deadline and size cap. */
interface Fetched {
  status: number;
  ok: boolean;
  headers: Headers;
  /** The body of a 2xx answer to a GET; empty for anything else, whose body is discarded unread. */
  body: Buffer;
}

function discard(res: Response): void {
  if (res.body !== null && !res.bodyUsed) void res.body.cancel().catch(() => undefined);
}

export function createOciRegistry(options: OciRegistryOptions = {}): StackRegistryPort {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const plainHttp = new Set(options.plainHttpHosts ?? []);
  const pageSize = options.tagsPageSize ?? 1000;
  const maxPages = options.maxTagPages ?? 20;
  const maxTagsPerPage = options.maxTagsPerPage ?? Math.max(DEFAULT_MAX_TAGS_PER_PAGE, pageSize);
  const now = options.now ?? Date.now;
  /** `scheme://host path` → bearer token and when it stops being used. The scheme is in the key, so a token taken over https is never replayed over http. */
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  const baseUrl = (host: string): string => `${plainHttp.has(host) ? 'http' : 'https'}://${host}`;
  /** https, or plain http to a host configured for it (a local `registry:2`); nothing else is ever asked. */
  const allowedUrl = (url: URL): boolean => url.protocol === 'https:' || (url.protocol === 'http:' && plainHttp.has(url.host));

  /**
   * Reads a body up to `maxBytes`, refusing (as `unreachable`) a declared or actual length past it.
   * Stops reading when `signal` aborts.
   */
  async function readCapped(what: string, host: string, res: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const tooLarge = (): RegistryError => new RegistryError('unreachable', `${what}: ${host} sent more than ${String(maxBytes)} bytes; the answer was refused`);
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      discard(res);
      throw tooLarge();
    }
    if (res.body === null) return Buffer.alloc(0);
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
    const cancel = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (chunk.done || chunk.value === undefined) break;
        const value = chunk.value;
        total += value.byteLength;
        if (total > maxBytes) throw tooLarge();
        chunks.push(value);
      }
    } catch (err) {
      cancel();
      throw err;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    return Buffer.concat(chunks);
  }

  /**
   * One HTTP exchange, headers and body, inside one deadline (SHP-REQ-196: a registry that stalls
   * is unreachable, and the update refuses). The deadline is raced rather than only signalled, so
   * a fetch or a body stream that ignores its AbortSignal still ends. A 2xx answer to a GET is read
   * whole, up to `maxBytes`; any other answer's body is discarded unread.
   */
  async function rawFetch(what: string, url: string, init: RequestInit, maxBytes: number): Promise<Fetched> {
    const host = new URL(url).host;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RegistryError('unreachable', `${what}: ${host} unreachable (timed out after ${String(timeoutMs)} ms)`));
      }, timeoutMs);
    });
    deadline.catch(() => undefined);
    try {
      let res: Response;
      try {
        res = await Promise.race([doFetch(url, { ...init, redirect: 'manual', signal: controller.signal }), deadline]);
      } catch (err) {
        if (err instanceof RegistryError) throw err;
        throw new RegistryError('unreachable', `${what}: ${host} unreachable (${errMessage(err)})`);
      }
      const wantBody = res.status >= 200 && res.status < 300 && (init.method ?? 'GET') !== 'HEAD';
      if (!wantBody) {
        discard(res);
        return { status: res.status, ok: res.ok, headers: res.headers, body: Buffer.alloc(0) };
      }
      let body: Buffer;
      try {
        body = await Promise.race([readCapped(what, host, res, maxBytes, controller.signal), deadline]);
      } catch (err) {
        if (err instanceof RegistryError) throw err;
        throw new RegistryError('unreachable', `${what}: ${host} unreachable while sending its answer (${errMessage(err)})`);
      }
      return { status: res.status, ok: res.ok, headers: res.headers, body };
    } finally {
      clearTimeout(timer);
    }
  }

  function parseJson(what: string, host: string, body: Buffer, kind: string): unknown {
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new RegistryError('unreachable', `${what}: ${host} sent ${kind} that is not JSON`);
    }
  }

  async function fetchToken(what: string, origin: URL, path: string, challenge: Challenge): Promise<string> {
    const host = origin.host;
    let realm: URL;
    try {
      realm = new URL(challenge.realm);
    } catch {
      throw new RegistryError('unreachable', `${what}: ${host} sent a challenge with an unreadable realm`);
    }
    if (!allowedUrl(realm)) {
      throw new RegistryError('unreachable', `${what}: ${host} names a token realm that is not https`);
    }
    if (challenge.service !== undefined) realm.searchParams.set('service', challenge.service);
    realm.searchParams.set('scope', challenge.scope ?? `repository:${path}:pull`);
    // A credential goes only to the registry's own realm (Docker Hub's lives on auth.docker.io), and
    // only over https — never in the clear, even to a host configured for plain http.
    const ownRealm = realm.host === host || (host === DOCKER_HUB_REGISTRY && realm.host === DOCKER_HUB_AUTH);
    const credential = ownRealm && realm.protocol === 'https:' ? options.credentials?.(host) : undefined;
    const res = await rawFetch(what, realm.toString(), credential === undefined ? {} : { headers: { Authorization: `Basic ${credential}` } }, MAX_TOKEN_BYTES);
    if (res.status === 429) throw new RegistryError('rate_limited', `${what}: ${realm.host} is rate limiting token requests`, retryAfterMs(res.headers));
    if (res.status >= 500) throw new RegistryError('unreachable', `${what}: ${realm.host} answered ${String(res.status)} for a token`);
    if (!res.ok) {
      throw new RegistryError('denied', `${what}: ${realm.host} refused ${credential === undefined ? 'an anonymous token' : 'a token for the configured credential'} (${String(res.status)})`);
    }
    const body = parseJson(what, realm.host, res.body, 'a token response') as { token?: unknown; access_token?: unknown; expires_in?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token : typeof body?.access_token === 'string' ? body.access_token : undefined;
    if (token === undefined || token === '') throw new RegistryError('unreachable', `${what}: ${realm.host} sent no token`);
    const ttl = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in * 1000 : 60_000;
    tokens.set(`${origin.origin} ${path}`, { token, expiresAt: now() + Math.max(ttl - 5_000, 0) });
    return token;
  }

  /**
   * One registry request: the cached token if there is one, a challenge answered once, redirects
   * followed by hand (each hop authenticating to its own host, and refused unless it is https).
   * 429 and 5xx throw; anything else is returned for the caller to read.
   */
  async function request(what: string, path: string, startUrl: string, init: RequestInit, maxBytes: number): Promise<Fetched> {
    let url = startUrl;
    for (let hop = 0; hop < 5; hop++) {
      const at = new URL(url);
      if (!allowedUrl(at)) throw new RegistryError('unreachable', `${what}: refused to ask ${at.origin}, which is not https`);
      const host = at.host;
      const key = `${at.origin} ${path}`;
      const cached = tokens.get(key);
      const withToken = (token: string | undefined): RequestInit => {
        if (token === undefined) return init;
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return { ...init, headers };
      };
      let res = await rawFetch(what, url, withToken(cached !== undefined && cached.expiresAt > now() ? cached.token : undefined), maxBytes);
      if (res.status === 401) {
        const header = res.headers.get('www-authenticate');
        const challenge = header === null ? null : parseBearerChallenge(header);
        if (challenge === null) throw new RegistryError('denied', `${what}: ${host} answered 401 without a bearer challenge`);
        tokens.delete(key);
        res = await rawFetch(what, url, withToken(await fetchToken(what, at, path, challenge)), maxBytes);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location === null) throw new RegistryError('unreachable', `${what}: ${host} redirected without a Location`);
        url = new URL(location, url).toString();
        continue;
      }
      if (res.status === 429) throw new RegistryError('rate_limited', `${what}: ${host} is rate limiting (429)`, retryAfterMs(res.headers));
      if (res.status >= 500) throw new RegistryError('unreachable', `${what}: ${host} answered ${String(res.status)}`);
      if (res.status === 401 || res.status === 403) throw new RegistryError('denied', `${what}: ${host} refused access (${String(res.status)})`);
      return res;
    }
    throw new RegistryError('unreachable', `${what}: too many redirects`);
  }

  return {
    async resolveDigest(image, tag) {
      if (!TAG_RE.test(tag)) throw new RegistryError('unreachable', `${image}:${tag}: not a valid tag`);
      const { host, path } = parseImageRef(image);
      const what = `${image}:${tag}`;
      const url = `${baseUrl(host)}/v2/${path}/manifests/${tag}`;
      const head = await request(what, path, url, { method: 'HEAD', headers: { Accept: MANIFEST_ACCEPT } }, MAX_MANIFEST_BYTES);
      if (head.status === 404) return null;
      if (!head.ok) throw new RegistryError('unreachable', `${what}: ${host} answered ${String(head.status)}`);
      const digest = head.headers.get('docker-content-digest');
      if (digest !== null && DIGEST_RE.test(digest)) return digest;
      // A registry that does not send the header on HEAD: the digest is the sha256 of the manifest bytes.
      const get = await request(what, path, url, { headers: { Accept: MANIFEST_ACCEPT } }, MAX_MANIFEST_BYTES);
      if (get.status === 404) return null;
      if (!get.ok) throw new RegistryError('unreachable', `${what}: ${host} answered ${String(get.status)}`);
      const fromHeader = get.headers.get('docker-content-digest');
      if (fromHeader !== null && DIGEST_RE.test(fromHeader)) return fromHeader;
      return `sha256:${createHash('sha256').update(get.body).digest('hex')}`;
    },

    async listTags(image) {
      const { host, path } = parseImageRef(image);
      const what = `${image} tags`;
      const origin = new URL(baseUrl(host)).origin;
      const tags: string[] = [];
      let url: string | null = `${baseUrl(host)}/v2/${path}/tags/list?n=${String(pageSize)}`;
      for (let page = 0; url !== null && page < maxPages; page++) {
        const res: Fetched = await request(what, path, url, { headers: { Accept: 'application/json' } }, MAX_TAG_PAGE_BYTES);
        if (res.status === 404) return tags;
        if (!res.ok) throw new RegistryError('unreachable', `${what}: ${host} answered ${String(res.status)}`);
        const body = parseJson(what, host, res.body, 'a tag list') as { tags?: unknown } | null;
        const list = body?.tags;
        if (Array.isArray(list)) {
          if (list.length > maxTagsPerPage) throw new RegistryError('unreachable', `${what}: ${host} sent ${String(list.length)} tags in one page, more than the ${String(maxTagsPerPage)} read`);
          for (const tag of list) if (typeof tag === 'string' && TAG_RE.test(tag)) tags.push(tag);
        }
        const next = nextLink(res.headers.get('link'));
        if (next === null) break;
        const resolved: URL = new URL(next, url);
        // Pagination stays on the registry it started on.
        url = resolved.origin === origin ? resolved.toString() : null;
      }
      return tags;
    },
  };
}
