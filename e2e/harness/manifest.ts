import { parse } from 'yaml';

/**
 * The manifest shape the harness understands — the fields Shipyard's manifest will have. The real
 * validator lives in @shipyard/schema; this is a local reader so the harness has no dependency on it.
 */
export interface Manifest {
  name: string;
  repo: string;
  workflow: string;
  compose: { files: string[]; project: string };
  services: Record<string, { image: string }>;
  health: { service: string; path: string; expectSchema: string };
  soakSeconds: number;
  steps: Record<string, { service: string; argv: string[] }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`manifest: ${where} must be a non-empty string`);
  return v;
}

function rec(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`manifest: ${where} must be a mapping`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`manifest: ${where} must be a non-empty list`);
  return v.map((item, i) => str(item, `${where}[${i}]`));
}

export function parseManifest(text: string): Manifest {
  const doc = rec(parse(text) as unknown, 'the document');
  const compose = rec(doc.compose, 'compose');
  const health = rec(doc.health, 'health');
  const services: Manifest['services'] = {};
  for (const [name, svc] of Object.entries(rec(doc.services, 'services'))) {
    services[name] = { image: str(rec(svc, `services.${name}`).image, `services.${name}.image`) };
  }
  const steps: Manifest['steps'] = {};
  for (const [name, step] of Object.entries(rec(doc.steps ?? {}, 'steps'))) {
    const s = rec(step, `steps.${name}`);
    // Steps are argv arrays, never a command string.
    if (typeof s.argv === 'string') throw new Error(`manifest: steps.${name}.argv must be an argv array, not a string`);
    steps[name] = { service: str(s.service, `steps.${name}.service`), argv: strList(s.argv, `steps.${name}.argv`) };
  }
  const soak = doc.soakSeconds;
  if (typeof soak !== 'number' || !Number.isInteger(soak) || soak < 0) {
    throw new Error('manifest: soakSeconds must be a non-negative integer');
  }
  const manifest: Manifest = {
    name: str(doc.name, 'name'),
    repo: str(doc.repo, 'repo'),
    workflow: str(doc.workflow, 'workflow'),
    compose: { files: strList(compose.files, 'compose.files'), project: str(compose.project, 'compose.project') },
    services,
    health: {
      service: str(health.service, 'health.service'),
      path: str(health.path, 'health.path'),
      expectSchema: str(health.expectSchema, 'health.expectSchema'),
    },
    soakSeconds: soak,
    steps,
  };
  if (!(manifest.health.service in services)) throw new Error('manifest: health.service is not in services');
  return manifest;
}
