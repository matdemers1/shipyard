import { unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { refusal, RESTORE_ARTIFACT_TOKEN, lossWindowText } from '@shipyard/schema';
import type { Digest, Manifest, Refusal } from '@shipyard/schema';
import { stringify as stringifyYaml } from 'yaml';

import { ensureFreeSpace } from './disk.js';
import { composeTargetOf, imageReference, normalizeMigration, readLive } from './facts.js';
import { evaluateGates, firstRefusal } from './gates.js';
import type { BackupArtifactRecord, Ledger } from './ledger.js';
import { AppLock, canTransition, pollCheck, result, Run, soak } from './machine.js';
import type { MachineContext, Outcome } from './machine.js';
import { RefusalError } from './ports.js';
import type { ComposeTarget, SequencePorts } from './ports.js';
import { loadSecrets, redact } from './redact.js';
import { applyRewrite, planRewrite } from './rewrite.js';
import { runBackup } from './steps.js';
import { LABEL_MIGRATION } from './types.js';
import type { DeployRequest, DeployResult, GateFacts, GateResult, LedgerEntry, LiveState, VerifiedImage } from './types.js';

/**
 * Guided restore (SHP-T-5.6, SHP-D-038): the app's own restore command against a backup a deploy
 * took. Always a confirmed human act — nothing in the engine ever starts one (SHP-D-008).
 *
 * - **Ledger only** (SHP-REQ-085, SHP-D-080): the artifact is found by the deploy ID that took it,
 *   in this agent's own ledger. The request never names a path.
 * - **Once per 24 hours** (SHP-REQ-084): a restore of the same app that completed within the
 *   last 24 hours refuses another.
 * - **The code that matches the data**: the release the ledger recorded as running when the
 *   backup was taken is what runs afterwards. When something else runs now (a failed contract
 *   release left in place), its images are swapped back — image-only, and G10 is not evaluated,
 *   since the data is being put back to match that release.
 * - Order: verify → a fresh safety backup (so the restore itself can be undone) → the restore
 *   command, `compose exec -T` in the running container with its output never stored (SHP-D-082)
 *   → pull → swap → check → soak. Every step is journaled before it runs.
 * - Any failure after the restore command ran stops `failed`. There is never an automatic second
 *   restore or a rollback: the data has changed, and only a human decides what happens next.
 */
export interface RestoreRequest {
  /** This restore's own ID (journal, lock, ledger entry). */
  deployId: string;
  app: string;
  /** The deploy whose backup artifact is restored, as the agent's ledger recorded it. */
  backupOf: string;
  requesterLabel: string;
  dryRun?: boolean;
}

/** What a restore will do, resolved from the ledger and the host. */
export interface RestorePlan {
  artifact: BackupArtifactRecord;
  /** The artifact's size on disk now. */
  size: number;
  /** Seconds since the backup was taken: the writes a restore discards. */
  lossWindowSeconds: number;
  /** The release that runs with the restored data. */
  release: LedgerEntry;
  images: VerifiedImage[];
  /** The restore argv with `{artifact}` replaced by the artifact's file name. */
  argv: string[];
  /** True when the release's images are not what runs now, so they are swapped back. */
  swap: boolean;
}

export interface ResolvedRestore {
  live: LiveState;
  gates: GateResult[];
  refusal: Refusal | null;
  plan: RestorePlan | null;
}

/** A file name the restore argv may carry: no separators, no shell, never `.` or `..`. */
const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The restore argv with every `{artifact}` replaced by the artifact's file name, or the refusal
 * when the name is anything but plain `[A-Za-z0-9._-]+`.
 */
export function restoreArgv(argv: readonly string[], artifactPath: string): string[] | Refusal {
  const name = basename(artifactPath);
  if (!ARTIFACT_NAME_RE.test(name) || name === '.' || name === '..') {
    return refusal(
      'restore_limited',
      `The backup file name ${JSON.stringify(name)} cannot be passed to the restore command: only letters, digits, '.', '_' and '-' are allowed.`,
      "Rename nothing by hand; make the app's backup command write plain file names, then take a new backup.",
    );
  }
  return argv.map((arg) => arg.split(RESTORE_ARTIFACT_TOKEN).join(name));
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function errMessage(err: unknown): string {
  if (err instanceof RefusalError) return err.refusal.message;
  return err instanceof Error ? err.message : String(err);
}

function limited(message: string, fix?: string): Refusal {
  return refusal('restore_limited', message, fix);
}

/**
 * The restore's verify: the artifact from the ledger, the 24-hour limit, the manifest's restore
 * step, the artifact still on disk, the release that matches it, then disk and G8 for that
 * release's images. Never touches GitHub. A dry run reads free space and prunes nothing.
 */
export async function resolveRestore(
  ports: SequencePorts,
  ledger: Ledger,
  manifest: Manifest,
  backupOf: string,
  options: { dryRun: boolean },
): Promise<ResolvedRestore> {
  const app = manifest.name;
  let live: LiveState = { sha: ledger.last(app)?.sha ?? null, running: {} };
  const refused = (r: Refusal, gates: GateResult[] = []): ResolvedRestore => ({ live, gates, refusal: r, plan: null });
  const now = ports.clock.now();

  // (a) Only a backup this agent took and recorded (SHP-REQ-085).
  const artifact = ledger.backupArtifacts(app).findLast((a) => a.deployId === backupOf);
  if (artifact === undefined) {
    return refused(limited(`${backupOf} is not a backup this agent took: its ledger records no backup of ${app} by that deploy.`));
  }

  // (b) At most once per app per 24 hours (SHP-REQ-084).
  const recent = ledger.restoreWithinLimit(app, now);
  if (recent !== null) {
    const frees = new Date(Date.parse(recent.at) + 24 * 60 * 60 * 1000);
    return refused(
      limited(
        `${app} was restored at ${recent.at} (restore ${recent.deployId}); another restore is allowed from ${frees.toISOString()}.`,
        'A restore discards every write since its backup; one per app per 24 hours. Fix forward in the meantime.',
      ),
    );
  }

  // (c) The app's own restore command.
  const restoreStep = manifest.steps?.restore;
  const backupStep = manifest.steps?.backup;
  if (restoreStep === undefined || backupStep === undefined) {
    return refused(
      refusal(
        'manifest_invalid',
        `The manifest for ${app} has no steps.restore, so there is no restore command to run.`,
        `Add steps.restore { service, argv } naming ${RESTORE_ARTIFACT_TOKEN} to the manifest on the host.`,
      ),
    );
  }
  const argv = restoreArgv(restoreStep.argv, artifact.backupArtifact);
  if (!Array.isArray(argv)) return refused(argv);

  // The artifact is still in the backup step's directory, and not empty: the container names its
  // own mount of that directory, so a file anywhere else could not be what `{artifact}` reaches.
  const listed = await ports.fs.list(backupStep.artifactsDir, { recursive: true }).catch(() => []);
  const onDisk = listed.find(
    (entry) => basename(entry.path) === basename(artifact.backupArtifact) && resolve(dirname(entry.path)) === resolve(dirname(artifact.backupArtifact)),
  );
  if (onDisk === undefined) {
    return refused(limited(`The backup ${artifact.backupArtifact} is no longer in ${backupStep.artifactsDir} on the host.`, 'Choose another backup this agent took.'));
  }
  if (onDisk.size <= 0) {
    return refused(limited(`The backup ${artifact.backupArtifact} is empty.`, 'Choose another backup this agent took.'));
  }

  // (d) The release whose code matches this data.
  const release = artifact.release === null ? undefined : ledger.entries(app).findLast((e) => e.deployId === artifact.release);
  if (release === undefined) {
    return refused(
      limited(
        `No release in this agent's ledger matches the data in ${artifact.backupArtifact}: what ran when it was taken was not a release Shipyard recorded.`,
        'Restore it by hand on the host, or choose another backup.',
      ),
    );
  }
  const services = Object.entries(manifest.services);
  const mismatch =
    release.images.length !== services.length ||
    services.some(([service, config]) => !release.images.some((image) => image.service === service && image.repo === config.image));
  if (mismatch) {
    return refused(limited(`Release ${release.deployId} (${short(release.sha)}) records services or image repositories that no longer match the host's manifest.`));
  }

  try {
    live = await readLive(ports, ledger, manifest);

    // G8: each recorded digest must still be pullable — fetching its config GETs the manifest by digest.
    const digests: Record<string, Digest | null> = {};
    const labels = new Map<string, Record<string, string>>();
    const unpullable: string[] = [];
    for (const image of release.images) {
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
            new Set([...ledger.retainedDigests(app, manifest.retainImages), ...release.images.map((image) => `${image.repo}@${image.digest}`)]),
          )
        ).freeBytes;

    // G10 is not a restore's gate: the data goes back to match this release, which is the point.
    const facts: GateFacts = { kind: 'rollback', sha: release.sha, manifest, live, digests, laterMigrationLabels: [], freeBytes };
    const gates = evaluateGates(facts)
      .filter((gate) => gate.gate !== 'G10')
      .map((gate): GateResult => {
        if (gate.gate !== 'G8' || gate.pass) return gate;
        const message = `the recorded digest is no longer pullable for ${unpullable.join(', ')}`;
        return { gate: 'G8', pass: false, reason: message, refusal: refusal('image_missing', message) };
      });
    const first = firstRefusal(gates);
    if (first !== null) return refused(first, gates);

    const images: VerifiedImage[] = release.images.map((image) => {
      const imageLabels = labels.get(image.service) ?? {};
      return {
        service: image.service,
        repo: image.repo,
        sha: release.sha,
        digest: image.digest,
        reference: imageReference(image.repo, release.sha, image.digest),
        labels: imageLabels,
        migration: normalizeMigration(imageLabels[LABEL_MIGRATION]),
      };
    });
    const swap = images.some((image) => live.running[image.service] !== image.digest);
    const lossWindowSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(artifact.at)) / 1000));
    return { live, gates, refusal: null, plan: { artifact, size: onDisk.size, lossWindowSeconds, release, images, argv, swap } };
  } catch (err) {
    if (err instanceof RefusalError) return refused(err.refusal);
    throw err;
  }
}

