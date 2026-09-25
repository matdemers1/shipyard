import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';

import * as schemaExports from '../src/index.js';
import {
  DeployRequest,
  EnrolRequest,
  TokenCreate,
  LoginRequest,
  TotpRequest,
  Requester,
  AgentReport,
  PollRequest,
  StepJournal,
  TargetResult,
  SignatureHeaders,
} from '../src/index.js';
import {
  ShipyardStatusInput,
  ShipyardDryRunInput,
  ShipyardDeployInput,
  ShipyardDeployStatusInput,
  ShipyardRollbackInput,
  MCP_TOOLS,
} from '../src/mcp.js';
import { Manifest } from '../src/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, 'fixtures');

/**
 * SHP-REQ-053: no endpoint, tool or manifest field accepts a command to
 * execute from a request. This test proves that structurally — walking each
 * request schema's rendered JSON Schema — and behaviourally, by attempting to
 * smuggle a `command` key past every request schema's parser.
 */

// ─── The request surface, named explicitly ────────────────────────────────

/**
 * Every schema a request (API, MCP or the agent → server protocol) can carry.
 * Maps each schema to the fixture directory name used across this package's
 * fixtures.test.ts, where one exists — several schemas here (SignatureHeaders,
 * AgentReport, PollRequest, StepJournal, TargetResult) are the agent protocol,
 * which the server receives, not the manifest the server never accepts.
 */
const REQUEST_SCHEMAS: Record<string, ZodType> = {
  DeployRequest,
  EnrolRequest,
  TokenCreate,
  LoginRequest,
  TotpRequest,
  Requester,
  ShipyardStatusInput,
  ShipyardDryRunInput,
  ShipyardDeployInput,
  ShipyardDeployStatusInput,
  ShipyardRollbackInput,
  AgentReport,
  PollRequest,
  StepJournal,
  TargetResult,
  SignatureHeaders,
};

const REQUEST_FIXTURE_DIR: Record<string, string> = {
  DeployRequest: 'deployRequest',
  EnrolRequest: 'enrolRequest',
  TokenCreate: 'tokenCreate',
  LoginRequest: 'loginRequest',
  TotpRequest: 'totpRequest',
  Requester: 'requester',
  ShipyardStatusInput: 'mcpStatus',
  ShipyardDryRunInput: 'mcpDryRun',
  ShipyardDeployInput: 'mcpDeploy',
  ShipyardDeployStatusInput: 'mcpDeployStatus',
  ShipyardRollbackInput: 'mcpRollback',
  AgentReport: 'agentReport',
  PollRequest: 'pollRequest',
  StepJournal: 'stepJournal',
  TargetResult: 'targetResult',
  SignatureHeaders: 'signatureHeaders',
};

describe('request schema coverage', () => {
  it('names every exported schema whose name ends in Request or Input', () => {
    const exported = (Object.entries(schemaExports) as [string, unknown][]).filter(
      (entry): entry is [string, ZodType] => entry[1] instanceof z.ZodType,
    );
    const requestLike = exported
      .map(([exportName]) => exportName)
      .filter((exportName) => /(Request|Input)$/.test(exportName));

    for (const exportName of requestLike) {
      expect(Object.keys(REQUEST_SCHEMAS), `${exportName} must be listed in REQUEST_SCHEMAS`).toContain(exportName);
    }
  });

  it('finds no command-like field in ANY exported schema, whatever it is named', () => {
    // The naming guard above only sees *Request/*Input. A request-shaped schema named otherwise
    // (FooPayload) must not slip past, so every exported schema is walked too.
    const exported = (Object.entries(schemaExports) as [string, unknown][]).filter(
      (entry): entry is [string, ZodType] => entry[1] instanceof z.ZodType,
    );
    const violations = exported.flatMap(([name, schema]) =>
      findCommandLikeFields(z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchemaNode, name),
    );
    expect(violations).toEqual([]);
  });

  it('catches camelCase and kebab-case command words', () => {
    for (const name of ['runCmd', 'shellExec', 'pre-script', 'hook_command', 'Entrypoint']) {
      expect(isCommandLike(name), name).toBe(true);
    }
    for (const name of ['requester', 'running', 'binding', 'description', 'schemaRevision', 'dryRun']) {
      expect(isCommandLike(name), name).toBe(false);
    }
  });

  it('names every MCP_TOOLS value', () => {
    const toolSchemas = new Set(Object.values(MCP_TOOLS));
    const listedSchemas = new Set(Object.values(REQUEST_SCHEMAS));
    for (const schema of toolSchemas) {
      expect(listedSchemas.has(schema), 'every MCP_TOOLS value must be listed in REQUEST_SCHEMAS').toBe(true);
    }
  });
});

// ─── The structural checker ────────────────────────────────────────────────

