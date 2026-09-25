import type { Router } from 'express';
import { AgentReport, refusal } from '@shipyard/schema';
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
 */

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
    const parsed = AgentReport.safeParse(req.body);
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
        const outcome = await detectDrift(tx, row, entry.running, Object.keys(m.services));
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

    for (const name of redeployed) {
      logger.info({ app: name }, 'drift resolved: the recorded release is running again after a redeploy');
    }

    // A periodic report that changed nothing is a heartbeat, not an event.
    if (created.length === 0 && changed.length === 0 && drifted.length === 0 && refusedApps.length === 0 && redeployed.length === 0) {
      req.noAuditNeeded('unchanged report');
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
          refused: refusedApps,
        },
      });
    }

    for (const name of names) bus.publish(`app:${name}`);

    res.status(200).json({ apps: names.length, created, changed, drifted: drifted.map((d) => d.app), refused: refusedApps });
  });
}
