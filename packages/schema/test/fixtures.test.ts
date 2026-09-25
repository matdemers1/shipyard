import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';

import * as schemaExports from '../src/index.js';
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
  AppName,
  Sha40,
  ImageTag,
  Digest,
  GhRepo,
  ProjectCode,
  Argv,
  Step,
  Gate,
  ErrorCode,
  DeployTargetState,
  SignatureHeaders,
  PollRequest,
  Requester,
  DeployKind,
  DeployAccepted,
  LoginRequest,
  TotpRequest,
  EnrolRequest,
  TokenCreate,
  TokenCreated,
  DeployStatus,
  TargetProgress,
  FreezeReason,
  FreezeRequest,
  Freeze,
  FreezeInfo,
  RestoreRequest,
  RestoreCandidate,
  RestoreCandidates,
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
  appName: AppName,
  sha40: Sha40,
  imageTag: ImageTag,
  digest: Digest,
  ghRepo: GhRepo,
  projectCode: ProjectCode,
  argv: Argv,
  step: Step,
  gate: Gate,
  errorCode: ErrorCode,
  deployTargetState: DeployTargetState,
  signatureHeaders: SignatureHeaders,
  pollRequest: PollRequest,
  requester: Requester,
  deployKind: DeployKind,
  deployAccepted: DeployAccepted,
  loginRequest: LoginRequest,
  totpRequest: TotpRequest,
  enrolRequest: EnrolRequest,
  tokenCreate: TokenCreate,
  tokenCreated: TokenCreated,
  deployStatus: DeployStatus,
  targetProgress: TargetProgress,
  freezeReason: FreezeReason,
  freezeRequest: FreezeRequest,
  freeze: Freeze,
  freezeInfo: FreezeInfo,
  restoreRequest: RestoreRequest,
  restoreCandidate: RestoreCandidate,
  restoreCandidates: RestoreCandidates,
};

// Every exported value of ../src/index.js that is itself a Zod schema (as
// opposed to a helper function, a plain object such as MCP_TOOLS, or a type)
// must have a SCHEMAS entry with fixtures on disk — this is what stops the
// coverage gap from coming back.
const INDEX_SCHEMAS = (Object.entries(schemaExports) as [string, unknown][]).filter(
  (entry): entry is [string, ZodType] => entry[1] instanceof z.ZodType,
);
const SCHEMAS_BY_REFERENCE = new Set(Object.values(SCHEMAS));

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

describe('fixture completeness', () => {
  it('covers every Zod schema exported from src/index.ts', () => {
    for (const [exportName, schema] of INDEX_SCHEMAS) {
      expect(SCHEMAS_BY_REFERENCE.has(schema), `no SCHEMAS entry references the export "${exportName}"`).toBe(true);
    }
  });

  for (const [name] of Object.entries(SCHEMAS)) {
    it(`${name} has at least one valid and two invalid fixture files on disk`, () => {
      const validFiles = listFiles(join(fixturesRoot, name, 'valid'));
      const invalidFiles = listFiles(join(fixturesRoot, name, 'invalid'));
      expect(validFiles.length, `${name}/valid`).toBeGreaterThanOrEqual(1);
      expect(invalidFiles.length, `${name}/invalid`).toBeGreaterThanOrEqual(2);
    });
  }
});