/** Property names that read as "a command to execute", case-insensitively. */
const COMMAND_LIKE = /(^|_)(cmd|command|commands|exec|execute|shell|script|scripts|entrypoint|run|args|argv|program|binary|bin)$/i;

/**
 * The only fields permitted to be named like a command: a host-local argv
 * array in a named compose service (never from a request), and the agent
 * reporting what it already ran. Anything else matching COMMAND_LIKE is a
 * violation.
 */
const ALLOWED_COMMAND_LIKE_PATHS = new Set([
  'Manifest.steps.backup.argv',
  'Manifest.steps.migrate.argv',
  'StepJournal.argv',
  // The manifest's step primitive itself (host-local; see Manifest.steps above).
  'Step.argv',
]);

/**
 * Command-like when the whole name, or any camelCase / snake_case / kebab-case word of it, is a
 * command word — so `runCmd`, `shell_exec` and `pre-script` are caught, not only `cmd`.
 */
function isCommandLike(name: string): boolean {
  if (COMMAND_LIKE.test(name)) return true;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0);
  // `run` alone is a command field; inside a compound (`dryRun`, `runId`) it almost never is.
  return words.some((w) => COMMAND_WORD.test(w));
}
const COMMAND_WORD = /^(cmd|command|commands|exec|execute|shell|script|scripts|entrypoint|args|argv|program|binary|bin)$/i;

interface JsonSchemaNode {
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  type?: string | string[];
  [key: string]: unknown;
}

interface Violation {
  path: string;
  reason: string;
}

/** Resolves a `$ref` such as `#/$defs/Foo` against the schema's own `$defs`. */
function resolveRef(ref: string, defs: Record<string, JsonSchemaNode>): JsonSchemaNode {
  const key = ref.replace(/^#\/\$defs\//, '');
  const resolved = defs[key];
  if (!resolved) {
    throw new Error(`unresolved $ref: ${ref}`);
  }
  return resolved;
}

/**
 * Walks a JSON Schema tree (resolving $ref/$defs, anyOf/oneOf/allOf, items,
 * properties), collecting a Violation for every property name matching
 * COMMAND_LIKE whose full path is not in the allowlist, and for every
 * allowlisted `argv` path whose type is not an array of strings.
 */
function findCommandLikeFields(schema: JsonSchemaNode, rootName: string): Violation[] {
  const defs = schema.$defs ?? {};
  const violations: Violation[] = [];
  const seen = new Set<string>();

  function walk(node: JsonSchemaNode, path: string): void {
    const visitKey = `${path}:${JSON.stringify(node.$ref ?? '')}`;
    if (seen.has(visitKey)) return;
    seen.add(visitKey);

    if (node.$ref !== undefined) {
      walk(resolveRef(node.$ref, defs), path);
      return;
    }
    for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
      walk(branch, path);
    }
    if (node.items !== undefined) {
      walk(node.items, path);
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      // A schema-typed additionalProperties (e.g. z.record value schema) is still
      // walked so a command-like field nested under it is caught too.
      if (typeof node.additionalProperties === 'object') {
        walk(node.additionalProperties, path);
      }
    }
    if (node.properties !== undefined) {
      for (const [propName, propSchema] of Object.entries(node.properties)) {
        const propPath = `${path}.${propName}`;
        if (isCommandLike(propName)) {
          if (ALLOWED_COMMAND_LIKE_PATHS.has(propPath)) {
            if (propName.toLowerCase() === 'argv') {
              const resolved = propSchema.$ref !== undefined ? resolveRef(propSchema.$ref, defs) : propSchema;
              const items = resolved.items?.$ref !== undefined ? resolveRef(resolved.items.$ref, defs) : resolved.items;
              const isStringArray = resolved.type === 'array' && items?.type === 'string';
              if (!isStringArray) {
                violations.push({ path: propPath, reason: 'allowlisted argv must be an array of strings, not a string' });
              }
            }
          } else {
            violations.push({ path: propPath, reason: `command-like property name "${propName}"` });
          }
        }
        walk(propSchema, propPath);
      }
    }
  }

  walk(schema, rootName);
  return violations;
}

/**
 * Fails if any object in the schema allows additional properties, so an
 * unknown key like `command` is rejected at parse time rather than ignored.
 */
function findNonStrictObjects(schema: JsonSchemaNode, rootName: string): Violation[] {
  const defs = schema.$defs ?? {};
  const violations: Violation[] = [];
  const seen = new Set<string>();

  function walk(node: JsonSchemaNode, path: string): void {
    const visitKey = `${path}:${JSON.stringify(node.$ref ?? '')}`;
    if (seen.has(visitKey)) return;
    seen.add(visitKey);

    if (node.$ref !== undefined) {
      walk(resolveRef(node.$ref, defs), path);
      return;
    }
    for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
      walk(branch, path);
    }
    if (node.items !== undefined) {
      walk(node.items, path);
    }
    const isObject = node.type === 'object' || node.properties !== undefined;
    if (isObject) {
      if (node.additionalProperties !== false) {
        violations.push({ path, reason: 'object allows additional properties (not a strictObject)' });
      }
    }
    if (node.properties !== undefined) {
      for (const [propName, propSchema] of Object.entries(node.properties)) {
        walk(propSchema, `${path}.${propName}`);
      }
    }
    if (typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, `${path}[additionalProperties]`);
    }
  }

  walk(schema, rootName);
  return violations;
}

