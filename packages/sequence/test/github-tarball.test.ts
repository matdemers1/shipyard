import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubAdapter } from '../src/adapters/github.js';
import { RefusalError } from '../src/ports.js';
import type { GitHubPort } from '../src/ports.js';

const REPO = 'matdemers1/shipyard';
const VALID_SHA = 'a'.repeat(40);

/** `tarball` is optional on `GitHubPort`; the real adapter always implements it. */
function callTarball(adapter: GitHubPort, repo: string, sha: string): ReturnType<NonNullable<GitHubPort['tarball']>> {
  if (adapter.tarball === undefined) throw new Error('adapter has no tarball method');
  return adapter.tarball(repo, sha);
}

async function expectRefusal(promise: Promise<unknown>): Promise<RefusalError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RefusalError);
    return err as RefusalError;
  }
  throw new Error('expected a RefusalError but the promise resolved');
}

function gzipBody(): Uint8Array {
  return gzipSync(Buffer.from('not a real tarball, just bytes to move'));
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

describe('tarball', () => {
  it('refuses a malformed SHA before any fetch', async () => {
    const fetchStub = vi.fn();
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch });
    const err = await expectRefusal(callTarball(adapter, REPO, 'not-a-sha'));
    expect(err.refusal.code).toBe('invalid_request');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses an uppercase or short SHA before any fetch', async () => {
    const fetchStub = vi.fn();
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch });
    await expectRefusal(callTarball(adapter, REPO, VALID_SHA.slice(0, 39)));
    await expectRefusal(callTarball(adapter, REPO, VALID_SHA.toUpperCase()));
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('follows the 302 to codeload without forwarding the token, and streams the gzip body', async () => {
    const body = gzipBody();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchStub = vi.fn((url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      const h = init?.headers as Record<string, string> | undefined;
      if (h) Object.assign(headers, h);
      calls.push({ url, headers });
      if (calls.length === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://codeload.github.com/${REPO}/legacy.tar.gz/${VALID_SHA}` },
          }),
        );
      }
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch, token: 'pat-secret' });

    const stream = await callTarball(adapter, REPO, VALID_SHA);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBe(body.byteLength);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain(`/repos/${REPO}/tarball/${VALID_SHA}`);
    expect(calls[0]?.headers.Authorization).toBe('Bearer pat-secret');
    expect(calls[1]?.url).toContain('codeload.github.com');
    expect(calls[1]?.headers.Authorization).toBeUndefined();
  });

  it('refuses a redirect to a disallowed host', async () => {
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.com/steal.tar.gz' },
        }),
      ),
    );
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch, token: 'pat-secret' });
    const err = await expectRefusal(callTarball(adapter, REPO, VALID_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
    expect(err.refusal.message).toContain('evil.example.com');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a non-https URL', async () => {
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://codeload.github.com/insecure.tar.gz' },
        }),
      ),
    );
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch });
    const err = await expectRefusal(callTarball(adapter, REPO, VALID_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
  });

  it('refuses when there is no tarball for the SHA (404)', async () => {
    const fetchStub = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: jsonHeaders() })));
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch });
    const err = await expectRefusal(callTarball(adapter, REPO, VALID_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
    expect(err.refusal.message).toContain('GitHub');
  });

  it('refuses on a 5xx from the tarball endpoint', async () => {
    const fetchStub = vi.fn(() => Promise.resolve(new Response('boom', { status: 503 })));
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch });
    const err = await expectRefusal(callTarball(adapter, REPO, VALID_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
  });

  it('refuses on a network timeout, retrying at most once', async () => {
    const fetchStub = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch, timeoutMs: 5 });
    const err = await expectRefusal(callTarball(adapter, REPO, VALID_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
    expect(err.refusal.message).toContain('timed out');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('enforces the byte cap while streaming', async () => {
    const body = gzipBody();
    const fetchStub = vi.fn(() => Promise.resolve(new Response(body, { status: 200 })));
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch, maxTarballBytes: 4 });

    const stream = await callTarball(adapter, REPO, VALID_SHA);
    const reader = stream.getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      })(),
    ).rejects.toMatchObject({ refusal: { code: 'github_unreachable' } });
  });
});
