import { isAllowedIssuer, type D3AuthTestResult } from '@shipyard/schema';

/**
 * Settings → D3 Auth → Test (SHP-REQ-110): fetch the issuer's OpenID discovery document and say
 * what it says. The only host fetched is the one an admin typed (https, or http to this machine),
 * never followed through a redirect, bounded in time and size. No secret is sent.
 */

export const DISCOVERY_TEST_TIMEOUT_MS = 5_000;
const MAX_BYTES = 256 * 1024;

function blank(issuer: string, error: string): D3AuthTestResult {
  return {
    ok: false,
    issuer,
    discoveredIssuer: null,
    issuerMatches: false,
    authorizationEndpoint: null,
    tokenEndpoint: null,
    jwksUri: null,
    error,
  };
}

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

function stringField(doc: Record<string, unknown>, key: string): string | null {
  const value = doc[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `The issuer did not answer within ${String(timeoutMs / 1000)} seconds.`;
  }
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return `Could not connect to the issuer${code}.`;
}

export async function testDiscovery(
  issuer: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<D3AuthTestResult> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TEST_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  if (!isAllowedIssuer(issuer)) {
    return blank(issuer, 'The issuer must be an https URL (plain http only for localhost).');
  }
  const url = `${trimSlash(issuer)}/.well-known/openid-configuration`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return blank(issuer, describeFetchError(error, timeoutMs));
  }

  if (res.status >= 300 && res.status < 400) {
    return blank(issuer, `The issuer answered with a redirect (HTTP ${String(res.status)}); enter the address it redirects to.`);
  }
  if (!res.ok) {
    return blank(issuer, `The discovery document was not found (HTTP ${String(res.status)}). Check the issuer address.`);
  }

  if (Number(res.headers.get('content-length') ?? '0') > MAX_BYTES) {
    return blank(issuer, 'The discovery document is too large to be one.');
  }
  // Read at most MAX_BYTES and stop: a response with no Content-Length (chunked) is capped while it
  // streams, not after it has all been buffered.
  let text: string | null;
  try {
    text = await readCapped(res, MAX_BYTES);
  } catch (error) {
    return blank(issuer, describeFetchError(error, timeoutMs));
  }
  if (text === null) return blank(issuer, 'The discovery document is too large to be one.');

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return blank(issuer, 'The issuer answered, but not with a JSON discovery document.');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return blank(issuer, 'The issuer answered, but not with a JSON discovery document.');
  }
  const fields = doc as Record<string, unknown>;

  const discoveredIssuer = stringField(fields, 'issuer');
  const issuerMatches = discoveredIssuer !== null && trimSlash(discoveredIssuer) === trimSlash(issuer);
  const authorizationEndpoint = stringField(fields, 'authorization_endpoint');
  const tokenEndpoint = stringField(fields, 'token_endpoint');
  const jwksUri = stringField(fields, 'jwks_uri');

  let error: string | null = null;
  if (discoveredIssuer === null) error = 'The discovery document names no issuer.';
  else if (!issuerMatches) error = `The discovery document names the issuer ${discoveredIssuer}; use exactly that.`;
  else if (authorizationEndpoint === null || tokenEndpoint === null) error = 'The discovery document lacks an authorization or token endpoint.';
  else if (jwksUri === null) error = 'The discovery document publishes no signing keys (jwks_uri).';

  return {
    ok: error === null,
    issuer,
    discoveredIssuer,
    issuerMatches,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    error,
  };
}

/** The body as text, or null once it passes `max` bytes (the stream is cancelled there). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (res.body === null) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const value: Uint8Array = next.value;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