describe('no command-like fields in any request schema', () => {
  for (const [name, schema] of Object.entries(REQUEST_SCHEMAS)) {
    it(`${name}: no command-like property name outside the allowlist`, () => {
      const jsonSchema = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchemaNode;
      const violations = findCommandLikeFields(jsonSchema, name);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    });

    it(`${name}: every object is strict (no additionalProperties)`, () => {
      const jsonSchema = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchemaNode;
      const violations = findNonStrictObjects(jsonSchema, name);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    });
  }

  it('the manifest allows argv only at the allowlisted paths, as an array of strings', () => {
    const jsonSchema = z.toJSONSchema(Manifest, { unrepresentable: 'any' }) as JsonSchemaNode;
    const violations = findCommandLikeFields(jsonSchema, 'Manifest');
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});

// ─── The behavioural checker ────────────────────────────────────────────────

function loadFixture(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

/** Returns every plain-object node in a value, alongside a path used only for test naming. */
function objectNodes(value: unknown, path: string): { path: string; node: Record<string, unknown> }[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, i) => objectNodes(entry, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    return [{ path, node }, ...Object.entries(node).flatMap(([key, v]) => objectNodes(v, `${path}.${key}`))];
  }
  return [];
}

/**
 * Deep-clones `fixture` with `command: 'id'` injected into the object at
 * `targetPath` (identified by reference), leaving every other node untouched.
 */
function withInjectedCommand(fixture: unknown, target: Record<string, unknown>): unknown {
  function clone(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clone);
    if (value !== null && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(node)) out[key] = clone(v);
      if (node === target) out.command = 'id';
      return out;
    }
    return value;
  }
  return clone(fixture);
}

describe('a request schema rejects an injected command field', () => {
  for (const [name, schema] of Object.entries(REQUEST_SCHEMAS)) {
    const dir = REQUEST_FIXTURE_DIR[name];
    if (dir === undefined) continue;
    const validPath = join(fixturesRoot, dir, 'valid');
    const files: string[] = (() => {
      try {
        return readdirSync(validPath).map((f: string) => join(validPath, f));
      } catch {
        return [];
      }
    })();

    for (const file of files) {
      it(`${name} (${file.slice(fixturesRoot.length)}): command injected at every nested object is rejected`, () => {
        const fixture = loadFixture(file);
        const nodes = objectNodes(fixture, name);
        expect(nodes.length, 'fixture has no object nodes to inject into').toBeGreaterThan(0);
        for (const { path, node } of nodes) {
          const mutated = withInjectedCommand(fixture, node);
          const result = schema.safeParse(mutated);
          expect(result.success, `expected rejection with command injected at ${path}`).toBe(false);
        }
      });
    }
  }
});

// ─── Self-test: proves the checkers catch a regression ────────────────────

describe('self-test: the checkers catch a regression', () => {
  it('flags a schema with a shell field added', () => {
    const Regressed = DeployRequest.extend({ shell: z.string() });
    const jsonSchema = z.toJSONSchema(Regressed, { unrepresentable: 'any' }) as JsonSchemaNode;
    const violations = findCommandLikeFields(jsonSchema, 'Regressed');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.path.endsWith('.shell'))).toBe(true);
  });

  it('flags a non-strict object', () => {
    const Loose = z.looseObject({ app: z.string() }); // not strictObject: allows unknown keys
    const jsonSchema = z.toJSONSchema(Loose, { unrepresentable: 'any' }) as JsonSchemaNode;
    const violations = findNonStrictObjects(jsonSchema, 'Loose');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('flags an allowlisted argv path that becomes a string instead of an array', () => {
    const jsonSchema: JsonSchemaNode = {
      type: 'object',
      properties: {
        steps: {
          type: 'object',
          properties: {
            backup: {
              type: 'object',
              properties: { argv: { type: 'string' } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const violations = findCommandLikeFields(jsonSchema, 'Manifest');
    expect(violations.some((v) => v.path === 'Manifest.steps.backup.argv')).toBe(true);
  });

  it('a schema with an injected command key is rejected by the behavioural check', () => {
    const fixturePath = join(fixturesRoot, 'deployRequest', 'valid', 'deploy-app.json');
    const fixture = loadFixture(fixturePath);
    const mutated = { ...(fixture as Record<string, unknown>), command: 'id' };
    expect(DeployRequest.safeParse(mutated).success).toBe(false);
  });
});
