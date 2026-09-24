import { refusal } from '@shipyard/schema';

import { RefusalError, type ImageConfig, type RegistryPort } from '../ports.js';

/**
 * Anonymous GHCR (and OCI-compatible registry) access (SHP-T-1.3, SHP-D-043). Public images need
 * no credential: the first unauthenticated request gets a 401 naming a realm/service/scope in
 * `WWW-Authenticate`; this fetches an anonymous bearer token from that realm and retries once. The
 * token is cached per repository until shortly before it expires. `plainHttpHosts` lets the e2e
 * suite point this at a local `registry:2` over plain HTTP with no auth at all.
 */

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

interface OciManifestRef {
  digest: string;
  mediaType: string;
  platform?: { architecture: string; os: string };
}

interface OciIndex {
  manifests: OciManifestRef[];
}

interface OciManifest {
  config: { digest: string; mediaType: string };
}

interface OciImageConfig {
  config?: { Labels?: Record<string, string> | null };
}

interface CachedToken {
  token: string;
  /** epoch ms after which the token should be treated as expired and refetched. */
  expiresAt: number;
}

export interface GhcrAdapterOptions {
  fetch?: typeof fetch;
  /** Per-request timeout; also applied to the token fetch. Default 10s. */
  timeoutMs?: number;
  /** Hosts (e.g. `registry:5000`) reached over plain HTTP with no auth — for the e2e local registry. */
  plainHttpHosts?: string[];
}

function parseRepo(imageRepo: string): { host: string; path: string } {
  const slash = imageRepo.indexOf('/');
  if (slash === -1) {
    throw new Error(`imageRepo must be <host>/<path>, got ${imageRepo}`);
  }
  const host = imageRepo.slice(0, slash);
  const path = imageRepo.slice(slash + 1);
  return { host, path };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'timed out';
    return err.message;
  }
  return String(err);
}

