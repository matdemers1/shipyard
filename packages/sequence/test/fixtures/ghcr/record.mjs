#!/usr/bin/env node
// Re-records the GHCR fixtures in this directory against the real, public
// `ghcr.io/matdemers1/shipyard/server` image. Run with:
//
//   node test/fixtures/ghcr/record.mjs
//
// Each fixture is a small JSON envelope `{ status, headers, body }` so the test suite can replay
// it through an injected `fetch` without any network access. No credentials are needed — the image
// is public (SHP-D-043) and every request here is anonymous.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));

const HOST = 'ghcr.io';
const REPO = 'matdemers1/shipyard/server';
const TAG = 'sha-30593dd333296f7f9ef5613ea1c211e9f32d310b';
const MISSING_TAG = 'sha-0000000000000000000000000000000000000000';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

function headersToObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}

async function writeFixture(name, envelope) {
  await writeFile(join(DIR, name), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  console.log(`wrote ${name}`);
}

async function main() {
  // 1. The 401 challenge that starts the anonymous bearer flow.
  const challenge = await fetch(`https://${HOST}/v2/${REPO}/manifests/${TAG}`, {
    method: 'HEAD',
    headers: { Accept: MANIFEST_ACCEPT },
  });
  await writeFixture('www-authenticate-401.json', {
    status: challenge.status,
    headers: headersToObject(challenge.headers),
  });

  // 2. The anonymous token, from the realm/service/scope in that challenge.
  const tokenRes = await fetch(
    `https://${HOST}/token?service=${HOST}&scope=repository:${REPO}:pull`,
  );
  const tokenBody = await tokenRes.json();
  await writeFixture('token.json', { status: tokenRes.status, body: tokenBody });
  const token = tokenBody.token;

  // 3. HEAD the tag's manifest, authenticated. Docker-Content-Digest is the digest under test.
  const headRes = await fetch(`https://${HOST}/v2/${REPO}/manifests/${TAG}`, {
    method: 'HEAD',
    headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
  });
  await writeFixture('head-manifest.json', {
    status: headRes.status,
    headers: headersToObject(headRes.headers),
  });
  const digest = headRes.headers.get('docker-content-digest');

  // 4. GET the manifest by digest — an OCI index for a buildx-published image.
  const indexRes = await fetch(`https://${HOST}/v2/${REPO}/manifests/${digest}`, {
    headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
  });
  const indexBody = await indexRes.json();
  await writeFixture('index.json', {
    status: indexRes.status,
    headers: { 'content-type': indexRes.headers.get('content-type') ?? '' },
    body: indexBody,
  });

  // 5. GET the linux/amd64 manifest named in the index.
  const amd64Entry = indexBody.manifests.find(
    (m) => m.platform?.architecture === 'linux' || m.platform?.architecture === 'amd64',
  ) ?? indexBody.manifests.find((m) => m.platform?.architecture === 'amd64');
  const amd64Digest = amd64Entry.digest;
  const manifestRes = await fetch(`https://${HOST}/v2/${REPO}/manifests/${amd64Digest}`, {
    headers: {
      Accept: 'application/vnd.oci.image.manifest.v1+json',
      Authorization: `Bearer ${token}`,
    },
  });
  const manifestBody = await manifestRes.json();
  await writeFixture('manifest-amd64.json', {
    status: manifestRes.status,
    headers: { 'content-type': manifestRes.headers.get('content-type') ?? '' },
    body: manifestBody,
  });

  // 6. GET the config blob (redirects to a CDN; `fetch` follows redirects by default).
  const configDigest = manifestBody.config.digest;
  const configRes = await fetch(`https://${HOST}/v2/${REPO}/blobs/${configDigest}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const configBody = await configRes.json();
  await writeFixture('config-blob.json', {
    status: configRes.status,
    body: configBody,
  });

  // 7. A tag that has never been published: the missing-tag 404.
  const missingRes = await fetch(`https://${HOST}/v2/${REPO}/manifests/${MISSING_TAG}`, {
    method: 'HEAD',
    headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
  });
  await writeFixture('missing-manifest-404.json', {
    status: missingRes.status,
    headers: headersToObject(missingRes.headers),
  });

  console.log(`digest under test: ${digest}`);
  console.log(`amd64 manifest digest: ${amd64Digest}`);
  console.log(`config digest: ${configDigest}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
