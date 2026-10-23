import { randomUUID } from 'node:crypto';
import {
  ACTIVE_STATES,
  HostInventory,
  MaintenanceJob,
  MaintenanceResult,
  MaintenanceStep,
  Refusal as RefusalSchema,
  VolumeArchive,
  VolumeName,
  parseManifestYaml,
  refusal,
  type HostVolume,
  type MaintenancePage,
  type MaintenanceProgress,
  type MaintenanceState,
  type MaintenanceStatus,
  type PruneRequest,
  type Refusal,
  type Requester,
  type VolumeBackupSettings,
  type VolumeOwner,
  type VolumeRestoreRequest,
  type VolumeDeleteRequest,
} from '@shipyard/schema';
import { REQUESTER_LABEL_MAX, actionRequesterLabel, tokenScopeCovers } from '../actions/service.js';
import { agentsWithCapability, capabilityRefusal } from '../agent/capabilities.js';
import type { Actor } from '../audit.js';
import { STATE_CHANGING_ROLES } from '../auth/scope.js';
import { directAudit, type AuditWriter } from '../builds/service.js';
import { Prisma, type Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { isUniqueViolation, lockRefusal, type DeployCaller } from '../deploys/service.js';
import { decodeCursor, encodeCursor } from '../deploys/timeline.js';
import { parseStackManifest, stackLockRefusal } from '../stack-updates/service.js';
import { ownerLockKey, restoreLockRefusal } from './lock.js';

/**
 * Volume backups, restores and deletes, and prunes, server side (SHP-T-17.3; SHP-ADR-012,
 * SHP-REQ-201, SHP-REQ-202, SHP-REQ-203, SHP-REQ-204, SHP-REQ-205).
 *
 * The server never touches Docker. It checks who is asking and what they name against the latest
 * host snapshot, records a `maintenance_job` — `queued` — and hands it to the owning agent's long
 * poll once that agent advertises `maintenance`, one job at a time per agent (the
 * `maintenance_job_one_in_flight_per_agent` index). What reaches the host is a volume name, the
 * app or stack its own manifests define, an archive ID the agent resolves in its own ledger, or a
 * dry run's ID — never a command or a path (non-negotiables 1 and 7, SHP-D-080). The agent
 * re-checks everything before it acts: a delete only removes a volume nothing mounts now, a restore
 * only an archive in its own ledger, a real prune only what its dry run listed and is still
 * eligible.
 *
 * - **Backup** (SHP-REQ-201): deployer and up, or a token scoped to the owning app or stack. Only a
 *   volume a Deployed app or adopted stack owns (`volume_not_owned`).
 * - **Restore** (SHP-REQ-202, SHP-REQ-204): admin, in the console only — an API token is refused
 *   `forbidden` — with a step-up from the last ten minutes (checked by the router for console and
 *   native sessions alike), the volume's name typed back (`confirmation_mismatch`), an unretired
 *   archive of that volume in the owning agent's ledger (`archive_not_found`), and an owner nothing
 *   else is deploying, updating or acting on (`locked`). The restore then holds the owner
 *   (`maintenance/lock.ts`).
 * - **Delete** (SHP-REQ-203): the same people and checks, for an orphan only (`volume_in_use`).
 * - **Prune** (SHP-REQ-205): deployer and up, any token. A dry run lists; a real prune names a
 *   succeeded dry run of the same agent from the last hour (`dry_run_required`) and carries its
 *   criteria.
 *
 * Every request, dispatch, progress step, result and expiry is audited; the router audits refused
 * restore and delete attempts too.
 */

/** A dispatched or running job with no word from the agent for this long is failed. */
export const MAINTENANCE_STALE_MS = 15 * 60_000;
/** The longest `waitForMaintenance`. */
export const MAX_MAINTENANCE_WAIT_MS = 90_000;
/** How long a succeeded dry run may be pruned from (SHP-REQ-205). */
export const DRY_RUN_FRESH_MS = 60 * 60_000;
/** A filesystem this full is shown on Needs you. */
export const LOW_DISK_PERCENT = 90;
/** Who the nightly scheduler's backups are requested by. */
export const NIGHTLY_REQUESTER_LABEL = 'shipyard: nightly backup';

/** The states one agent has at most one job in (`maintenance_job_one_in_flight_per_agent`). */
export const IN_FLIGHT_MAINTENANCE_STATES = ['dispatched', 'running'] as const satisfies readonly MaintenanceState[];
export const ACTIVE_MAINTENANCE_STATES = ['queued', 'dispatched', 'running'] as const satisfies readonly MaintenanceState[];
export const TERMINAL_MAINTENANCE_STATES: readonly MaintenanceState[] = ['succeeded', 'failed', 'refused', 'cancelled'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prune criteria a dry run uses when the request leaves them out (the console's defaults). */
export const DEFAULT_PRUNE_IMAGES = { dangling: true, unusedOlderThanHours: 168 } as const;
export const DEFAULT_PRUNE_BUILD_CACHE = { olderThanHours: 168 } as const;

export type MaintenanceKind = MaintenanceStatus['kind'];
type RequesterKind = MaintenanceStatus['requester']['kind'];

export const MAINTENANCE_SELECT = {
  id: true,
  agentId: true,
  kind: true,
  state: true,
  step: true,
  volume: true,
  ownerKind: true,
  ownerName: true,
  job: true,
  dryRunOf: true,
  requesterKind: true,
  requesterLabel: true,
  result: true,
  refusal: true,
  createdAt: true,
  dispatchedAt: true,
  startedAt: true,
  finishedAt: true,
  updatedAt: true,
} satisfies Prisma.MaintenanceJobSelect;

export type MaintenanceRow = Prisma.MaintenanceJobGetPayload<{ select: typeof MAINTENANCE_SELECT }>;

const STORED_RESULT = MaintenanceResult.omit({ jobId: true, state: true, refusal: true }).partial();

function ownerOfRow(row: { ownerKind: string | null; ownerName: string | null }): VolumeOwner | null {
  if (row.ownerName === null || (row.ownerKind !== 'app' && row.ownerKind !== 'stack')) return null;
  return { kind: row.ownerKind, name: row.ownerName };
}

function kindOf(kind: string): MaintenanceKind {
  return kind === 'volume-backup' || kind === 'volume-restore' || kind === 'volume-delete' ? kind : 'prune';
}

function requesterKindOf(kind: string): RequesterKind {
  return kind === 'user' || kind === 'token' ? kind : 'system';
}

/** The REST/MCP view of a maintenance job row. */
export function toMaintenanceStatus(row: MaintenanceRow): MaintenanceStatus {
  const stored = RefusalSchema.safeParse(row.refusal);
  const step = MaintenanceStep.safeParse(row.step);
  const parsed = STORED_RESULT.safeParse(row.result ?? {});
  const result = parsed.success ? parsed.data : {};
  return {
    id: row.id,
    kind: kindOf(row.kind),
    state: row.state,
    step: step.success ? step.data : null,
    volume: row.volume,
    owner: ownerOfRow(row),
    requester: { kind: requesterKindOf(row.requesterKind), label: row.requesterLabel.slice(0, REQUESTER_LABEL_MAX) },
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    archive: result.archive ?? null,
    removedArchives: result.removedArchives ?? [],
    prune: result.prune ?? null,
    refusal: stored.success ? stored.data : null,
    output: result.output ?? null,
  };
}

export function isMaintenanceTerminal(state: MaintenanceState): boolean {
  return TERMINAL_MAINTENANCE_STATES.includes(state);
}

/**
 * Whether `caller` may read this job: every signed-in user; a token only a job whose owner its
 * scope names, and every prune (a prune names no app, and any token may request one). A volume
 * delete has no owner, so no token reads it.
 */
export function maintenanceInScope(caller: Pick<DeployCaller, 'actor' | 'tokenApps' | 'tokenStacks'>, status: Pick<MaintenanceStatus, 'kind' | 'owner'>): boolean {
  if (caller.actor?.type !== 'token') return true;
  if (status.kind === 'prune') return true;
  return status.owner !== null && tokenScopeCovers(caller, status.owner);
}

// ─── Who may ask ─────────────────────────────────────────────────────────────

/** Deployer and up, a user or a token: a backup or a prune. */
function changeRefusal(caller: Pick<DeployCaller, 'actor' | 'role'>, what: string): Refusal | null {
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (actor.type !== 'user' && actor.type !== 'token') return refusal('forbidden', `A ${actor.type} actor cannot ${what}.`);
  if (caller.role === undefined || !STATE_CHANGING_ROLES.includes(caller.role)) {
    return refusal('forbidden', `The viewer role cannot ${what}.`, 'Ask an admin for the deployer role.');
  }
  return null;
}

/**
 * Restoring or deleting a volume is an admin's act in the console (SHP-REQ-202, SHP-REQ-203): an API
 * token is refused outright, whatever its owner's role (SHP-REQ-204), as is anyone but an admin.
 * The step-up is checked by the router, which can see the session.
 */
export function destructiveRefusal(caller: Pick<DeployCaller, 'actor' | 'role'>, what: 'restore' | 'delete'): Refusal | null {
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (actor.type === 'token') {
    return refusal('forbidden', `Volume ${what}s are console-only: an API token cannot ${what} a volume.`, `Sign in to the console as an admin and ${what} it there.`);
  }
  if (actor.type !== 'user') return refusal('forbidden', `A ${actor.type} actor cannot ${what} a volume.`);
  if (caller.role !== 'admin') {
    return refusal('forbidden', `Only an admin can ${what} a volume.`, `Ask an admin to ${what} it.`);
  }
  return null;
}

function volumeNameRefusal(volume: string): Refusal | null {
  return VolumeName.safeParse(volume).success ? null : refusal('invalid_request', 'That is not a Docker volume name.', 'Use a volume name from the host inventory.');
}

// ─── What the host reports ───────────────────────────────────────────────────

/** One volume in an agent's latest host snapshot, with the app or stack that owns it, if any. */
export interface IndexedVolume {
  agentId: string;
  volume: HostVolume;
  owner: VolumeOwner | null;
}

interface OwnerSettings {
  owner: VolumeOwner;
  agentId: string;
  backups: VolumeBackupSettings | undefined;
}

function appManifestOf(manifestYaml: string): { project: string | null; backups: VolumeBackupSettings | undefined } {
  try {
    const m = parseManifestYaml(manifestYaml);
    return { project: m.compose.project, backups: m.volumeBackups };
  } catch {
    // A row seeded or mirrored before the manifest validated: it owns nothing it cannot name.
    return { project: null, backups: undefined };
  }
}

/** Every unretired app and stack with its compose project and volume backup settings. */
async function ownersByAgent(db: Db): Promise<{ owners: (OwnerSettings & { project: string | null })[] }> {
  const apps = await db.app.findMany({ where: { retiredAt: null }, select: { name: true, agentId: true, manifestYaml: true }, orderBy: { name: 'asc' } });
  const stacks = await db.stack.findMany({ where: { retiredAt: null }, select: { name: true, agentId: true, composeProject: true, manifestJson: true }, orderBy: { name: 'asc' } });
  const owners: (OwnerSettings & { project: string | null })[] = [];
  for (const a of apps) {
    const m = appManifestOf(a.manifestYaml);
    owners.push({ owner: { kind: 'app', name: a.name }, agentId: a.agentId, project: m.project, backups: m.backups });
  }
  for (const s of stacks) {
    owners.push({ owner: { kind: 'stack', name: s.name }, agentId: s.agentId, project: s.composeProject, backups: parseStackManifest(s.manifestJson)?.volumeBackups });
  }
  return { owners };
}

/**
 * Every volume in every agent's latest host snapshot, with its owner (SHP-ADR-012): a volume is owned
 * when a container that mounts it belongs to the compose project of one of that agent's Deployed
 * apps or adopted stacks (or the agent tiered it to one); otherwise it is an orphan (nothing mounts
 * it) or Observed. A snapshot that no longer validates is skipped.
 */
export async function volumeIndex(db: Db): Promise<IndexedVolume[]> {
  const snapshots = await db.hostSnapshot.findMany({ select: { agentId: true, inventory: true }, orderBy: { reportedAt: 'desc' } });
  if (snapshots.length === 0) return [];
  const { owners } = await ownersByAgent(db);
  const out: IndexedVolume[] = [];
  for (const snap of snapshots) {
    const parsed = HostInventory.safeParse(snap.inventory);
    if (!parsed.success) continue;
    const mine = owners.filter((o) => o.agentId === snap.agentId);
    const containers = new Map(parsed.data.containers.map((c) => [c.name, c]));
    for (const volume of parsed.data.volumes) {
      let owner: VolumeOwner | null = null;
      for (const name of [...volume.mountedBy].sort()) {
        const c = containers.get(name);
        if (c === undefined) continue;
        const project = c.compose?.project ?? null;
        const byProject = project === null ? undefined : mine.find((o) => o.project === project);
        const byTier =
          c.app === null
            ? undefined
            : mine.find((o) => o.owner.name === c.app && ((c.tier === 'shipped' && o.owner.kind === 'app') || (c.tier === 'operated' && o.owner.kind === 'stack')));
        const found = byProject ?? byTier;
        if (found !== undefined) {
          owner = found.owner;
          break;
        }
      }
      out.push({ agentId: snap.agentId, volume, owner });
    }
  }
  return out;
}

/** The volume a host reports under `name`, or why there is none (or more than one). */
export async function resolveVolume(db: Db, name: string): Promise<IndexedVolume | Refusal> {
  const matches = (await volumeIndex(db)).filter((v) => v.volume.name === name);
  const only = matches[0];
  if (only === undefined) {
    return refusal('not_found', `No host reports a volume named ${name}.`, 'Read the host inventory and use one of its volume names.');
  }
  if (matches.length > 1) {
    return refusal('conflict', `More than one host reports a volume named ${name}.`, 'Rename one of the volumes so the name is unambiguous.');
  }
  return only;
}

function notOwned(v: IndexedVolume): Refusal {
  const what = v.volume.orphan ? 'an orphan nothing mounts' : 'mounted only by Observed containers';
  return refusal('volume_not_owned', `${v.volume.name} belongs to no Deployed app or adopted stack: it is ${what}.`);
}

/**
 * Under the owner lock, inside the restore's insert transaction: `locked` when a deploy of the app
 * took its lock, or another restore of the owner was recorded, since `ownerBusyRefusal` looked.
 */
async function restoreRaceRefusal(tx: Prisma.TransactionClient, owner: VolumeOwner): Promise<Refusal | null> {
  if (owner.kind === 'app') {
    const holder = await tx.deployTarget.findFirst({
      where: { app: { name: owner.name }, state: { in: [...ACTIVE_STATES] } },
      select: { deployId: true, deploy: { select: { requesterLabel: true } } },
    });
    if (holder !== null) {
      return refusal('locked', `${owner.name} is being deployed by ${holder.deploy.requesterLabel}.`, `Wait for deploy ${holder.deployId} to finish, then request again.`);
    }
  }
  return restoreLockRefusal(tx, owner);
}

/** `locked` while the owner is being deployed, updated, acted on or restored (SHP-REQ-202). */
export async function ownerBusyRefusal(db: Db, owner: VolumeOwner): Promise<Refusal | null> {
  if (owner.kind === 'app') {
    const app = await db.app.findFirst({ where: { name: owner.name, retiredAt: null }, select: { id: true } });
    if (app === null) return refusal('volume_not_owned', `${owner.name} is no longer a Deployed app.`);
    const locked = await lockRefusal(db, owner.name, app.id);
    if (locked !== null) return locked;
    const action = await db.action.findFirst({
      where: { targetKind: 'app', targetName: owner.name, state: { in: ['queued', 'dispatched', 'running'] } },
      select: { id: true, verb: true, requesterLabel: true },
    });
    if (action !== null) {
      return refusal('locked', `${owner.name} has a ${action.verb} by ${action.requesterLabel} in progress.`, `Wait for action ${action.id} to finish, then request again.`);
    }
    return null;
  }
  const stack = await db.stack.findFirst({ where: { name: owner.name, retiredAt: null }, select: { id: true, name: true } });
  if (stack === null) return refusal('volume_not_owned', `${owner.name} is no longer an adopted stack.`);
  return stackLockRefusal(db, stack);
}

// ─── Queueing ─────────────────────────────────────────────────────────────────

interface RequesterInfo {
  kind: RequesterKind;
  label: string;
  userId?: string;
  tokenId?: string;
  repo?: string;
  branch?: string;
}

function requesterOf(actor: Actor, requester?: Requester): RequesterInfo {
  const kind: RequesterKind = actor.type === 'user' || actor.type === 'token' ? actor.type : 'system';
  return {
    kind,
    label: actionRequesterLabel(actor, requester?.label),
    ...(actor.type === 'user' && actor.id !== undefined ? { userId: actor.id } : {}),
    ...(actor.type === 'token' && actor.id !== undefined ? { tokenId: actor.id } : {}),
    ...(requester === undefined ? {} : { repo: requester.repo, branch: requester.branch }),
  };
}

type JobBody = MaintenanceJob extends infer J ? (J extends { jobId: string } ? Omit<J, 'jobId'> : never) : never;

interface QueueInput {
  agentId: string;
  volume: string | null;
  owner: VolumeOwner | null;
  dryRunOf?: string;
  body: JobBody;
  requester: RequesterInfo;
  audit: AuditWriter;
  /**
   * Advisory locks taken, in one transaction, before `guard` runs and the row is inserted: what
   * makes a check-then-insert safe against another request or server process doing the same.
   */
  lockKeys?: readonly string[];
  /** Checked under `lockKeys`, inside the insert's transaction; a refusal inserts nothing. */
  guard?: (tx: Prisma.TransactionClient) => Promise<Refusal | null>;
  /** The refusal when a partial unique index refuses the insert. */
  onUnique?: Refusal;
  /** The row's created_at; the database's clock when absent (the nightly scheduler passes its own). */
  createdAt?: Date;
}

/** Records a checked job `queued`, audits `maintenance.request`, and wakes the agent's poll. */
async function queueJob(deps: ServiceDeps, input: QueueInput): Promise<MaintenanceStatus | Refusal> {
  const { db, bus, logger } = deps;
  const id = randomUUID();
  // Validated before it is stored: what the agent is handed is checked like everything it sends.
  const job = MaintenanceJob.parse({ jobId: id, ...input.body });
  const insert = (client: Prisma.TransactionClient) => client.maintenanceJob.create({
    data: {
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      id,
      agentId: input.agentId,
      kind: job.kind,
      volume: input.volume,
      ownerKind: input.owner?.kind ?? null,
      ownerName: input.owner?.name ?? null,
      job,
      ...(input.dryRunOf === undefined ? {} : { dryRunOf: input.dryRunOf }),
      requesterKind: input.requester.kind,
      requesterLabel: input.requester.label.slice(0, REQUESTER_LABEL_MAX),
      requesterRepo: input.requester.repo ?? null,
      requesterBranch: input.requester.branch ?? null,
      ...(input.requester.userId === undefined ? {} : { requesterUserId: input.requester.userId }),
      ...(input.requester.tokenId === undefined ? {} : { requesterTokenId: input.requester.tokenId }),
    },
    select: MAINTENANCE_SELECT,
  });
  let row: MaintenanceRow;
  try {
    if (input.lockKeys === undefined && input.guard === undefined) {
      row = await insert(db);
    } else {
      const out = await db.$transaction(async (tx) => {
        for (const key of [...(input.lockKeys ?? [])].sort()) {
          await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${key}))`;
        }
        const why = input.guard === undefined ? null : await input.guard(tx);
        return why ?? (await insert(tx));
      });
      if ('code' in out) return out;
      row = out;
    }
  } catch (err) {
    if (input.onUnique !== undefined && isUniqueViolation(err)) return input.onUnique;
    throw err;
  }
  const kind = job.kind;
  const detail: Record<string, unknown> = { ...job };
  delete detail['jobId'];
  delete detail['kind'];
  await input.audit({
    action: 'maintenance.request',
    entityType: 'maintenance_job',
    entityId: row.id,
    after: {
      kind,
      ...detail,
      ...(input.owner === null ? {} : { owner: input.owner }),
      requester: { kind: input.requester.kind, label: row.requesterLabel, repo: input.requester.repo ?? null, branch: input.requester.branch ?? null },
      state: row.state,
    },
  });
  logger.info({ maintenanceId: row.id, kind, volume: input.volume, owner: input.owner }, 'maintenance job queued');
  bus.publish('work');
  bus.publish(`maintenance:${row.id}`);
  return toMaintenanceStatus(row);
}

export interface RequestOptions {
  /** Who an MCP session says it is; shown in front of the token's label. */
  requester?: Requester;
}

/**
 * Backs up `volume` (SHP-REQ-201): deployer and up, or a token whose scope names the owning app or
 * stack, for an owned volume. Quiesced when the owner's manifest says so. The MCP tool calls this.
 */
export async function requestVolumeBackup(deps: ServiceDeps, caller: DeployCaller, volume: string, options: RequestOptions = {}): Promise<MaintenanceStatus | Refusal> {
  const denied = changeRefusal(caller, 'back up a volume') ?? volumeNameRefusal(volume);
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  const found = await resolveVolume(deps.db, volume);
  if ('code' in found) return found;
  const owner = found.owner;
  if (owner === null) return notOwned(found);
  if (actor.type === 'token' && !tokenScopeCovers(caller, owner)) {
    return refusal('forbidden', `This token is not scoped to ${owner.name}, which owns ${volume}.`, `Use a token issued for ${owner.name}.`);
  }
  const cannot = capabilityRefusal(deps.bus, found.agentId, 'maintenance');
  if (cannot !== null) return cannot;
  const settings = (await ownersByAgent(deps.db)).owners.find((o) => o.owner.kind === owner.kind && o.owner.name === owner.name)?.backups;
  return queueJob(deps, {
    agentId: found.agentId,
    volume,
    owner,
    body: { kind: 'volume-backup', volume, owner, quiesce: settings?.quiesce ?? false },
    requester: requesterOf(actor, options.requester),
    audit: caller.audit,
  });
}

/**
 * Restores `volume` from an archive in the owning agent's ledger (SHP-REQ-202). Admin only and
 * never a token (SHP-REQ-204); the caller's step-up is the router's to check. The agent stops the
 * owner, restores, and starts it again.
 */
export async function requestVolumeRestore(deps: ServiceDeps, caller: DeployCaller, volume: string, input: VolumeRestoreRequest): Promise<MaintenanceStatus | Refusal> {
  const { db } = deps;
  const denied = destructiveRefusal(caller, 'restore') ?? volumeNameRefusal(volume);
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (input.confirmVolume !== volume) {
    return refusal('confirmation_mismatch', `The name typed does not match ${volume}.`, `Type ${volume} exactly to confirm the restore.`);
  }
  const noArchive = refusal('archive_not_found', `Archive ${input.archiveId} is not a current archive of ${volume} in the agent's ledger.`, `Choose one from GET /api/volumes/${volume}/archives.`);
  const archive = await db.volumeArchive.findUnique({ where: { archiveId: input.archiveId }, select: { agentId: true, volume: true, retiredAt: true } });
  if (archive?.volume !== volume || archive.retiredAt !== null) return noArchive;
  const found = await resolveVolume(db, volume);
  if ('code' in found) return found;
  const owner = found.owner;
  if (owner === null) return notOwned(found);
  if (archive.agentId !== found.agentId) return noArchive;
  const busy = await ownerBusyRefusal(db, owner);
  if (busy !== null) return busy;
  const cannot = capabilityRefusal(deps.bus, found.agentId, 'maintenance');
  if (cannot !== null) return cannot;
  return queueJob(deps, {
    agentId: found.agentId,
    volume,
    owner,
    body: { kind: 'volume-restore', volume, owner, archiveId: input.archiveId },
    requester: requesterOf(actor),
    audit: caller.audit,
    // The deploy paths insert under the same lock (`assertNoRestore`): checked again under it, a
    // deploy and a restore that raced cannot both be recorded (SHP-REQ-202).
    lockKeys: [ownerLockKey(owner)],
    guard: (tx) => restoreRaceRefusal(tx, owner),
  });
}

/** Deletes an orphan `volume` (SHP-REQ-203): admin, console only; the agent re-checks nothing mounts it. */
export async function requestVolumeDelete(deps: ServiceDeps, caller: DeployCaller, volume: string, input: VolumeDeleteRequest): Promise<MaintenanceStatus | Refusal> {
  const denied = destructiveRefusal(caller, 'delete') ?? volumeNameRefusal(volume);
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (input.confirmVolume !== volume) {
    return refusal('confirmation_mismatch', `The name typed does not match ${volume}.`, `Type ${volume} exactly to confirm the delete.`);
  }
  const found = await resolveVolume(deps.db, volume);
  if ('code' in found) return found;
  if (!found.volume.orphan) {
    const by = found.volume.mountedBy.length === 0 ? 'a container' : found.volume.mountedBy.join(', ');
    return refusal('volume_in_use', `${volume} is mounted by ${by}; only a volume nothing mounts can be deleted.`);
  }
  // A Shipped or Operated volume is never offered for deletion, even unmounted after a compose
  // down (SHP-REQ-203, SHP-ADR-012): compose's project label still names its app or stack.
  const project = found.volume.composeProject;
  const owner =
    project === null ? undefined : (await ownersByAgent(deps.db)).owners.find((o) => o.agentId === found.agentId && o.project === project);
  if (owner !== undefined) {
    const what = owner.owner.kind === 'app' ? 'Deployed app' : 'adopted stack';
    return refusal(
      'volume_not_owned',
      `${volume} belongs to the ${what} ${owner.owner.name} (compose project ${project ?? ''}), though nothing mounts it now; Shipyard never deletes it.`,
      `Remove the volume from ${owner.owner.name}'s compose file first, or retire ${owner.owner.name}; then delete it.`,
    );
  }
  const cannot = capabilityRefusal(deps.bus, found.agentId, 'maintenance');
  if (cannot !== null) return cannot;
  return queueJob(deps, {
    agentId: found.agentId,
    volume,
    owner: null,
    body: { kind: 'volume-delete', volume },
    requester: requesterOf(actor),
    audit: caller.audit,
  });
}

/**
 * The agent a prune runs on: a prune names no app, so it is the one agent polling with
 * `maintenance`. With none, the refusal says why; with more than one, the request cannot say which.
 */
async function pruneAgent(deps: ServiceDeps): Promise<string | Refusal> {
  const able = agentsWithCapability(deps.bus, 'maintenance');
  const only = able[0];
  if (only !== undefined && able.length === 1) return only;
  if (able.length > 1) {
    return refusal('conflict', 'More than one host can prune, and a prune request cannot name one yet.', 'Prune from the host with the Shipyard CLI meanwhile.');
  }
  const agents = await deps.db.agent.findMany({ where: { confirmedAt: { not: null } }, select: { id: true } });
  const one = agents[0];
  if (one !== undefined && agents.length === 1) {
    return capabilityRefusal(deps.bus, one.id, 'maintenance') ?? refusal('agent_offline', 'No agent can prune right now.');
  }
  return refusal('agent_offline', 'No agent that can prune has polled the server recently.', 'Check the agent is running and can reach the server, then retry.');
}

/**
 * Lists (a dry run) or prunes dangling and old unused images and old build cache (SHP-REQ-205):
 * deployer and up, any token. A real prune names a succeeded dry run of the same agent from the last
 * hour and carries its criteria; the agent removes only what that dry run listed and is still
 * eligible. The MCP tool calls this.
 */
export async function requestPrune(deps: ServiceDeps, caller: DeployCaller, input: PruneRequest, options: RequestOptions = {}): Promise<MaintenanceStatus | Refusal> {
  const { db } = deps;
  const denied = changeRefusal(caller, 'prune');
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  const agentId = await pruneAgent(deps);
  if (typeof agentId !== 'string') return agentId;
  const requester = requesterOf(actor, options.requester);

  if (input.dryRun) {
    return queueJob(deps, {
      agentId,
      volume: null,
      owner: null,
      body: {
        kind: 'prune',
        dryRun: true,
        images: { ...DEFAULT_PRUNE_IMAGES, ...input.images },
        buildCache: { ...DEFAULT_PRUNE_BUILD_CACHE, ...input.buildCache },
      },
      requester,
      audit: caller.audit,
    });
  }

  const required = refusal(
    'dry_run_required',
    'A prune follows a dry run of this host that succeeded within the last hour.',
    'Run a dry run (dryRun: true), read what it lists, then prune with fromDryRunId set to its ID.',
  );
  const fromId = input.fromDryRunId;
  if (fromId === undefined) return required;
  const from = await db.maintenanceJob.findUnique({ where: { id: fromId }, select: MAINTENANCE_SELECT });
  const job = from === null ? null : MaintenanceJob.safeParse(from.job);
  if (from === null || job?.success !== true || job.data.kind !== 'prune' || !job.data.dryRun) return required;
  if (from.state !== 'succeeded' || from.agentId !== agentId || from.finishedAt === null) return required;
  if (Date.now() - from.finishedAt.getTime() > DRY_RUN_FRESH_MS) return required;
  // One dry run, one prune (SHP-REQ-205): a second would remove what the first already judged.
  const used = refusal('dry_run_required', 'That dry run was already used; run a new one.', 'Run a dry run (dryRun: true), then prune with fromDryRunId set to its ID.');
  const earlier = await db.maintenanceJob.findFirst({ where: { dryRunOf: from.id, state: { not: 'refused' } }, select: { id: true } });
  if (earlier !== null) return used;
  return queueJob(deps, {
    // Two prunes racing past the check: `maintenance_job_one_prune_per_dry_run` lets one through.
    onUnique: used,
    agentId,
    volume: null,
    owner: null,
    dryRunOf: from.id,
    body: { kind: 'prune', dryRun: false, fromDryRunId: from.id, images: job.data.images, buildCache: job.data.buildCache },
    requester,
    audit: caller.audit,
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** The job, or null when there is no such job. */
export async function getMaintenance(db: Db, id: string): Promise<MaintenanceStatus | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db.maintenanceJob.findUnique({ where: { id }, select: MAINTENANCE_SELECT });
  return row === null ? null : toMaintenanceStatus(row);
}

/**
 * The job once it reaches a terminal state, or as it stands after `timeoutMs` (capped at
 * `MAX_MAINTENANCE_WAIT_MS`), whichever is first. Null when there is no such job. The wait is armed
 * before each read, so a publish between the read and the wait is not lost.
 */
export async function waitForMaintenance(deps: ServiceDeps, id: string, timeoutMs: number, signal?: AbortSignal): Promise<MaintenanceStatus | null> {
  const deadline = Date.now() + Math.max(0, Math.min(MAX_MAINTENANCE_WAIT_MS, timeoutMs));
  const aborted = (): boolean => signal?.aborted === true;
  for (;;) {
    await sweepStaleMaintenance(deps);
    const stop = new AbortController();
    const remaining = deadline - Date.now();
    const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    const woken = remaining > 0 ? deps.bus.wait(`maintenance:${id}`, remaining, combined) : null;
    try {
      const status = await getMaintenance(deps.db, id);
      if (status === null || isMaintenanceTerminal(status.state) || woken === null || aborted()) return status;
      await woken;
      if (aborted() || Date.now() >= deadline) return await getMaintenance(deps.db, id);
    } finally {
      stop.abort();
      if (woken !== null) await woken;
    }
  }
}

export interface ListMaintenanceOptions {
  limit: number;
  cursor?: string;
  /** A token's scope: jobs on the apps and stacks it names, and every prune. */
  scope?: { apps: ReadonlySet<string>; stacks: ReadonlySet<string> };
}

/** Maintenance jobs newest first, a page at a time (`GET /api/maintenance`, Activity). */
export async function listMaintenance(db: Db, options: ListMaintenanceOptions): Promise<MaintenancePage> {
  const and: Prisma.MaintenanceJobWhereInput[] = [];
  if (options.scope !== undefined) {
    and.push({
      OR: [
        { kind: 'prune' },
        { ownerKind: 'app', ownerName: { in: [...options.scope.apps] } },
        { ownerKind: 'stack', ownerName: { in: [...options.scope.stacks] } },
      ],
    });
  }
  if (options.cursor !== undefined) {
    const cur = decodeCursor(options.cursor);
    if (cur !== null) and.push({ OR: [{ createdAt: { lt: cur.createdAt } }, { createdAt: cur.createdAt, id: { lt: cur.id } }] });
  }
  const rows = await db.maintenanceJob.findMany({
    where: and.length > 0 ? { AND: and } : {},
    select: MAINTENANCE_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map(toMaintenanceStatus),
    nextCursor: rows.length > options.limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** A volume's unretired archives, newest first; a token's scope limits them to its owners. */
export async function listVolumeArchives(db: Db, volume: string, scope?: { apps: ReadonlySet<string>; stacks: ReadonlySet<string> }): Promise<VolumeArchive[]> {
  const rows = await db.volumeArchive.findMany({
    where: {
      volume,
      retiredAt: null,
      ...(scope === undefined
        ? {}
        : { OR: [{ ownerKind: 'app', ownerName: { in: [...scope.apps] } }, { ownerKind: 'stack', ownerName: { in: [...scope.stacks] } }] }),
    },
    orderBy: [{ createdAt: 'desc' }, { archiveId: 'desc' }],
  });
  return rows.map((r) => ({
    archiveId: r.archiveId,
    volume: r.volume,
    owner: ownerOfRow(r),
    createdAt: r.createdAt.toISOString(),
    sizeBytes: Number(r.sizeBytes),
    sha256: r.sha256,
    quiesced: r.quiesced,
  }));
}

export interface LowDisk {
  mount: string;
  usedPercent: number;
  freeBytes: number;
}

export interface MaintenanceNeedsYou {
  failedBackups: MaintenanceStatus[];
  lowDisk: LowDisk[];
}

/**
 * Needs you (SHP-ADR-012): per volume, its latest finished backup when that failed or was refused
 * (until a later one succeeds), and every filesystem in the latest host snapshots at least
 * `LOW_DISK_PERCENT` full.
 */
export async function maintenanceNeedsYou(db: Db): Promise<MaintenanceNeedsYou> {
  const latest = await db.maintenanceJob.findMany({
    where: { kind: 'volume-backup', state: { in: ['succeeded', 'failed', 'refused'] }, volume: { not: null } },
    select: MAINTENANCE_SELECT,
    orderBy: [{ volume: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    distinct: ['volume'],
  });
  const failedBackups = latest
    .filter((r) => r.state === 'failed' || r.state === 'refused')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toMaintenanceStatus);

  const snapshots = await db.hostSnapshot.findMany({ select: { inventory: true } });
  const seen = new Set<string>();
  const lowDisk: LowDisk[] = [];
  for (const snap of snapshots) {
    const parsed = HostInventory.safeParse(snap.inventory);
    if (!parsed.success) continue;
    for (const fs of [parsed.data.disk.dataRoot, parsed.data.disk.dockerRoot]) {
      if (fs === null || fs.totalBytes <= 0 || seen.has(fs.path)) continue;
      const usedPercent = Math.round(((fs.totalBytes - fs.freeBytes) / fs.totalBytes) * 1000) / 10;
      if (usedPercent < LOW_DISK_PERCENT) continue;
      seen.add(fs.path);
      lowDisk.push({ mount: fs.path, usedPercent, freeBytes: fs.freeBytes });
    }
  }
  return { failedBackups, lowDisk };
}

// ─── Dispatch (the agent's long poll) ──────────────────────────────────────────

/**
 * Claims the oldest queued job for `agentId` (`queued → dispatched`) in one statement, only when
 * none of its jobs is already dispatched or running — the agent does one at a time, and the partial
 * unique index refuses a second should two polls race. A restore waits while its owner is being
 * deployed, updated or acted on. `FOR UPDATE SKIP LOCKED` means two polls never take the same one.
 */
export async function claimMaintenance(deps: Pick<ServiceDeps, 'db' | 'logger'>, agentId: string): Promise<MaintenanceJob | null> {
  const { db, logger } = deps;
  let rows: { id: string }[];
  try {
    rows = await db.$queryRaw<{ id: string }[]>`
      update "maintenance_job" set "state" = 'dispatched', "dispatched_at" = now(), "updated_at" = now()
      where "id" = (
        select m."id" from "maintenance_job" m
        where m."agent_id" = ${agentId}::uuid
          and m."state" = 'queued'
          and not exists (
                select 1 from "maintenance_job" f
                where f."agent_id" = m."agent_id" and f."state" in ('dispatched', 'running'))
          and (m."kind" <> 'volume-restore' or (
                not exists (
                  select 1 from "deploy_target" t
                  join "app" ap on ap."id" = t."app_id"
                  where m."owner_kind" = 'app' and ap."name" = m."owner_name"
                    and t."state"::text in (${Prisma.join([...ACTIVE_STATES])}))
                and not exists (
                  select 1 from "stack_update" u
                  where m."owner_kind" = 'stack' and u."stack_name" = m."owner_name"
                    and u."state" in ('queued', 'dispatched', 'running'))
                and not exists (
                  select 1 from "action" a
                  where a."target_kind"::text = m."owner_kind" and a."target_name" = m."owner_name"
                    and a."state" in ('dispatched', 'running'))))
        order by m."created_at", m."id"
        for update of m skip locked
        limit 1
      )
      returning "id"::text as "id"`;
  } catch (err) {
    // Another poll of the same agent claimed one first: the in-flight index let only it through.
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const row = await db.maintenanceJob.findUniqueOrThrow({ where: { id }, select: MAINTENANCE_SELECT });
  const job = MaintenanceJob.safeParse(row.job);
  if (job.success && job.data.jobId === row.id) return job.data;
  logger.error({ maintenanceId: row.id }, 'stored maintenance job does not make a valid job; failed');
  await db.maintenanceJob.updateMany({
    where: { id: row.id, state: 'dispatched' },
    data: { state: 'failed', finishedAt: new Date(), refusal: refusal('invalid_request', 'This maintenance job could not be handed to the agent.', 'Request it again.') },
  });
  return null;
}

/** Puts a claimed job back, for a poll whose client went away before it could be answered. */
export async function releaseMaintenance(db: Db, id: string): Promise<void> {
  await db.maintenanceJob.updateMany({ where: { id, state: 'dispatched' }, data: { state: 'queued', dispatchedAt: null } });
}

/** The job, if it exists, was dispatched, and belongs to `agentId`. */
export async function ownMaintenance(db: Db, agentId: string, id: string): Promise<MaintenanceRow | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db.maintenanceJob.findUnique({ where: { id }, select: MAINTENANCE_SELECT });
  if (row?.agentId !== agentId || row.dispatchedAt === null) return null;
  return row;
}

export interface MaintenanceRecordOutcome {
  accepted: boolean;
  status: MaintenanceStatus;
}

/** `dispatched → running`, with the step. Not accepted once the job has ended. */
export async function recordMaintenanceProgress(deps: ServiceDeps, row: MaintenanceRow, body: MaintenanceProgress): Promise<MaintenanceRecordOutcome> {
  const { db, bus } = deps;
  if (isMaintenanceTerminal(row.state)) return { accepted: false, status: toMaintenanceStatus(row) };
  const updated = await db.maintenanceJob.updateMany({
    where: { id: row.id, state: { in: [...IN_FLIGHT_MAINTENANCE_STATES] } },
    // Every accepted report is a sign of life: updated_at moves, which the stale sweep reads.
    data: { state: 'running', step: body.step, ...(row.startedAt === null ? { startedAt: new Date() } : {}) },
  });
  const after = await db.maintenanceJob.findUniqueOrThrow({ where: { id: row.id }, select: MAINTENANCE_SELECT });
  if (updated.count === 0) return { accepted: false, status: toMaintenanceStatus(after) };
  bus.publish(`maintenance:${row.id}`);
  return { accepted: true, status: toMaintenanceStatus(after) };
}

function archiveData(agentId: string, a: VolumeArchive, now: Date) {
  return {
    agentId,
    volume: a.volume,
    ownerKind: a.owner?.kind ?? null,
    ownerName: a.owner?.name ?? null,
    createdAt: new Date(a.createdAt),
    sizeBytes: BigInt(a.sizeBytes),
    sha256: a.sha256,
    quiesced: a.quiesced,
    seenAt: now,
    retiredAt: null,
  };
}

/**
 * The terminal result, exactly once: a late or duplicate one is not accepted. A succeeded backup's
 * archive is mirrored at once (the next report confirms it), and the archives its retention removed
 * are retired.
 */
export async function recordMaintenanceResult(deps: ServiceDeps, row: MaintenanceRow, body: MaintenanceResult): Promise<MaintenanceRecordOutcome> {
  const { db, bus, logger } = deps;
  const now = new Date();
  const what = row.kind === 'prune' ? 'prune' : `${row.kind.replace('volume-', '')} of ${row.volume ?? 'the volume'}`;
  // A failure always carries a refusal, so the console has a next step to show.
  const why =
    body.refusal ??
    (body.state === 'failed'
      ? refusal('step_failed', `The ${what} failed on the host.`)
      : body.state === 'refused'
        ? refusal('conflict', `The agent refused the ${what}.`)
        : undefined);
  // What the job produced; the state and refusal have their own columns.
  const stored = {
    ...(body.archive === undefined ? {} : { archive: body.archive }),
    ...(body.removedArchives === undefined ? {} : { removedArchives: body.removedArchives }),
    ...(body.prune === undefined ? {} : { prune: body.prune }),
    ...(body.output === undefined ? {} : { output: body.output }),
  };
  const archive = row.kind === 'volume-backup' && body.state === 'succeeded' ? body.archive : undefined;
  const applied = await db.$transaction(async (tx) => {
    const updated = await tx.maintenanceJob.updateMany({
      where: { id: row.id, state: { in: [...IN_FLIGHT_MAINTENANCE_STATES] } },
      data: {
        state: body.state,
        finishedAt: now,
        ...(row.startedAt === null ? { startedAt: now } : {}),
        result: stored,
        ...(why === undefined ? {} : { refusal: why }),
      },
    });
    if (updated.count === 0) return false;
    const held = archive === undefined ? null : await tx.volumeArchive.findUnique({ where: { archiveId: archive.archiveId }, select: { agentId: true } });
    if (archive !== undefined && held !== null && held.agentId !== row.agentId) {
      // An archive ID another agent already reported stays that agent's, as in the report mirror.
      logger.error({ maintenanceId: row.id, archiveId: archive.archiveId, owner: held.agentId, reporter: row.agentId }, 'backup result names an archive of another agent; not mirrored');
    } else if (archive !== undefined) {
      if (archive.volume === row.volume) {
        const data = archiveData(row.agentId, archive, now);
        await tx.volumeArchive.upsert({ where: { archiveId: archive.archiveId }, create: { archiveId: archive.archiveId, ...data }, update: data });
      } else {
        logger.warn({ maintenanceId: row.id, volume: row.volume, archiveVolume: archive.volume }, 'backup result names an archive of another volume; not mirrored');
      }
    }
    if (body.removedArchives !== undefined && body.removedArchives.length > 0) {
      await tx.volumeArchive.updateMany({ where: { archiveId: { in: body.removedArchives }, agentId: row.agentId, retiredAt: null }, data: { retiredAt: now } });
    }
    return true;
  });
  const after = await db.maintenanceJob.findUniqueOrThrow({ where: { id: row.id }, select: MAINTENANCE_SELECT });
  if (!applied) return { accepted: false, status: toMaintenanceStatus(after) };
  bus.publish(`maintenance:${row.id}`);
  // The agent is free for its next job.
  bus.publish('work');
  return { accepted: true, status: toMaintenanceStatus(after) };
}

const STALE_ACTOR = { type: 'system', label: 'shipyard: stale maintenance sweep' } as const;

/**
 * Fails every job dispatched (or running) with no word from the agent for `MAINTENANCE_STALE_MS`:
 * `agent_offline`, "the agent did not report back". Audited `maintenance.expired` as the system.
 * One indexed query when nothing is stale. Returns the IDs.
 */
export async function sweepStaleMaintenance(deps: Pick<ServiceDeps, 'db' | 'bus' | 'logger'>, now: Date = new Date()): Promise<string[]> {
  const { db, bus, logger } = deps;
  const cutoff = new Date(now.getTime() - MAINTENANCE_STALE_MS);
  const stale = await db.maintenanceJob.findMany({
    where: { state: { in: [...IN_FLIGHT_MAINTENANCE_STATES] }, updatedAt: { lt: cutoff } },
    select: { id: true, state: true, kind: true, volume: true },
  });
  const failed: string[] = [];
  for (const row of stale) {
    const what = row.kind === 'prune' ? 'prune' : `${row.kind.replace('volume-', '')} of ${row.volume ?? 'a volume'}`;
    const why = refusal('agent_offline', `The agent did not report back on this ${what}.`, 'Check the agent is running and can reach the server, then look at the volume before retrying.');
    const updated = await db.maintenanceJob.updateMany({
      where: { id: row.id, state: { in: [...IN_FLIGHT_MAINTENANCE_STATES] } },
      data: { state: 'failed', refusal: why, finishedAt: now },
    });
    if (updated.count === 0) continue;
    failed.push(row.id);
    await directAudit(db, STALE_ACTOR)({
      action: 'maintenance.expired',
      entityType: 'maintenance_job',
      entityId: row.id,
      before: { state: row.state },
      after: { state: 'failed', refusal: 'agent_offline', kind: row.kind, volume: row.volume },
    });
    logger.warn({ maintenanceId: row.id, kind: row.kind, volume: row.volume }, 'maintenance job failed: the agent did not report back');
    bus.publish(`maintenance:${row.id}`);
  }
  if (failed.length > 0) bus.publish('work');
  return failed;
}

// ─── The agent's report: its archive ledger ──────────────────────────────────

export interface ArchiveMirrorChanges {
  added: string[];
  retired: string[];
}

/**
 * Mirrors the archives an agent's report lists (SHP-REQ-201): upserts each, and retires every
 * unretired archive of that agent the list no longer names — the report is the agent's whole
 * ledger. An archive ID another agent already reported is left to that agent. Returns what changed.
 */
export async function mirrorVolumeArchives(deps: Pick<ServiceDeps, 'db' | 'logger'>, agentId: string, archives: VolumeArchive[], now: Date = new Date()): Promise<ArchiveMirrorChanges> {
  const { db, logger } = deps;
  return db.$transaction(async (tx) => {
    const ids = archives.map((a) => a.archiveId);
    const known = await tx.volumeArchive.findMany({ where: { archiveId: { in: ids } }, select: { archiveId: true, agentId: true, retiredAt: true } });
    const byId = new Map(known.map((k) => [k.archiveId, k]));
    const added: string[] = [];
    const mirrored: string[] = [];
    for (const a of archives) {
      const before = byId.get(a.archiveId);
      if (before !== undefined && before.agentId !== agentId) {
        logger.error({ archiveId: a.archiveId, owner: before.agentId, reporter: agentId }, 'volume archive reported by a different agent; ignored');
        continue;
      }
      if (before === undefined || before.retiredAt !== null) added.push(a.archiveId);
      const data = archiveData(agentId, a, now);
      await tx.volumeArchive.upsert({ where: { archiveId: a.archiveId }, create: { archiveId: a.archiveId, ...data }, update: data });
      mirrored.push(a.archiveId);
    }
    const gone = await tx.volumeArchive.findMany({ where: { agentId, retiredAt: null, archiveId: { notIn: mirrored } }, select: { archiveId: true } });
    if (gone.length > 0) await tx.volumeArchive.updateMany({ where: { archiveId: { in: gone.map((g) => g.archiveId) } }, data: { retiredAt: now } });
    return { added, retired: gone.map((g) => g.archiveId) };
  });
}

// ─── Nightly backups (SHP-REQ-201, SHP-ADR-012) ───────────────────────────────

const NIGHTLY_ACTOR = { type: 'system', label: NIGHTLY_REQUESTER_LABEL } as const;

/**
 * Queues a backup, as the system, of every owned volume of every app and stack whose manifest says
 * `volumeBackups.nightly: true` — the volumes it lists, or every one it owns when it lists none —
 * with that manifest's `quiesce`. A volume with a backup already queued, dispatched or running is
 * skipped. They run one at a time per agent, oldest first. Returns the job IDs.
 */
export async function queueNightlyBackups(deps: ServiceDeps, now: Date = new Date()): Promise<string[]> {
  const { db, logger } = deps;
  const index = await volumeIndex(db);
  if (index.length === 0) return [];
  const { owners } = await ownersByAgent(db);
  const queued: string[] = [];
  for (const o of owners) {
    const settings = o.backups;
    if (settings?.nightly !== true) continue;
    const listed = settings.volumes === undefined ? null : new Set(settings.volumes);
    const volumes = index.filter(
      (v) => v.agentId === o.agentId && v.owner?.kind === o.owner.kind && v.owner.name === o.owner.name && (listed === null || listed.has(v.volume.name)),
    );
    if (listed !== null) {
      const missing = [...listed].filter((name) => !volumes.some((v) => v.volume.name === name));
      if (missing.length > 0) logger.warn({ owner: o.owner, missing }, 'nightly backup names volumes the owner does not mount; skipped');
    }
    for (const v of volumes) {
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const status = await queueJob(deps, {
        agentId: v.agentId,
        volume: v.volume.name,
        owner: o.owner,
        body: { kind: 'volume-backup', volume: v.volume.name, owner: o.owner, quiesce: settings.quiesce },
        requester: { kind: 'system', label: NIGHTLY_REQUESTER_LABEL },
        audit: directAudit(db, NIGHTLY_ACTOR),
        createdAt: now,
        // Idempotent per agent, volume and server-local day: two server processes ticking in the
        // same hour serialise on this lock, and the second sees the first's row.
        lockKeys: [`shipyard:nightly:${v.agentId}:${v.volume.name}`],
        guard: async (tx) => {
          const already = await tx.maintenanceJob.findFirst({
            where: {
              kind: 'volume-backup',
              volume: v.volume.name,
              agentId: v.agentId,
              OR: [
                { state: { in: [...ACTIVE_MAINTENANCE_STATES] } },
                { requesterKind: 'system', requesterLabel: NIGHTLY_REQUESTER_LABEL, createdAt: { gte: dayStart } },
              ],
            },
            select: { id: true },
          });
          return already === null ? null : refusal('conflict', `${v.volume.name} already has a backup queued, running or taken tonight.`);
        },
      });
      if ('code' in status) continue;
      queued.push(status.id);
    }
  }
  if (queued.length > 0) logger.info({ count: queued.length, at: now.toISOString() }, 'nightly volume backups queued');
  return queued;
}

function localDay(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`;
}

/**
 * The nightly scheduler's decision, separate from its timer so a test can drive it with any clock:
 * `tick(now)` queues the night's backups once per server-local day, during `hour`. A restart within
 * that hour does not queue them again — a nightly backup already requested since the hour began
 * counts. Returns the job IDs queued, or null when it was not time.
 */
export function nightlyBackups(deps: ServiceDeps, hour: number): { tick(now: Date): Promise<string[] | null> } {
  let doneFor: string | null = null;
  return {
    async tick(now: Date): Promise<string[] | null> {
      if (now.getHours() !== hour) return null;
      const day = localDay(now);
      if (doneFor === day) return null;
      const since = new Date(now);
      since.setMinutes(0, 0, 0);
      const already = await deps.db.maintenanceJob.count({
        where: { kind: 'volume-backup', requesterKind: 'system', requesterLabel: NIGHTLY_REQUESTER_LABEL, createdAt: { gte: since } },
      });
      const queued = already > 0 ? [] : await queueNightlyBackups(deps, now);
      doneFor = day;
      return queued;
    },
  };
}

/** How often the nightly scheduler looks at the clock. */
export const NIGHTLY_CHECK_INTERVAL_MS = 60_000;

/** Starts the nightly volume backups; the stopper waits for a run in flight. */
export function startNightlyBackups(
  deps: ServiceDeps,
  options: { hour: number; intervalMs?: number; clock?: () => Date },
): { stop(): Promise<void> } {
  const runner = nightlyBackups(deps, options.hour);
  const clock = options.clock ?? (() => new Date());
  let stopped = false;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (running) return;
    running = true;
    inFlight = runner
      .tick(clock())
      .then(() => undefined)
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'nightly volume backups failed');
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs ?? NIGHTLY_CHECK_INTERVAL_MS);
  tick();
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
