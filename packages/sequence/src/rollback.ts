import { runningDigests } from './check.js';
import { refusal } from '@shipyard/schema';
import type { Digest, Manifest, Refusal } from '@shipyard/schema';

import { ensureFreeSpace } from './disk.js';
import { composeTargetOf, imageReference, normalizeMigration, readLive } from './facts.js';
import { evaluateGates, firstRefusal } from './gates.js';
import type { Ledger } from './ledger.js';
import { AppLock, canTransition, executeTarget, result, Run } from './machine.js';
import type { MachineContext, Outcome } from './machine.js';
import { RefusalError } from './ports.js';
import type { SequencePorts } from './ports.js';
import { LABEL_MIGRATION } from './types.js';
import type { DeployRequest, DeployResult, GateFacts, GateResult, LedgerEntry, LiveState, VerifiedImage } from './types.js';

/**
 * Rollback through the agent's own ledger (SHP-T-2.6, SHP-REQ-051, SHP-REQ-052).
 *
 * - The target comes **only** from the ledger: one of the app's last five entries, not the live one
 *   (SHP-D-080). Nothing in the request names a digest; a compromised server can ask for nothing
 *   the ledger does not already hold.
 * - The CI, default-branch and ahead-of-live gates are skipped, and GitHub is never called
 *   (SHP-D-050, SHP-D-086). Disk, G8 (every recorded digest still pullable) and G10 (no release
 *   after the target carried the contract migration label) are evaluated.
 * - Image-only (SHP-D-008): no backup and no migrate. Pull → swap → check → soak run through the
 *   machine's own execution path, journaled, under the app lock; a failed check puts back what was
 *   live before the rollback. Success appends a `rollback` ledger entry with the target's digests.
 */

export interface RollbackRequest {
  /** This rollback's own ID (journal, lock, ledger entry). */
  deployId: string;
  app: string;
  /** The ledger entry to return to. */
  toDeployId: string;
  requesterLabel: string;
  dryRun?: boolean;
}

