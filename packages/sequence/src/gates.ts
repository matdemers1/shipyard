import { refusal } from '@shipyard/schema';
import type { Refusal } from '@shipyard/schema';

import type { GateFacts, GateId, GateResult } from './types.js';

/**
 * The gate evaluator (SHP-T-1.4): a pure function over `GateFacts`, gathered beforehand by the
 * machine through the ports. Order matters for `firstRefusal` (SHP-REQ-031): disk, G5, G6, G7,
 * G8, G9, G10. A gate that does not apply to this deploy kind is omitted from the result, not
 * reported as a pass.
 */

const GATE_ORDER: GateId[] = ['disk', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'];

function short(sha: string): string {
  return sha.slice(0, 7);
}

function evaluateDisk(facts: GateFacts): GateResult {
  const floorBytes = facts.manifest.diskFloorGb * 1024 ** 3;
  if (facts.freeBytes >= floorBytes) {
    return { gate: 'disk', pass: true, reason: 'free space is at or above the manifest floor' };
  }
  const freeDescription = Number.isFinite(facts.freeBytes) && facts.freeBytes >= 0
    ? `${(facts.freeBytes / 1024 ** 3).toFixed(1)} GB free`
    : 'free space unknown';
  const message = `${freeDescription} is below the manifest's ${facts.manifest.diskFloorGb} GB floor after pruning Shipyard-known old images`;
  return {
    gate: 'disk',
    pass: false,
    reason: message,
    refusal: refusal('insufficient_disk', message),
  };
}

function evaluateG5(facts: GateFacts): GateResult {
  const runs = facts.workflowRuns;
  if (runs === undefined) {
    throw new Error('G5 requires workflowRuns on deploy facts');
  }
  const sha7 = short(facts.sha);
  if (runs.length === 0) {
    const message = `no run of ${facts.manifest.workflow} for ${sha7} (absent is not green)`;
    return { gate: 'G5', pass: false, reason: message, refusal: refusal('ci_not_green', message) };
  }
  if (runs.some((run) => run.conclusion === 'success')) {
    return { gate: 'G5', pass: true, reason: `${facts.manifest.workflow} succeeded for ${sha7}` };
  }
  const stillRunning = runs.find((run) => run.status !== 'completed');
  if (stillRunning) {
    const message = `${facts.manifest.workflow} for ${sha7} is still in progress (status ${stillRunning.status})`;
    return { gate: 'G5', pass: false, reason: message, refusal: refusal('ci_not_green', message) };
  }
  const conclusions = [...new Set(runs.map((run) => run.conclusion ?? 'unknown'))].join(', ');
  const message = `${facts.manifest.workflow} for ${sha7} concluded ${conclusions}, not success`;
  return { gate: 'G5', pass: false, reason: message, refusal: refusal('ci_not_green', message) };
}

function evaluateG6(facts: GateFacts): GateResult {
  const onDefaultBranch = facts.onDefaultBranch;
  if (onDefaultBranch === undefined) {
    throw new Error('G6 requires onDefaultBranch on deploy facts');
  }
  const sha7 = short(facts.sha);
  if (onDefaultBranch !== null && (onDefaultBranch.status === 'ahead' || onDefaultBranch.status === 'identical')) {
    return { gate: 'G6', pass: true, reason: `${sha7} is on ${facts.manifest.defaultBranch}` };
  }
  const status = onDefaultBranch === null ? 'unknown to GitHub' : onDefaultBranch.status;
  const message = `${sha7} is not on ${facts.manifest.defaultBranch} (${status})`;
  return { gate: 'G6', pass: false, reason: message, refusal: refusal('not_on_default_branch', message) };
}

function evaluateG7(facts: GateFacts): GateResult {
  const aheadOfLive = facts.aheadOfLive;
  if (facts.live.sha === null) {
    return { gate: 'G7', pass: true, reason: 'first Shipyard deploy for this app' };
  }
  if (aheadOfLive === undefined) {
    throw new Error('G7 requires aheadOfLive on deploy facts');
  }
  const sha7 = short(facts.sha);
  const liveSha7 = short(facts.live.sha);
  if (aheadOfLive !== null && aheadOfLive.status === 'ahead') {
    return { gate: 'G7', pass: true, reason: `${sha7} is ahead of live ${liveSha7}` };
  }
  if (aheadOfLive !== null && aheadOfLive.status === 'identical') {
    const message = `${sha7} is already live`;
    return {
      gate: 'G7',
      pass: false,
      reason: message,
      refusal: refusal('not_ahead_of_live', message),
    };
  }
  const status = aheadOfLive === null ? 'unknown to GitHub' : aheadOfLive.status;
  const message = `${sha7} is not ahead of live ${liveSha7} (${status})`;
  const fix = `live is ${liveSha7}; request a descendant, or use rollback`;
  return { gate: 'G7', pass: false, reason: message, refusal: refusal('not_ahead_of_live', message, fix) };
}

function evaluateG8(facts: GateFacts): GateResult {
  const missing = Object.keys(facts.manifest.services).filter(
    (service) => facts.digests[service] === null || facts.digests[service] === undefined,
  );
  if (missing.length === 0) {
    return { gate: 'G8', pass: true, reason: 'every mapped service has a resolved digest' };
  }
  const sha7 = short(facts.sha);
  const message = `missing sha-${facts.sha} digest in GHCR for ${missing.join(', ')} (SHA ${sha7})`;
  return { gate: 'G8', pass: false, reason: message, refusal: refusal('image_missing', message) };
}

/** Every required env name, in order, with the label(s) it should carry in the refusal message. */
function requiredEnvSources(facts: GateFacts): { name: string; sources: string[] }[] {
  const bySource = new Map<string, string[]>();
  const add = (name: string, source: string): void => {
    const sources = bySource.get(name);
    if (sources === undefined) bySource.set(name, [source]);
    else if (!sources.includes(source)) sources.push(source);
  };
  for (const name of facts.manifest.requiredEnv ?? []) add(name, 'manifest requiredEnv');
  for (const [service, names] of Object.entries(facts.declaredEnv ?? {})) {
    for (const name of names) add(name, `declared by ${service} image`);
  }
  return [...bySource.entries()].map(([name, sources]) => ({ name, sources }));
}

function evaluateG9(facts: GateFacts): GateResult | null {
  if (facts.envNamesPresent === undefined) return null;
  const required = requiredEnvSources(facts);
  if (required.length === 0) return null;
  const present = new Set(facts.envNamesPresent);
  const missing = required.filter(({ name }) => !present.has(name));
  if (missing.length === 0) {
    return { gate: 'G9', pass: true, reason: 'every required env name is present' };
  }
  const message = `missing required env ${missing.map(({ name, sources }) => `${name} (${sources.join(', ')})`).join(', ')}`;
  const noEnvFiles = (facts.manifest.envFiles ?? []).length === 0;
  const fix = noEnvFiles
    ? 'the manifest names no env files; add one under envFiles carrying these names and retry'
    : undefined;
  return { gate: 'G9', pass: false, reason: message, refusal: refusal('env_missing', message, fix) };
}

function evaluateG10(facts: GateFacts): GateResult | null {
  if (facts.laterMigrationLabels === undefined) {
    // Unknown later releases must never read as "none": a rollback across a contract release
    // destroys data, so a caller that did not gather the labels is a programming error.
    if (facts.kind === 'rollback') throw new Error('G10 requires laterMigrationLabels on rollback facts');
    return null;
  }
  const normalized = facts.laterMigrationLabels.map((label) => label?.trim().toLowerCase() ?? null);
  if (!normalized.includes('contract')) {
    return { gate: 'G10', pass: true, reason: 'no later release carries a contract migration label' };
  }
  const message = `a release deployed after ${short(facts.sha)} carried the contract migration label`;
  const fix = 'a contract-migrating release exists after this one; use restore, not rollback';
  return { gate: 'G10', pass: false, reason: message, refusal: refusal('later_contract_release', message, fix) };
}

/** Evaluates every applicable gate in order. A gate that does not apply is omitted. */
export function evaluateGates(facts: GateFacts): GateResult[] {
  const results: GateResult[] = [];
  for (const gate of GATE_ORDER) {
    switch (gate) {
      case 'disk':
        results.push(evaluateDisk(facts));
        break;
      case 'G5':
        if (facts.kind === 'deploy') results.push(evaluateG5(facts));
        break;
      case 'G6':
        if (facts.kind === 'deploy') results.push(evaluateG6(facts));
        break;
      case 'G7':
        if (facts.kind === 'deploy') results.push(evaluateG7(facts));
        break;
      case 'G8':
        results.push(evaluateG8(facts));
        break;
      case 'G9': {
        const result = evaluateG9(facts);
        if (result) results.push(result);
        break;
      }
      case 'G10':
        if (facts.kind === 'rollback') {
          const result = evaluateG10(facts);
          if (result) results.push(result);
        }
        break;
    }
  }
  return results;
}

/** The first refusal in gate order, or null when every evaluated gate passed. */
export function firstRefusal(results: GateResult[]): Refusal | null {
  for (const gate of GATE_ORDER) {
    const result = results.find((r) => r.gate === gate);
    if (result && !result.pass && result.refusal) {
      return result.refusal;
    }
  }
  return null;
}
