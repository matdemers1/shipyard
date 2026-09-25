import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ErrorCode } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';

import { evaluateGates, firstRefusal } from '../src/gates.js';
import type { Manifest } from '../src/ports.js';
import type { DeployKind, GateFacts, GateId, LiveState } from '../src/types.js';

/**
 * Golden decision tables (SHP-T-1.4): each JSON file under `golden/gates/` is an array of cases
 * `{ name, facts, expect: [{ gate, pass, code? }] }`. `facts` is a partial override merged onto a
 * pass-everything base so each fixture stays focused on the branch it exercises. `expect` is the
 * *exhaustive* set of gates the case evaluates — a gate the golden case omits must also be absent
 * from `evaluateGates`'s result, which is how the rollback skip behaviour gets proven.
 */

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'golden/gates');

interface ExpectedGate {
  gate: GateId;
  pass: boolean;
  code?: ErrorCode;
}

/** A case's `facts` field, loosened from `GateFacts` so a fixture only names what it overrides. */
interface FactsOverride {
  kind?: DeployKind;
  sha?: string;
  manifest?: Partial<Manifest>;
  live?: Partial<LiveState>;
  workflowRuns?: GateFacts['workflowRuns'];
  onDefaultBranch?: GateFacts['onDefaultBranch'];
  aheadOfLive?: GateFacts['aheadOfLive'];
  digests?: GateFacts['digests'];
  envNamesPresent?: GateFacts['envNamesPresent'];
  declaredEnv?: GateFacts['declaredEnv'];
  laterMigrationLabels?: GateFacts['laterMigrationLabels'];
  freeBytes?: number;
}

interface GoldenCase {
  name: string;
  facts: FactsOverride;
  expect: ExpectedGate[];
  /** Present only in combined.json: the code `firstRefusal` should return, or null for none. */
  firstRefusalCode?: ErrorCode | null;
}

const SHA = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    name: 'demo',
    repo: 'acme/demo',
    defaultBranch: 'main',
    workflow: '.github/workflows/image.yml',
    compose: { files: ['/opt/demo/compose.yaml'], project: 'demo' },
    services: { web: { image: 'ghcr.io/acme/demo/web' } },
    health: { service: 'web', port: 3000, path: '/health' },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
    ...overrides,
  };
}

