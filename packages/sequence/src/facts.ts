import { refusal } from '@shipyard/schema';
import type { Manifest, Refusal } from '@shipyard/schema';

import { runningDigests } from './check.js';
import { ensureFreeSpace } from './disk.js';
import { evaluateGates, firstRefusal } from './gates.js';
import type { Ledger } from './ledger.js';
import { RefusalError } from './ports.js';
import type { ComposeTarget, SequencePorts } from './ports.js';
import { loadSecrets } from './redact.js';
import { LABEL_MIGRATION } from './types.js';
import type { GateFacts, GateResult, LiveState, VerifiedImage } from './types.js';

/**
 * The verify step's fact gathering (SHP-REQ-012's "verify"). Everything the gates decide on is
 * read here through the ports, then handed to the pure evaluator. Resolving a target is kept apart
 * from executing it so a rollback (Phase 2) can supply images it pre-resolved from the ledger and
 * reuse the same execution path.
 */

export interface ResolveOptions {
  /** A dry run must change nothing: free space is read, never cleared by pruning. */
  dryRun: boolean;
  /** Overrides how env names present on the host are found. Default: the manifest's env files. */
  envNamesProvider?: ((manifest: Manifest) => Promise<string[]>) | undefined;
}

export interface ResolvedTarget {
  live: LiveState;
  gates: GateResult[];
  /** The first refusal, or null when every gate passed and every image was read. */
  refusal: Refusal | null;
  images: VerifiedImage[];
}

export function composeTargetOf(manifest: Manifest): ComposeTarget {
  return { files: [...manifest.compose.files], project: manifest.compose.project };
}

/** `repo:sha-<sha>@<digest>` — the literal written to compose (SHP-D-026). */
export function imageReference(repo: string, sha: string, digest: string): string {
  return `${repo}:sha-${sha}@${digest}`;
}

export function normalizeMigration(label: string | undefined | null): string | null {
  if (label === undefined || label === null) return null;
  const trimmed = label.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

async function envNames(ports: SequencePorts, manifest: Manifest, options: ResolveOptions): Promise<string[] | undefined> {
  if (options.envNamesProvider !== undefined) return options.envNamesProvider(manifest);
  if (manifest.envFiles === undefined && (manifest.requiredEnv ?? []).length === 0) return undefined;
  try {
    // Only the names leave this function; the values are dropped here.
    return [...(await loadSecrets(ports.fs, manifest.envFiles)).keys()];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RefusalError(refusal('env_missing', message));
  }
}

/** Reads the live state: the ledger's last SHA and the digests running now. */
export async function readLive(ports: SequencePorts, ledger: Ledger, manifest: Manifest): Promise<LiveState> {
  const last = ledger.last(manifest.name);
  const running = await runningDigests(ports.docker, composeTargetOf(manifest), manifest.services);
  return { sha: last?.sha ?? null, running };
}

/**
 * Gathers `GateFacts` for a forward deploy of `sha`, evaluates the gates, and on a pass reads each
 * image's labels. A `RefusalError` from an adapter (GitHub or the registry unreachable) becomes the
 * result's refusal — forward gates fail closed — never a crash.
 */
export async function resolveDeployTarget(
  ports: SequencePorts,
  ledger: Ledger,
  manifest: Manifest,
  sha: string,
  options: ResolveOptions,
): Promise<ResolvedTarget> {
  const target = composeTargetOf(manifest);
  let live: LiveState = { sha: ledger.last(manifest.name)?.sha ?? null, running: {} };
  let gates: GateResult[] = [];
  try {
    live = await readLive(ports, ledger, manifest);

    const workflowRuns = await ports.github.workflowRuns(manifest.repo, manifest.workflow, sha);
    const onDefaultBranch = await ports.github.compare(manifest.repo, sha, manifest.defaultBranch);
    const aheadOfLive = live.sha === null ? null : await ports.github.compare(manifest.repo, live.sha, sha);

    const digests: Record<string, string | null> = {};
    for (const [service, config] of Object.entries(manifest.services)) {
      digests[service] = await ports.registry.resolveDigest(config.image, `sha-${sha}`);
    }

    const envNamesPresent = await envNames(ports, manifest, options);

    const freeBytes = options.dryRun
      ? await ports.docker.freeBytes()
      : (await ensureFreeSpace(ports, manifest, target, ledger.knownDigests(manifest.name))).freeBytes;

    const facts: GateFacts = {
      kind: 'deploy',
      sha,
      manifest,
      live,
      workflowRuns: workflowRuns.map((run) => ({ conclusion: run.conclusion, status: run.status })),
      onDefaultBranch: onDefaultBranch === null ? null : { status: onDefaultBranch.status },
      aheadOfLive: aheadOfLive === null ? null : { status: aheadOfLive.status },
      digests,
      freeBytes,
    };
    if (envNamesPresent !== undefined) facts.envNamesPresent = envNamesPresent;

    gates = evaluateGates(facts);
    const refused = firstRefusal(gates);
    if (refused !== null) return { live, gates, refusal: refused, images: [] };

    const images: VerifiedImage[] = [];
    for (const [service, config] of Object.entries(manifest.services)) {
      const digest = digests[service];
      if (digest === null || digest === undefined) {
        // G8 passed, so this cannot happen; fail closed rather than trust it.
        return { live, gates, refusal: refusal('image_missing', `no digest for ${service}`), images: [] };
      }
      const config_ = await ports.registry.imageConfig(config.image, digest);
      images.push({
        service,
        repo: config.image,
        sha,
        digest,
        reference: imageReference(config.image, sha, digest),
        labels: config_.labels,
        migration: normalizeMigration(config_.labels[LABEL_MIGRATION]),
      });
    }
    return { live, gates, refusal: null, images };
  } catch (err) {
    if (err instanceof RefusalError) return { live, gates, refusal: err.refusal, images: [] };
    throw err;
  }
}
