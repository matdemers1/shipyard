import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../../src/deps.js';
import { buildMcpServer } from '../../src/mcp/tools.js';

/**
 * SHP-T-13.3 (SHP-REQ-165): the MCP tool descriptions use the console's vocabulary — Deploy, Live,
 * Waiting, Ready, CI, Images, Checks, Refused, Rolled back, Soak, Drift, Frozen — so a connected
 * Claude and the console never name one thing two ways. Registering tools reads only the version
 * from the config and nothing touches the database until a tool is called, so this needs no DB.
 */

const deps = { config: { SHIPYARD_VERSION: 'test' } } as unknown as ServiceDeps;

const EXPECTED_TOOLS = [
  'shipyard_build',
  'shipyard_build_status',
  'shipyard_deploy',
  'shipyard_deploy_status',
  'shipyard_dry_run',
  'shipyard_rollback',
  'shipyard_status',
];

let client: Client | undefined;

async function listTools(): Promise<{ name: string; title?: string | undefined; description?: string | undefined }[]> {
  const server = buildMcpServer(deps, { tokenApps: new Set<string>() } as never, new AbortController().signal);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'words-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return (await client.listTools()).tools;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('MCP tool descriptions (SHP-REQ-165)', () => {
  it('keeps the seven tool names, which connected sessions depend on', async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('uses no retired word: not "ship" as a verb, not "Roll all", not "Confirm"', async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const text = `${tool.title ?? ''} ${tool.description ?? ''}`;
      expect(text, tool.name).not.toMatch(/\bship(s|ped|ping|pable)?\b/i);
      expect(text, tool.name).not.toMatch(/\broll all\b/i);
      expect(text, tool.name).not.toMatch(/\bconfirm\b/i);
      expect(text, tool.name).not.toMatch(/\bgates?\b/i);
    }
  });

  it('describes every tool, in the shared words where it speaks of them', async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.description ?? '']));
    for (const name of EXPECTED_TOOLS) expect(byName.get(name)?.length, name).toBeGreaterThan(40);
    expect(byName.get('shipyard_deploy')).toMatch(/refuses it before anything changes/);
    expect(byName.get('shipyard_deploy')).toMatch(/rolled back/);
    expect(byName.get('shipyard_dry_run')).toMatch(/every deploy check/);
    expect(byName.get('shipyard_deploy_status')).toMatch(/rolled\s+back or refused/);
    expect(byName.get('shipyard_rollback')).toMatch(/^Rolls `app` back/);
  });
});