function baseFactsForKind(kind: DeployKind): GateFacts {
  const manifest = baseManifest();
  const digests = { web: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' };
  const freeBytes = 10 * 1024 ** 3;
  if (kind === 'deploy') {
    return {
      kind,
      sha: SHA,
      manifest,
      live: { sha: null, running: {} },
      workflowRuns: [{ conclusion: 'success', status: 'completed' }],
      onDefaultBranch: { status: 'identical' },
      aheadOfLive: null,
      digests,
      freeBytes,
    };
  }
  return {
    kind,
    sha: SHA,
    manifest,
    live: { sha: SHA, running: {} },
    digests,
    freeBytes,
  };
}

/** Builds full GateFacts for a golden case, merging its override onto the pass-everything base. */
function buildFacts(override: FactsOverride): GateFacts {
  const kind: DeployKind = override.kind ?? 'deploy';
  const base = baseFactsForKind(kind);
  const { manifest: manifestOverride, live: liveOverride, ...rest } = override;
  return {
    ...base,
    ...rest,
    manifest: manifestOverride ? baseManifest(manifestOverride) : base.manifest,
    live: liveOverride ? { ...base.live, ...liveOverride } : base.live,
  } as GateFacts;
}

function loadGoldenFile(file: string): GoldenCase[] {
  const text = readFileSync(join(goldenDir, file), 'utf-8');
  return JSON.parse(text) as GoldenCase[];
}

const GOLDEN_FILES = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort();

describe('gate golden decision tables', () => {
  expect(GOLDEN_FILES.length).toBeGreaterThan(0);

  for (const file of GOLDEN_FILES) {
    describe(file, () => {
      const cases = loadGoldenFile(file);
      expect(cases.length).toBeGreaterThan(0);

      for (const goldenCase of cases) {
        it(goldenCase.name, () => {
          const facts = buildFacts(goldenCase.facts);
          const results = evaluateGates(facts);

          // The exact set of gates evaluated must match the golden case exactly — this is what
          // proves a skipped gate (e.g. G5-G7 on a rollback) is truly omitted, not just passing.
          const actualGates = results.map((r) => r.gate).sort();
          const expectedGates = goldenCase.expect.map((e) => e.gate).sort();
          expect(actualGates).toEqual(expectedGates);

          for (const expected of goldenCase.expect) {
            const actual = results.find((r) => r.gate === expected.gate);
            expect(actual, `expected a result for gate ${expected.gate}`).toBeDefined();
            expect(actual?.pass, `gate ${expected.gate} pass`).toBe(expected.pass);
            if (expected.code) {
              expect(actual?.refusal?.code, `gate ${expected.gate} refusal code`).toBe(expected.code);
            } else {
              expect(actual?.refusal, `gate ${expected.gate} should not carry a refusal`).toBeUndefined();
            }
          }

          if (goldenCase.firstRefusalCode !== undefined) {
            const refusal = firstRefusal(results);
            if (goldenCase.firstRefusalCode === null) {
              expect(refusal).toBeNull();
            } else {
              expect(refusal?.code).toBe(goldenCase.firstRefusalCode);
            }
          }
        });
      }
    });
  }
});

describe('refusal shape and specificity', () => {
  const allRefusals = GOLDEN_FILES.flatMap((file) =>
    loadGoldenFile(file).flatMap((goldenCase) => {
      const facts = buildFacts(goldenCase.facts);
      return evaluateGates(facts)
        .filter((r) => !r.pass)
        .map((r) => ({ result: r, caseName: goldenCase.name, file }));
    }),
  );

  it('produced at least one refusal to check', () => {
    expect(allRefusals.length).toBeGreaterThan(0);
  });

  for (const { result, caseName, file } of allRefusals) {
    it(`${file} :: ${caseName} :: ${result.gate} refusal has a non-empty code, gate, message and fix`, () => {
      expect(result.refusal).toBeDefined();
      const refusal = result.refusal;
      if (!refusal) return;
      expect(refusal.code.length).toBeGreaterThan(0);
      expect(refusal.gate.length).toBeGreaterThan(0);
      expect(refusal.message.length).toBeGreaterThan(0);
      expect(refusal.fix.length).toBeGreaterThan(0);
    });
  }

  it('G5 refusal messages name the workflow and the short SHA', () => {
    const facts = buildFacts({ workflowRuns: [] });
    const result = evaluateGates(facts).find((r) => r.gate === 'G5');
    expect(result?.refusal?.message).toContain('.github/workflows/image.yml');
    expect(result?.refusal?.message).toContain('c0ffeec');
  });

  it('G6 refusal messages name the short SHA and the default branch', () => {
    const facts = buildFacts({ onDefaultBranch: { status: 'behind' } });
    const result = evaluateGates(facts).find((r) => r.gate === 'G6');
    expect(result?.refusal?.message).toContain('c0ffeec');
    expect(result?.refusal?.message).toContain('main');
  });

  it('G7 refusal fix names the live SHA', () => {
    const facts = buildFacts({
      live: { sha: 'facadefacadefacadefacadefacadefacadeface' },
      aheadOfLive: { status: 'behind' },
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G7');
    expect(result?.refusal?.fix).toContain('facadef');
  });

  it('G8 refusal message names the missing service', () => {
    const facts = buildFacts({
      manifest: { services: { web: { image: 'ghcr.io/acme/demo/web' }, worker: { image: 'ghcr.io/acme/demo/worker' } } },
      digests: { web: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' },
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G8');
    expect(result?.refusal?.message).toContain('worker');
  });

  it('G9 refusal message names the missing env variable', () => {
    const facts = buildFacts({
      manifest: { requiredEnv: ['DATABASE_URL', 'API_KEY'] },
      envNamesPresent: ['DATABASE_URL'],
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G9');
    expect(result?.refusal?.message).toContain('API_KEY');
  });

  it('G9 refuses on a name an image declares that is absent, naming which image declared it', () => {
    const facts = buildFacts({
      envNamesPresent: ['DATABASE_URL'],
      declaredEnv: { server: ['SMTP_HOST'] },
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G9');
    expect(result?.pass).toBe(false);
    expect(result?.refusal?.code).toBe('env_missing');
    expect(result?.refusal?.message).toContain('SMTP_HOST');
    expect(result?.refusal?.message).toContain('declared by server image');
  });

  it('G9 passes when an image-declared name is present even though nothing was required by the manifest', () => {
    const facts = buildFacts({
      envNamesPresent: ['SMTP_HOST'],
      declaredEnv: { server: ['SMTP_HOST'] },
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G9');
    expect(result?.pass).toBe(true);
  });

  it('G9 union of manifest requiredEnv and image-declared names names each source', () => {
    const facts = buildFacts({
      manifest: { requiredEnv: ['API_KEY'] },
      envNamesPresent: [],
      declaredEnv: { server: ['SMTP_HOST'] },
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G9');
    expect(result?.refusal?.message).toContain('API_KEY (manifest requiredEnv)');
    expect(result?.refusal?.message).toContain('SMTP_HOST (declared by server image)');
  });

  it('G9 names a variable required by both the manifest and an image with both sources', () => {
    const facts = buildFacts({
      manifest: { requiredEnv: ['SMTP_HOST'] },
      envNamesPresent: [],
      declaredEnv: { server: ['SMTP_HOST'] },
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G9');
    expect(result?.refusal?.message).toContain('SMTP_HOST (manifest requiredEnv, declared by server image)');
  });

  it('G9 refusal says so when names are required but the manifest names no env files', () => {
    const facts = buildFacts({
      manifest: { requiredEnv: ['API_KEY'] },
      envNamesPresent: [],
    });
    const result = evaluateGates(facts).find((r) => r.gate === 'G9');
    expect(result?.refusal?.fix.toLowerCase()).toContain('no env files');
  });

  it('G9 is not evaluated for a rollback that never gathered declaredEnv (image-only rollback unblocked)', () => {
    const facts = buildFacts({ kind: 'rollback', manifest: { requiredEnv: ['API_KEY'] }, laterMigrationLabels: [] });
    const result = evaluateGates(facts).find((r) => r.gate === 'G9');
    expect(result).toBeUndefined();
  });

  it('G10 refusal fix points at restore', () => {
    const facts = buildFacts({ kind: 'rollback', laterMigrationLabels: ['contract'] });
    const result = evaluateGates(facts).find((r) => r.gate === 'G10');
    expect(result?.refusal?.fix.toLowerCase()).toContain('restore');
  });

  it('disk refusal message names free space and the floor in GB', () => {
    const facts = buildFacts({ freeBytes: 1024 });
    const result = evaluateGates(facts).find((r) => r.gate === 'disk');
    expect(result?.refusal?.message).toContain('GB');
  });

  it('disk refusal message says free space is unknown when freeBytes is NaN', () => {
    const facts = buildFacts({ freeBytes: NaN });
    const result = evaluateGates(facts).find((r) => r.gate === 'disk');
    expect(result?.refusal?.message).toContain('free space unknown');
  });

  it('disk refusal message says free space is unknown when freeBytes is negative', () => {
    const facts = buildFacts({ freeBytes: -1 });
    const result = evaluateGates(facts).find((r) => r.gate === 'disk');
    expect(result?.refusal?.message).toContain('free space unknown');
  });

  it('G10 treats the migration label as case-insensitive and trims whitespace', () => {
    for (const label of ['CONTRACT', ' contract ', 'Contract', '\tcontract\n']) {
      const facts = buildFacts({ kind: 'rollback', laterMigrationLabels: [label] });
      const result = evaluateGates(facts).find((r) => r.gate === 'G10');
      expect(result?.pass, `label ${JSON.stringify(label)} should refuse`).toBe(false);
      expect(result?.refusal?.code).toBe('later_contract_release');
    }
  });

  it('G10 does not fail-open on labels that merely contain "contract" as a substring', () => {
    const facts = buildFacts({ kind: 'rollback', laterMigrationLabels: ['contract-ish', 'noncontract'] });
    const result = evaluateGates(facts).find((r) => r.gate === 'G10');
    expect(result?.pass).toBe(true);
  });
});

describe('programming errors', () => {
  it('throws when deploy facts are missing workflowRuns', () => {
    const facts: GateFacts = { ...buildFacts({}) };
    delete facts.workflowRuns;
    expect(() => evaluateGates(facts)).toThrow();
  });

  it('throws when deploy facts are missing onDefaultBranch', () => {
    const facts: GateFacts = { ...buildFacts({}) };
    delete facts.onDefaultBranch;
    expect(() => evaluateGates(facts)).toThrow();
  });

  it('throws when deploy facts have a live SHA but are missing aheadOfLive', () => {
    const facts: GateFacts = { ...buildFacts({ live: { sha: 'facadefacadefacadefacadefacadefacadeface' } }) };
    delete facts.aheadOfLive;
    expect(() => evaluateGates(facts)).toThrow();
  });
});

describe('G10 without facts', () => {
  it('throws for a rollback whose later migration labels were not gathered, rather than passing', () => {
    const facts = buildFacts({ kind: 'rollback' });
    delete (facts as { laterMigrationLabels?: unknown }).laterMigrationLabels;
    expect(() => evaluateGates(facts)).toThrow(/laterMigrationLabels/);
  });
});