export interface ResolvedRollback {
  live: LiveState;
  gates: GateResult[];
  refusal: Refusal | null;
  images: VerifiedImage[];
  /** The ledger entry rolled back to, when the ID named a valid target. */
  entry: LedgerEntry | null;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function errMessage(err: unknown): string {
  if (err instanceof RefusalError) return err.refusal.message;
  return err instanceof Error ? err.message : String(err);
}

/** The deploy IDs a rollback of `app` may name now, newest first, with their SHAs. */
export function rollbackCandidates(ledger: Ledger, app: string): LedgerEntry[] {
  return ledger.recent(app, 5).slice(1);
}

function invalidTarget(ledger: Ledger, app: string, toDeployId: string, why: string): Refusal {
  const allowed = rollbackCandidates(ledger, app);
  const list = allowed.length === 0 ? 'there is no earlier release in the ledger to roll back to' : `allowed: ${allowed.map((e) => `${e.deployId} (${short(e.sha)})`).join(', ')}`;
  return refusal('rollback_target_invalid', `${toDeployId} ${why}; ${list}.`);
}

/**
 * The rollback's verify: the target from the ledger, then disk, G8 (pullable) and G10 (no later
 * contract release). Never touches GitHub. A dry run reads free space and prunes nothing.
 */
export async function resolveRollbackTarget(
  ports: SequencePorts,
  ledger: Ledger,
  manifest: Manifest,
  toDeployId: string,
  options: { dryRun: boolean },
): Promise<ResolvedRollback> {
  const app = manifest.name;
  let live: LiveState = { sha: ledger.last(app)?.sha ?? null, running: {} };
  const refused = (r: Refusal, gates: GateResult[] = []): ResolvedRollback => ({ live, gates, refusal: r, images: [], entry: null });

  const live_ = ledger.last(app);
  // The live entry is a target only to repair drift (SHP-D-031, "redeploy recorded"): something
  // other than the recorded digests is running, and putting the recorded release back is the fix.
  // When the recorded digests are already what runs, there is nothing to do.
  const repairingDrift = live_ !== null && live_.deployId === toDeployId;
  if (repairingDrift) {
    const running = await runningDigests(ports.docker, composeTargetOf(manifest), manifest.services);
    const matches = live_.images.every((image) => running[image.service] === image.digest);
    if (matches) {
      return refused(invalidTarget(ledger, app, toDeployId, 'is the release live now, and it is what is running: nothing to repair'));
    }
  } else if (!ledger.isRollbackTarget(app, toDeployId)) {
    const known = ledger.entries(app).some((e) => e.deployId === toDeployId);
    return refused(invalidTarget(ledger, app, toDeployId, known ? `is older than the last five releases of ${app}` : `is not in this agent's ledger for ${app}`));
  }
  const entry = ledger.entries(app).findLast((e) => e.deployId === toDeployId);
  if (entry === undefined) return refused(invalidTarget(ledger, app, toDeployId, `is not in this agent's ledger for ${app}`));

  // The recorded release must map onto the manifest as it stands: same services, same repositories.
  const services = Object.entries(manifest.services);
  const mismatch =
    entry.images.length !== services.length ||
    services.some(([service, config]) => !entry.images.some((image) => image.service === service && image.repo === config.image));
  if (mismatch) {
    return refused(invalidTarget(ledger, app, toDeployId, "records services or image repositories that no longer match the host's manifest"));
  }

  try {
    live = await readLive(ports, ledger, manifest);

    // G10: the migration label of every image in every release after the target (SHP-REQ-052).
    const laterMigrationLabels = ledger.laterThan(app, toDeployId).flatMap((later) => later.images.map((image) => image.migration));

    // G8: each recorded digest must still be pullable — fetching its config GETs the manifest by digest.
    const digests: Record<string, Digest | null> = {};
    const labels = new Map<string, Record<string, string>>();
    const unpullable: string[] = [];
    for (const image of entry.images) {
      try {
        const config = await ports.registry.imageConfig(image.repo, image.digest);
        digests[image.service] = image.digest;
        labels.set(image.service, config.labels);
      } catch (err) {
        digests[image.service] = null;
        unpullable.push(`${image.service} (${image.repo}@${image.digest}: ${errMessage(err)})`);
      }
    }

    const target = composeTargetOf(manifest);
    const freeBytes = options.dryRun
      ? await ports.docker.freeBytes()
      : (
          await ensureFreeSpace(
            ports,
            manifest,
            target,
            // The retained releases, and the release being rolled back to even when it is older.
            new Set([...ledger.retainedDigests(app, manifest.retainImages), ...entry.images.map((image) => `${image.repo}@${image.digest}`)]),
          )
        ).freeBytes;

    const facts: GateFacts = { kind: 'rollback', sha: entry.sha, manifest, live, digests, laterMigrationLabels, freeBytes };
    const gates = evaluateGates(facts).map((gate): GateResult => {
      if (gate.gate !== 'G8' || gate.pass) return gate;
      const message = `the recorded digest is no longer pullable for ${unpullable.join(', ')}`;
      return { gate: 'G8', pass: false, reason: message, refusal: refusal('image_missing', message) };
    });
    const first = firstRefusal(gates);
    if (first !== null) return refused(first, gates);

    const images: VerifiedImage[] = entry.images.map((image) => {
      const imageLabels = labels.get(image.service) ?? {};
      return {
        service: image.service,
        repo: image.repo,
        sha: entry.sha,
        digest: image.digest,
        reference: imageReference(image.repo, entry.sha, image.digest),
        labels: imageLabels,
        migration: normalizeMigration(imageLabels[LABEL_MIGRATION]),
      };
    });
    return { live, gates, refusal: null, images, entry };
  } catch (err) {
    if (err instanceof RefusalError) return refused(err.refusal);
    throw err;
  }
}

/**
 * Rolls `request.app` back to the ledger entry `request.toDeployId`. Only the app, the target's
 * deploy ID (and this rollback's ID, requester label and dry-run flag) are read from the request.
 */
export async function runRollback(ports: SequencePorts, ctx: MachineContext, request: RollbackRequest): Promise<DeployResult> {
  const dryRun = request.dryRun === true;
  const log = ports.log.child({ deployId: request.deployId, app: request.app, rollbackTo: request.toDeployId });
  // Another process (the agent, or a host CLI) may have appended since this ledger was opened.
  await ctx.ledger.refresh();
  const loaded = ctx.manifests.get(request.app);
  // For the lock holder and the result only; the target is re-read from the ledger under the lock.
  const named = ctx.ledger.entries(request.app).findLast((e) => e.deployId === request.toDeployId);
  const deployRequest: DeployRequest = {
    deployId: request.deployId,
    kind: 'rollback',
    app: request.app,
    sha: named?.sha ?? '',
    dryRun,
    requesterLabel: request.requesterLabel,
  };
  const run = new Run(ports, ctx, deployRequest, log, !dryRun && loaded !== undefined);
  const empty: Outcome = { state: 'refused', images: [], gates: [], refusal: null, schemaRevision: null, backupArtifact: null };

  await run.move('verifying', 'verify');
  if (loaded === undefined) {
    await run.move('refused');
    return result(run, { ...empty, refusal: refusal('unknown_app', `No manifest on this host for app "${request.app}".`) });
  }
  const manifest = loaded.manifest;
  const target = composeTargetOf(manifest);

  if (dryRun) {
    const resolved = await resolveRollbackTarget(ports, ctx.ledger, manifest, request.toDeployId, { dryRun: true });
    if (resolved.refusal !== null) {
      await run.move('refused');
      return result(run, { ...empty, gates: resolved.gates, refusal: resolved.refusal });
    }
    return result(run, { ...empty, state: 'verifying', gates: resolved.gates, images: resolved.images });
  }

  const acquired = await AppLock.acquire(
    ctx.dataRoot,
    request.app,
    {
      pid: process.pid,
      deployId: request.deployId,
      requesterLabel: request.requesterLabel,
      sha: deployRequest.sha,
      step: 'verify',
      at: ports.clock.now().toISOString(),
    },
    {
      ...(ctx.lockHeartbeatMs === undefined ? {} : { heartbeatMs: ctx.lockHeartbeatMs }),
      ...(ctx.lockStaleMs === undefined ? {} : { staleMs: ctx.lockStaleMs }),
    },
  );
  if (!(acquired instanceof AppLock)) {
    await run.move('refused');
    return result(run, { ...empty, refusal: acquired });
  }
  run.lock = acquired;

  try {
    await ctx.journal.begin({
      deployId: request.deployId,
      app: request.app,
      step: 'deploy',
      detail: {
        historyDeployId: request.deployId,
        composeFiles: target.files,
        project: target.project,
        sha: deployRequest.sha,
        kind: 'rollback',
        rollbackTo: request.toDeployId,
      },
    });
    let outcome: Outcome;
    try {
      outcome = await rollbackLocked(ports, ctx, run, manifest, request.toDeployId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, state: run.state }, 'rollback crashed');
      if (canTransition(run.state, 'failed')) await run.move('failed');
      else if (canTransition(run.state, 'refused')) await run.move('refused');
      outcome = { ...empty, state: run.state, refusal: refusal('step_failed', `Rollback stopped at ${run.state}: ${message}`) };
    }
    await ctx.journal.end({
      deployId: request.deployId,
      app: request.app,
      step: 'deploy',
      detail: { state: outcome.state, ...(outcome.refusal === null ? {} : { code: outcome.refusal.code }) },
    });
    return result(run, outcome);
  } finally {
    await acquired.release();
  }
}

