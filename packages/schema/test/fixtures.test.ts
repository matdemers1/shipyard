import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import {
  Manifest,
  ErrorEnvelope,
  Refusal,
  AgentReport,
  PollResponse,
  StepJournal,
  TargetResult,
  DeployRequest,
  HealthResponse,
} from '../src/index.js';
import {
  ShipyardStatusInput,
  ShipyardDryRunInput,
  ShipyardDeployInput,
  ShipyardDeployStatusInput,
  ShipyardRollbackInput,
} from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, 'fixtures');

// Each entry names a fixture directory under test/fixtures/<name> and the
// schema every file in it should be checked against.
const SCHEMAS: Record<string, ZodType> = {
  manifest: Manifest,
  errorEnvelope: ErrorEnvelope,
  refusal: Refusal,
  agentReport: AgentReport,
  pollResponse: PollResponse,
  stepJournal: StepJournal,
  targetResult: TargetResult,
  deployRequest: DeployRequest,
  healthResponse: HealthResponse,
  mcpStatus: ShipyardStatusInput,
  mcpDryRun: ShipyardDryRunInput,
  mcpDeploy: ShipyardDeployInput,
  mcpDeployStatus: ShipyardDeployStatusInput,
  mcpRollback: ShipyardRollbackInput,
};

function loadFixture(path: string): unknown {
  const text = readFileSync(path, 'utf-8');
  return path.endsWith('.yaml') || path.endsWith('.yml') ? parseYaml(text) : (JSON.parse(text) as unknown);
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

describe('fixtures', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const validDir = join(fixturesRoot, name, 'valid');
    const invalidDir = join(fixturesRoot, name, 'invalid');
    const validFiles = listFiles(validDir);
    const invalidFiles = listFiles(invalidDir);

    describe(name, () => {
      it('has at least one valid and two invalid fixtures', () => {
        expect(validFiles.length).toBeGreaterThanOrEqual(1);
        expect(invalidFiles.length).toBeGreaterThanOrEqual(2);
      });

      for (const file of validFiles) {
        it(`accepts ${file.slice(fixturesRoot.length)}`, () => {
          const data = loadFixture(file);
          const result = schema.safeParse(data);
          expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
        });
      }

      for (const file of invalidFiles) {
        it(`rejects ${file.slice(fixturesRoot.length)}`, () => {
          const data = loadFixture(file);
          const result = schema.safeParse(data);
          expect(result.success).toBe(false);
        });
      }
    });
  }
});
