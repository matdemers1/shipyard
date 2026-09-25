import type { Router } from 'express';
import { AgentRelease, AgentReport, REPORTED_RELEASES_PER_APP, refusal } from '@shipyard/schema';
import { verifyAgentRequest } from '../agent/verify.js';
import type { Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { detectDrift } from './drift.js';

/**
 * POST /api/agent/report (SHP-REQ-036, SHP-REQ-104; SHP-D-060). The agent reports its parsed
 * manifests with content hashes and the digests it sees running; the server mirrors them.
 *
 * **This module (with drift.ts beside it) is the only code that writes `app` rows.** A guard test
 * greps the server source and fails if anything else does. Apps absent from a report are left as
 * they were — their `reportedAt` simply ages; nothing is ever deleted.
 *
 * Ledger sync (SHP-REQ-111): the report also carries the agent ledger's verified releases. Each
 * one the server does not hold — a deploy made on the host with the CLI — is recorded as a
 * succeeded, agent-executed deploy under the ledger's own deploy ID, so it becomes the recorded
 * release when it is the newest, a rollback target otherwise, and never a Foreman row (no outbox).
 */

/** Who an imported release is recorded as requested by. */
export const IMPORTED_REQUESTER_LABEL = 'agent ledger (host CLI or earlier deploy)';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Release = NonNullable<AgentReport['releases']>[number];

export interface ImportedRelease {
  app: string;
  deployId: string;
  kind: Release['kind'];
  sha: string;
  at: string;
}

/**
 * Records, inside the report's transaction, every release of `appId` in `releases` that no deploy
 * row holds yet. A deploy the server dispatched carries the server's own ID into the ledger, so it
 * is found and skipped, never duplicated. A deploy ID that is not a UUID cannot be a deploy's ID
 * and is skipped with a log line. Only the newest `REPORTED_RELEASES_PER_APP` are considered.
 */
/** How far ahead of the server's clock an agent's ledger time may be before it is refused. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

async function importReleases(
  tx: Prisma.TransactionClient,
  appId: string,
  releases: Release[],
  logger: ServiceDeps['logger'],
): Promise<ImportedRelease[]> {
  const newest = releases.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, REPORTED_RELEASES_PER_APP);
  const candidates: Release[] = [];
  const seen = new Set<string>();
  // A ledger time is the agent's clock: one from the future (skew, or a forged line) must never
  // outrank a real release as the app's live one.
  const latestAllowed = Date.now() + FUTURE_SKEW_MS;
  for (const r of newest) {
    if (Date.parse(r.at) > latestAllowed) {
      logger.warn({ app: r.app, deployId: r.deployId, at: r.at }, 'ledger release is dated in the future; not imported');
      continue;
    }
    if (!UUID_RE.test(r.deployId)) {
      logger.warn({ app: r.app, deployId: r.deployId }, 'ledger release has a deploy ID that is not a UUID; not imported');
      continue;
    }
    const id = r.deployId.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({ ...r, deployId: id });
  }
  if (candidates.length === 0) return [];
  const held = await tx.deploy.findMany({ where: { id: { in: candidates.map((r) => r.deployId) } }, select: { id: true } });
  const known = new Set(held.map((d) => d.id));

  const imported: ImportedRelease[] = [];
  for (const r of candidates.toReversed()) {
    if (known.has(r.deployId)) continue;
    const at = new Date(r.at);
    await tx.deploy.create({
      data: {
        id: r.deployId,
        kind: r.kind,
        requestedSha: r.sha,
        requesterLabel: IMPORTED_REQUESTER_LABEL,
        createdAt: at,
        targets: {
          create: {
            appId,
            state: 'succeeded',
            // The agent executed it: a release in its own ledger, so a rollback target (SHP-D-080).
            dispatchedAt: at,
            startedAt: at,
            endedAt: at,
            images: {
              create: r.images.map((i) => ({ service: i.service, repo: i.repo, sha: r.sha, digest: i.digest, migrationLabel: i.migration })),
            },
          },
        },
      },
    });
    imported.push({ app: r.app, deployId: r.deployId, kind: r.kind, sha: r.sha, at: r.at });
  }
  return imported;
}

/** JSON with object keys sorted, so the same manifest always mirrors to the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  }, 2);
}

export function mountReport(router: Router, deps: ServiceDeps): void {
  const { db, logger, bus } = deps;

  router.post('/report', verifyAgentRequest(deps), async (req, res) => {
    const agentId = req.agent?.id;
    if (agentId === undefined || agentId === null) {
      sendRefusal(res, refusal('not_enrolled', 'Only an enrolled agent can report.'));
      return;
    }
    // One bad ledger release must not cost the agent its whole report (and its heartbeat): each
    // release is validated on its own, and those that fail are dropped with a warning.
    const body: unknown = req.body;
    if (typeof body === 'object' && body !== null && Array.isArray((body as { releases?: unknown }).releases)) {
      const all = (body as { releases: unknown[] }).releases;
      const valid = all.filter((r) => AgentRelease.safeParse(r).success);
      if (valid.length !== all.length) {
        deps.logger.warn({ agentId, dropped: all.length - valid.length }, 'agent report carried ledger releases that failed validation; dropped');
      }
      (body as { releases: unknown[] }).releases = valid;
    }
    const parsed = AgentReport.safeParse(body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal('invalid_request', 'The agent report failed validation.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')),
      );
      return;
    }
    const report = parsed.data;
    const names = report.apps.map((a) => a.manifest.name);
    if (new Set(names).size !== names.length) {
      sendRefusal(res, refusal('invalid_request', 'The agent report names an app more than once.'));
      return;
    }

    const now = new Date();
    const changed: string[] = [];
    const created: string[] = [];
    const drifted: { app: string; services: string[] }[] = [];
    const refusedApps: string[] = [];
    // Apps whose pending redeploy-recorded this report resolved: the recorded release runs again.
    const redeployed: string[] = [];
    // Ledger releases recorded by this report, and apps whose drift an imported release explained.
    const imported: ImportedRelease[] = [];
    const importClosed: string[] = [];

    await db.$transaction(async (tx) => {
      for (const entry of report.apps) {
        const m = entry.manifest;
        const fields = {
          agentId,
          manifestYaml: canonicalJson(m),
          manifestSha256: entry.manifestSha256,
          repo: m.repo,
          defaultBranch: m.defaultBranch,
          services: m.services as Prisma.InputJsonValue,
          soakSeconds: m.soakSeconds,
          approvalPolicy: m.approval,
          foremanProject: m.foreman?.project ?? null,
          foremanEnvironment: m.foreman?.environment ?? null,
          groupName: m.group ?? null,
          canary: m.canary ?? false,
          reportedAt: now,
          runningDigests: entry.running as Prisma.InputJsonValue,
        };
        const before = await tx.app.findUnique({ where: { name: m.name }, select: { manifestSha256: true, agentId: true } });
        if (before !== null && before.agentId !== agentId) {
          // An app belongs to the agent that first reported it. Another agent naming it is refused,
          // not merged: moving an app between hosts is a deliberate act, never a side effect.
          refusedApps.push(m.name);
          logger.error({ app: m.name, owner: before.agentId, reporter: agentId }, 'app reported by a different agent; ignored');
          continue;
        }
        if (before === null) created.push(m.name);
        else if (before.manifestSha256 !== entry.manifestSha256) changed.push(m.name);
        const row = await tx.app.upsert({
          where: { name: m.name },
          create: { name: m.name, ...fields },
          update: fields,
          select: { id: true },
        });
        const ownReleases = (report.releases ?? []).filter((r) => r.app === m.name);
        const importedHere = await importReleases(tx, row.id, ownReleases, logger);
        imported.push(...importedHere);
        const outcome = await detectDrift(tx, row, entry.running, Object.keys(m.services), new Set(importedHere.map((r) => r.deployId)));
        if (outcome.closedByImport) importClosed.push(m.name);
        if (outcome.opened) drifted.push({ app: m.name, services: outcome.services });
        if (outcome.resolved) redeployed.push(m.name);
      }
      await tx.agent.update({
        where: { id: agentId },
        data: {
          agentVersion: report.agentVersion,
          composeVersion: report.composeVersion,
          engineApiVersion: report.engineApiVersion,
          lastHeartbeatAt: now,
          // The GitHub token's own expiry, as the agent reports it (SHP-REQ-094).
          patExpiresAt: report.patExpiresAt === null ? null : new Date(report.patExpiresAt),
        },
      });
    });

    for (const d of drifted) {
      logger.warn({ app: d.app, services: d.services }, 'drift detected: running digests differ from the recorded release');
    }

    for (const name of importClosed) {
      logger.info({ app: name }, 'drift closed: what runs is a release from the agent ledger, deployed outside the server');
    }
    for (const r of imported) {
      logger.info({ app: r.app, deployId: r.deployId, kind: r.kind, sha: r.sha }, 'imported a release from the agent ledger');
      await req.audit({
        action: 'deploy.imported',
        entityType: 'deploy',
        entityId: r.deployId,
        after: { app: r.app, kind: r.kind, sha: r.sha, at: r.at, source: IMPORTED_REQUESTER_LABEL },
      });
    }

    for (const name of redeployed) {
      logger.info({ app: name }, 'drift resolved: the recorded release is running again after a redeploy');
    }

    // A periodic report that changed nothing is a heartbeat, not an event.
    if (created.length === 0 && changed.length === 0 && drifted.length === 0 && refusedApps.length === 0 && redeployed.length === 0 && importClosed.length === 0) {
      if (imported.length === 0) req.noAuditNeeded('unchanged report');
    } else {
      await req.audit({
        action: 'agent.report',
        entityType: 'agent',
        entityId: agentId,
        after: {
          apps: report.apps.map((a) => ({ name: a.manifest.name, manifestSha256: a.manifestSha256 })),
          created,
          changed,
          drifted,
          redeployed,
          importClosed,
          refused: refusedApps,
        },
      });
    }

    for (const name of names) bus.publish(`app:${name}`);

    res.status(200).json({ apps: names.length, created, changed, drifted: drifted.map((d) => d.app), refused: refusedApps, imported: imported.map((r) => r.deployId) });
  });
}
