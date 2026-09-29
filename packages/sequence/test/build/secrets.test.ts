import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BuildSecretsError,
  agentKeyPath,
  buildSecretsPath,
  deleteBuildSecret,
  listBuildSecretNames,
  loadAgentPrivateKey,
  readBuildSecrets,
  setBuildSecret,
} from '../../src/build/secrets.js';

const VALUE = 'ghp_SuperSecretBuildToken_0123456789';

let root: string;
let key: KeyObject;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'build-secrets-test-'));
  key = generateKeyPairSync('ed25519').privateKey;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('build secret store (SHP-REQ-125)', () => {
  it('round trips a value, per app', async () => {
    await setBuildSecret(root, key, 'toy', 'npm_token', VALUE);
    await setBuildSecret(root, key, 'toy', 'other', 'another-secret-value');
    await setBuildSecret(root, key, 'web', 'npm_token', 'web-only-value');
    const toy = await readBuildSecrets(root, key, 'toy');
    expect(toy).toEqual(new Map([['npm_token', VALUE], ['other', 'another-secret-value']]));
    expect(await readBuildSecrets(root, key, 'web')).toEqual(new Map([['npm_token', 'web-only-value']]));
    expect(await readBuildSecrets(root, key, 'none')).toEqual(new Map());
    expect(await listBuildSecretNames(root, 'toy')).toEqual(['npm_token', 'other']);
  });

  it('replaces and deletes', async () => {
    await setBuildSecret(root, key, 'toy', 'npm_token', VALUE);
    await setBuildSecret(root, key, 'toy', 'npm_token', 'replaced-value');
    expect((await readBuildSecrets(root, key, 'toy')).get('npm_token')).toBe('replaced-value');
    expect(await deleteBuildSecret(root, key, 'toy', 'npm_token')).toBe(true);
    expect(await deleteBuildSecret(root, key, 'toy', 'npm_token')).toBe(false);
    expect(await readBuildSecrets(root, key, 'toy')).toEqual(new Map());
  });

  it('writes the file 0600, and the value never appears in its bytes (plain, base64 or hex)', async () => {
    await setBuildSecret(root, key, 'toy', 'npm_token', VALUE);
    const path = buildSecretsPath(root);
    expect(path).toBe(join(root, 'agent', 'build-secrets.json'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(Buffer.from(VALUE).toString('base64'));
    expect(text).not.toContain(Buffer.from(VALUE).toString('hex'));
    expect(text).toContain('toy/npm_token');
  });

  it('is unreadable without the agent key: another key cannot decrypt it, and cannot add to it', async () => {
    await setBuildSecret(root, key, 'toy', 'npm_token', VALUE);
    const wrong = generateKeyPairSync('ed25519').privateKey;
    await expect(readBuildSecrets(root, wrong, 'toy')).rejects.toBeInstanceOf(BuildSecretsError);
    await expect(readBuildSecrets(root, wrong, 'toy')).rejects.toThrow(/cannot be decrypted/);
    await expect(setBuildSecret(root, wrong, 'toy', 'more', 'whatever-value')).rejects.toBeInstanceOf(BuildSecretsError);
  });

  it('rejects a tampered ciphertext, tag, or an entry moved to another name', async () => {
    await setBuildSecret(root, key, 'toy', 'npm_token', VALUE);
    const path = buildSecretsPath(root);
    const original = await readFile(path, 'utf8');
    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] = (buf[0] ?? 0) ^ 0x01;
      return buf.toString('base64');
    };

    for (const field of ['ct', 'tag', 'iv'] as const) {
      const file = JSON.parse(original) as { entries: Record<string, Record<string, string>> };
      const entry = file.entries['toy/npm_token'] ?? {};
      entry[field] = flip(entry[field] ?? '');
      await writeFile(path, JSON.stringify(file));
      await expect(readBuildSecrets(root, key, 'toy')).rejects.toBeInstanceOf(BuildSecretsError);
    }

    const moved = JSON.parse(original) as { entries: Record<string, unknown> };
    moved.entries['toy/renamed'] = moved.entries['toy/npm_token'];
    delete moved.entries['toy/npm_token'];
    await writeFile(path, JSON.stringify(moved));
    await expect(readBuildSecrets(root, key, 'toy')).rejects.toBeInstanceOf(BuildSecretsError);

    await writeFile(path, '{not json');
    await expect(readBuildSecrets(root, key, 'toy')).rejects.toBeInstanceOf(BuildSecretsError);
  });

  it('validates app and secret names', async () => {
    await expect(setBuildSecret(root, key, 'Bad App', 'npm_token', VALUE)).rejects.toBeInstanceOf(BuildSecretsError);
    await expect(setBuildSecret(root, key, 'toy', '../escape', VALUE)).rejects.toBeInstanceOf(BuildSecretsError);
    await expect(setBuildSecret(root, key, 'toy', 'NPM', VALUE)).rejects.toBeInstanceOf(BuildSecretsError);
    await expect(setBuildSecret(root, key, 'toy', 'ok', '')).rejects.toBeInstanceOf(BuildSecretsError);
  });

  it('loads the agent key from the agent key path, refusing a group-readable one', async () => {
    await mkdir(join(root, 'agent'), { recursive: true });
    const pem = key.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(agentKeyPath(root), pem, { mode: 0o600 });
    const loaded = await loadAgentPrivateKey(root);
    await setBuildSecret(root, loaded, 'toy', 'npm_token', VALUE);
    expect((await readBuildSecrets(root, key, 'toy')).get('npm_token')).toBe(VALUE);

    await chmod(agentKeyPath(root), 0o640);
    await expect(loadAgentPrivateKey(root)).rejects.toThrow(/chmod 600/);
    await rm(agentKeyPath(root));
    await expect(loadAgentPrivateKey(root)).rejects.toThrow(/no agent key/);
  });
});