export function createRegistryAdapter(options: GhcrAdapterOptions = {}): RegistryPort {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const plainHttpHosts = new Set(options.plainHttpHosts ?? []);

  const tokenCache = new Map<string, CachedToken>();

  function baseUrl(host: string): string {
    return plainHttpHosts.has(host) ? `http://${host}` : `https://${host}`;
  }

  async function rawFetch(host: string, url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw new RefusalError(refusal('ghcr_unreachable', `${host} unreachable: ${errMessage(err)}`));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetches an anonymous bearer token from the realm/service/scope in a 401's WWW-Authenticate. */
  async function fetchToken(host: string, path: string, www: string): Promise<string> {
    const realm = /realm="([^"]+)"/.exec(www)?.[1];
    const service = /service="([^"]+)"/.exec(www)?.[1];
    if (realm === undefined) {
      throw new RefusalError(refusal('ghcr_unreachable', `${host} sent an unparseable WWW-Authenticate challenge`));
    }
    const url = new URL(realm);
    if (service !== undefined) url.searchParams.set('service', service);
    url.searchParams.set('scope', `repository:${path}:pull`);
    const tokenRes = await rawFetch(host, url.toString(), {});
    if (!tokenRes.ok) {
      throw new RefusalError(refusal('ghcr_unreachable', `${host} refused to issue an anonymous token (${String(tokenRes.status)})`));
    }
    const body = (await tokenRes.json()) as { token?: string; access_token?: string; expires_in?: number };
    const token = body.token ?? body.access_token;
    if (token === undefined) {
      throw new RefusalError(refusal('ghcr_unreachable', `${host} token response had no token`));
    }
    const ttlMs = (body.expires_in ?? 300) * 1000;
    // Refresh a little before real expiry so a later call never races it.
    tokenCache.set(path, { token, expiresAt: Date.now() + Math.max(ttlMs - 5_000, 0) });
    return token;
  }

  /** GET/HEAD with the anonymous bearer flow: cached token if we have one, else fetch on a 401. */
  async function authedFetch(host: string, path: string, url: string, init: RequestInit): Promise<Response> {
    const isPlain = plainHttpHosts.has(host);
    const cached = !isPlain ? tokenCache.get(path) : undefined;
    const withAuth = (token: string | undefined): RequestInit => {
      if (token === undefined) return init;
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return { ...init, headers };
    };

    let res = await rawFetch(host, url, withAuth(cached?.token));
    if (res.status === 401 && !isPlain) {
      const www = res.headers.get('www-authenticate');
      if (www === null) {
        throw new RefusalError(refusal('ghcr_unreachable', `${host} returned 401 with no WWW-Authenticate challenge`));
      }
      const token = await fetchToken(host, path, www);
      res = await rawFetch(host, url, withAuth(token));
    }
    if (res.status >= 500 || res.status === 429) {
      throw new RefusalError(refusal('ghcr_unreachable', `${host} returned ${String(res.status)}`));
    }
    return res;
  }

  async function getManifest(host: string, path: string, ref: string): Promise<unknown> {
    const res = await authedFetch(host, path, `${baseUrl(host)}/v2/${path}/manifests/${ref}`, {
      headers: { Accept: MANIFEST_ACCEPT },
    });
    if (!res.ok) {
      throw new RefusalError(refusal('ghcr_unreachable', `${host} returned ${String(res.status)} for manifest ${ref}`));
    }
    return await res.json();
  }

  return {
    async resolveDigest(imageRepo, tag) {
      const { host, path } = parseRepo(imageRepo);
      const res = await authedFetch(host, path, `${baseUrl(host)}/v2/${path}/manifests/${tag}`, {
        method: 'HEAD',
        headers: { Accept: MANIFEST_ACCEPT },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new RefusalError(refusal('ghcr_unreachable', `${host} returned ${String(res.status)} resolving ${imageRepo}:${tag}`));
      }
      const digest = res.headers.get('docker-content-digest');
      if (digest === null || !DIGEST_RE.test(digest)) {
        throw new RefusalError(refusal('ghcr_unreachable', `${host} returned no valid Docker-Content-Digest for ${imageRepo}:${tag}`));
      }
      return digest;
    },

    async imageConfig(imageRepo, digest) {
      const { host, path } = parseRepo(imageRepo);
      const top = await getManifest(host, path, digest);
      let manifest: OciManifest;
      if (isIndex(top)) {
        const amd64 = top.manifests.find(
          (m) => m.platform !== undefined && m.platform.architecture === 'amd64' && m.platform.os !== 'unknown',
        );
        if (amd64 === undefined) {
          throw new RefusalError(refusal('ghcr_unreachable', `${host} index for ${imageRepo}@${digest} has no linux/amd64 manifest`));
        }
        manifest = asManifest(await getManifest(host, path, amd64.digest), host, imageRepo, digest);
      } else {
        manifest = asManifest(top, host, imageRepo, digest);
      }

      const blobRes = await authedFetch(host, path, `${baseUrl(host)}/v2/${path}/blobs/${manifest.config.digest}`, {});
      if (!blobRes.ok) {
        throw new RefusalError(refusal('ghcr_unreachable', `${host} returned ${String(blobRes.status)} for config blob of ${imageRepo}@${digest}`));
      }
      const configBody = (await blobRes.json()) as OciImageConfig;
      const labels = configBody.config?.Labels ?? {};
      const result: ImageConfig = { digest, labels };
      return result;
    },
  };
}

function isIndex(body: unknown): body is OciIndex {
  if (typeof body !== 'object' || body === null) return false;
  const manifests = (body as Record<string, unknown>)['manifests'];
  return Array.isArray(manifests);
}

function asManifest(body: unknown, host: string, imageRepo: string, digest: string): OciManifest {
  const invalid = (): never => {
    throw new RefusalError(refusal('ghcr_unreachable', `${host} returned a manifest with no config for ${imageRepo}@${digest}`));
  };
  if (typeof body !== 'object' || body === null) return invalid();
  const config = (body as Record<string, unknown>)['config'];
  if (typeof config !== 'object' || config === null) return invalid();
  const configDigest = (config as Record<string, unknown>)['digest'];
  if (typeof configDigest !== 'string') return invalid();
  return body as OciManifest;
}