/** One line for a dry run and the logs: what the restore will do. */
export function describeRestore(app: string, plan: RestorePlan): string {
  const release = `${short(plan.release.sha)} (${plan.release.deployId})`;
  return [
    `Would restore ${app} from ${plan.artifact.backupArtifact} (${String(plan.size)} bytes), taken ${plan.artifact.at} by deploy ${plan.artifact.deployId}.`,
    `Writes made in the last ${lossWindowText(plan.lossWindowSeconds)} would be lost.`,
    plan.swap ? `The images of release ${release} would be put back, to match the restored data.` : `Release ${release} is already running and stays.`,
    'A safety backup is taken first.',
  ].join(' ');
}

/**
 * Restores `request.app` from the backup that deploy `request.backupOf` took. Only the app, that
 * deploy ID (and this restore's ID, requester label and dry-run flag) are read from the request.
 */
export async function runRestore(ports: SequencePorts, ctx: MachineContext, request: RestoreRequest): Promise<DeployResult> {
  const dryRun = request.dryRun === true;
  const log = ports.log.child({ deployId: request.deployId, app: request.app, restoreOf: request.backupOf });
  const loaded = ctx.manifests.get(request.app);
  // For the lock holder and the result only; everything is re-read from the ledger under the lock.
  const backup = ctx.ledger.backupArtifacts(request.app).findLast((a) => a.deployId === request.backupOf);
  const named = backup === undefined || backup.release === null ? undefined : ctx.ledger.entries(request.app).findLast((e) => e.deployId === backup.release);
  // The Run's kind is only read by the forward execution path, which a restore never joins.
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
    // Resolve and gates only: nothing is locked, journaled or written.
    const record = await run.begin('verify', { detail: { backupOf: request.backupOf } });
    const resolved = await resolveRestore(ports, ctx.ledger, manifest, request.backupOf, { dryRun: true });
    if (resolved.refusal !== null || resolved.plan === null) {
      await run.end(record);
      await run.move('refused');
      return result(run, { ...empty, gates: resolved.gates, refusal: resolved.refusal ?? refusal('restore_limited', 'Nothing to restore.') });
    }
    await run.end(record, { output: describeRestore(request.app, resolved.plan) });
    return result(run, { ...empty, state: 'verifying', gates: resolved.gates, images: resolved.plan.images });
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
        kind: 'restore',
        backupOf: request.backupOf,
        // Restart recovery never swaps images back under an interrupted restore: the data may
        // already be restored, and only a human decides what happens next (SHP-D-008).
        contract: true,
      },
    });
    let outcome: Outcome;
    try {
      outcome = await restoreLocked(ports, ctx, run, manifest, target, request.backupOf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, state: run.state }, 'restore crashed');
      if (canTransition(run.state, 'failed')) await run.move('failed');
      else if (canTransition(run.state, 'refused')) await run.move('refused');
      outcome = {
        ...empty,
        state: run.state,
        refusal: refusal('step_failed', `Restore stopped at ${run.state}: ${message}`, 'Check the app on the host; nothing was rolled back automatically.'),
      };
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