async function rollbackLocked(ports: SequencePorts, ctx: MachineContext, run: Run, manifest: Manifest, toDeployId: string): Promise<Outcome> {
  // Nothing else can change this app's releases while its lock is held; adopt what landed before it.
  await ctx.ledger.refresh();
  const verifyRecord = await run.begin('verify', { detail: { rollbackTo: toDeployId } });
  const resolved = await resolveRollbackTarget(ports, ctx.ledger, manifest, toDeployId, { dryRun: false });
  await run.end(verifyRecord, {
    detail: {
      gates: resolved.gates.map((g) => ({ gate: g.gate, pass: g.pass })),
      ...(resolved.refusal === null
        ? {
            // Image-only: no migration runs, so restart recovery may always put the previous
            // compose file back, whatever the target's own label says.
            contract: false,
            images: resolved.images.map((image) => ({ service: image.service, repo: image.repo, digest: image.digest, migration: image.migration })),
          }
        : { refused: resolved.refusal.code }),
    },
  });
  if (resolved.refusal !== null) {
    await run.move('refused');
    return { state: 'refused', images: [], gates: resolved.gates, refusal: resolved.refusal, schemaRevision: null, backupArtifact: null };
  }
  const target = composeTargetOf(manifest);
  return executeTarget(ports, ctx, run, manifest, target, resolved.images, resolved.live, resolved.gates, { imageOnly: true });
}
