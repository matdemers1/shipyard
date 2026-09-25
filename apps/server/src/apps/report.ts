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
        if (before === null) created.push(m.name);
        else if (before.manifestSha256 !== entry.manifestSha256) changed.push(m.name);
        if (before !== null && before.agentId !== agentId) {
          logger.warn({ app: m.name, from: before.agentId, to: agentId }, 'app reported by a different agent');
        }
        const row = await tx.app.upsert({
          where: { name: m.name },
          create: { name: m.name, ...fields },
          update: fields,
          select: { id: true },
        });
        const outcome = await detectDrift(tx, row, entry.running);
        if (outcome.opened) drifted.push({ app: m.name, services: outcome.services });
      }
      await tx.agent.update({
        where: { id: agentId },
        data: {
          agentVersion: report.agentVersion,
          composeVersion: report.composeVersion,
          engineApiVersion: report.engineApiVersion,
          lastHeartbeatAt: now,
        },
      });
    });

    for (const d of drifted) {
      logger.warn({ app: d.app, services: d.services }, 'drift detected: running digests differ from the recorded release');
    }

    await req.audit({
      action: 'agent.report',
      entityType: 'agent',
      entityId: agentId,
      after: {
        apps: report.apps.map((a) => ({ name: a.manifest.name, manifestSha256: a.manifestSha256 })),
        created,
        changed,
        drifted,
      },
    });

    for (const name of names) bus.publish(`app:${name}`);

    res.status(200).json({ apps: names.length, created, changed, drifted: drifted.map((d) => d.app) });
  });
}