async function restoreLocked(
  ports: SequencePorts,
  ctx: MachineContext,
  run: Run,
  manifest: Manifest,
  target: ComposeTarget,
  backupOf: string,
): Promise<Outcome> {
  const verifyRecord = await run.begin('verify', { detail: { backupOf } });
  const resolved = await resolveRestore(ports, ctx.ledger, manifest, backupOf, { dryRun: false });
  const plan = resolved.plan;
  await run.end(verifyRecord, {
    detail: {
      gates: resolved.gates.map((g) => ({ gate: g.gate, pass: g.pass })),
      ...(resolved.refusal === null && plan !== null
        ? {
            contract: true,
            artifact: plan.artifact.backupArtifact,
            release: plan.release.deployId,
            lossWindowSeconds: plan.lossWindowSeconds,
            images: plan.images.map((image) => ({ service: image.service, repo: image.repo, digest: image.digest, migration: image.migration })),
          }
        : { refused: resolved.refusal?.code ?? 'restore_limited' }),
    },
  });
  if (resolved.refusal !== null || plan === null) {
    await run.move('refused');
    return {
      state: 'refused',
      images: [],
      gates: resolved.gates,
      refusal: resolved.refusal ?? refusal('restore_limited', 'Nothing to restore.'),
      schemaRevision: null,
      backupArtifact: null,
    };
  }
  run.log.info({ artifact: plan.artifact.backupArtifact, release: plan.release.deployId, swap: plan.swap }, describeRestore(manifest.name, plan));

  const { images, release } = plan;
  const services = images.map((image) => image.service);
  const deployId = run.request.deployId;
  const base = { images, gates: resolved.gates, schemaRevision: null as string | null };
  let safetyBackup: string | null = null;
  let restored = false;
  const fail = async (why: Refusal): Promise<Outcome> => {
    run.log.error({ code: why.code, state: run.state, restored }, why.message);
    await run.move('failed');
    const message = restored
      ? `${why.message} The restore command had already run, so ${manifest.name}'s data is from ${plan.artifact.backupArtifact}; nothing was rolled back${safetyBackup === null ? '' : `, and the safety backup ${safetyBackup} holds the data as it was just before`}.`
      : `${why.message} Nothing was restored.`;
    return {
      ...base,
      state: 'failed',
      backupArtifact: safetyBackup,
      refusal: {
        ...why,
        message,
        fix: restored ? 'Check the app on the host and fix forward; Shipyard never restores or rolls back a second time on its own.' : why.fix,
      },
    };
  };

  // ─── safety backup ─────────────────────────────────────────────────────────
  const backupStep = manifest.steps?.backup;
  if (backupStep === undefined) return fail(refusal('manifest_invalid', `The manifest for ${manifest.name} has no steps.backup.`));
  await run.move('backing_up', 'backup');
  {
    const record = await run.begin('backup', { argv: backupStep.argv, detail: { safetyFor: deployId } });
    try {
      const taken = await runBackup(ports, target, backupStep);
      safetyBackup = taken.artifact.path;
      await ctx.ledger.recordBackup({
        app: manifest.name,
        deployId,
        backupArtifact: taken.artifact.path,
        release: ctx.ledger.releaseRunning(manifest.name, resolved.live.running),
        at: ports.clock.now().toISOString(),
      });
      await run.end(record, { exitCode: taken.exitCode, detail: { artifact: taken.artifact.path, size: taken.artifact.size } });
    } catch (err) {
      const why = err instanceof RefusalError ? err.refusal : refusal('backup_failed', `Safety backup failed: ${errMessage(err)}`);
      await run.end(record, { detail: { refused: why.code } });
      return fail(why);
    }
  }

  // ─── restore ───────────────────────────────────────────────────────────────
  const restoreStep = manifest.steps?.restore;
  if (restoreStep === undefined) return fail(refusal('manifest_invalid', `The manifest for ${manifest.name} has no steps.restore.`));
  await run.move('migrating', 'restore');
  {
    const args = ['exec', '-T', restoreStep.service, ...plan.argv];
    const record = await run.begin('restore', { argv: plan.argv, detail: { artifact: plan.artifact.backupArtifact, backupOf: plan.artifact.deployId } });
    // The output is never stored or returned, not even on failure (SHP-D-082).
    const executed = await ports.docker.compose(target, args);
    restored = true;
    await run.end(record, { exitCode: executed.exitCode });
    if (executed.exitCode !== 0) {
      return fail(refusal('step_failed', `The restore command in service "${restoreStep.service}" exited ${String(executed.exitCode)}; its output is not kept.`));
    }
  }

  const secrets = await loadSecrets(ports.fs, manifest.envFiles).catch(() => new Map<string, string>());

  // ─── pull ──────────────────────────────────────────────────────────────────
  await run.move('pulling', 'pull');
  {
    const args = ['pull', ...services];
    const record = await run.begin('pull', { argv: args });
    try {
      await ports.fs.mkdirp(ctx.workDir);
      const overridePath = `${ctx.workDir}/${deployId}.pull-override.yaml`;
      const override: Record<string, { image: string }> = {};
      for (const image of images) override[image.service] = { image: image.reference };
      await ports.fs.writeFileAtomic(overridePath, stringifyYaml({ services: override }));
      let pulled;
      try {
        pulled = await ports.docker.compose({ files: [...target.files, overridePath], project: target.project }, args);
      } finally {
        await unlink(overridePath).catch(() => undefined);
      }
      const output = redact(`${pulled.stdout}\n${pulled.stderr}`, secrets);
      await run.end(record, { exitCode: pulled.exitCode, output });
      if (pulled.exitCode !== 0) return await fail(refusal('step_failed', `compose pull exited ${String(pulled.exitCode)}.\n${output}`));
    } catch (err) {
      const why = err instanceof RefusalError ? err.refusal : refusal('step_failed', `Pull failed: ${errMessage(err)}`);
      await run.end(record, { detail: { refused: why.code } });
      return fail(why);
    }
  }

  // ─── swap ──────────────────────────────────────────────────────────────────
  await run.move('swapping', 'swap');
  const swapRecord = await run.begin('swap', { detail: { historyDeployId: deployId, release: release.deployId, changed: plan.swap } });
  try {
    const files = await Promise.all(target.files.map(async (path) => ({ path, text: await ports.fs.readFile(path) })));
    const rewrite = planRewrite(
      files,
      images.map((image) => ({ service: image.service, repo: image.repo, reference: image.reference })),
    );
    await applyRewrite(ports.fs, rewrite, { dir: ctx.historyDir, deployId });
  } catch (err) {
    const why = err instanceof RefusalError ? err.refusal : refusal('step_failed', `Compose rewrite failed: ${errMessage(err)}`);
    await run.end(swapRecord, { detail: { refused: why.code } });
    return fail(why);
  }
  const upArgs = ['up', '-d', '--no-deps', ...services];
  const up = await ports.docker.compose(target, upArgs);
  const upOutput = redact(`${up.stdout}\n${up.stderr}`, secrets);
  await run.end(swapRecord, { argv: upArgs, exitCode: up.exitCode, output: upOutput });
  if (up.exitCode !== 0) return fail(refusal('step_failed', `compose up exited ${String(up.exitCode)}.\n${upOutput}`));

  // ─── check ─────────────────────────────────────────────────────────────────
  await run.move('checking', 'check');
  const checkRecord = await run.begin('check');
  const checked = await pollCheck(ports, ctx, manifest, target, images);
  await run.end(checkRecord, { detail: checked.ok ? { schema: checked.schema } : { refused: checked.refusal.code } });
  if (!checked.ok) return fail(checked.refusal);

  // ─── soak ──────────────────────────────────────────────────────────────────
  await run.move('soaking', 'soak');
  const soakRecord = await run.begin('soak', { detail: { seconds: manifest.soakSeconds } });
  const soaked = await soak(ports, ctx, manifest, target, images);
  await run.end(soakRecord, { detail: soaked.ok ? { schema: soaked.schema } : { refused: soaked.refusal.code } });
  if (!soaked.ok) return fail(soaked.refusal);

  // ─── success ───────────────────────────────────────────────────────────────
  const at = ports.clock.now().toISOString();
  const recordedImages = images.map((image) => ({ service: image.service, repo: image.repo, digest: image.digest, migration: image.migration }));
  // A different release is live again: record it as a release, so `last` says what runs.
  if (ctx.ledger.last(manifest.name)?.deployId !== release.deployId) {
    await ctx.ledger.append({ app: manifest.name, deployId, kind: 'rollback', sha: release.sha, images: recordedImages, backupArtifact: null, at });
  }
  await ctx.ledger.append({
    kind: 'restore',
    app: manifest.name,
    deployId,
    backupOf: plan.artifact.deployId,
    restoredFrom: plan.artifact.backupArtifact,
    release: release.deployId,
    sha: release.sha,
    images: recordedImages,
    backupArtifact: safetyBackup,
    at,
  });
  await run.move('succeeded');
  return { ...base, state: 'succeeded', schemaRevision: soaked.schema, refusal: null, backupArtifact: safetyBackup };
}
