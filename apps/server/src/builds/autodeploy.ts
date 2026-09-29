import { parseManifestYaml, refusal, type Refusal } from '@shipyard/schema';
import type { AuditEventInput } from '../audit.js';
import { Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { createDeploy, isRefusal, type DeployCaller } from '../deploys/service.js';
import { addBuildHooks, type BuildResultEvent } from './service.js';

/**
 * Opt-in auto-deploy on a green build (SHP-T-7.14, SHP-REQ-138, SHP-REQ-139, SHP-REQ-150). Wired
 * with `addBuildHooks`'s `onResult`, which fires once per accepted build result — a replayed
 * result is never re-accepted by `recordBuildResult`, so it never reaches this hook a second time.
 *
 * The label everyone sees, on the deploy and on the lock refusal that names its holder, is
 * exactly `shipyard: auto-deploy` (SHP-REQ-138).
 *
 * The caller acts as a token so an approval-required app gets the same held `awaiting_approval`
 * treatment a human-triggered token deploy gets — auto-deploy never bypasses a human gate. A
 * pending approval already sitting on the app is treated as a refusal here (not by `createDeploy`,
 * which would otherwise happily stack a second `awaiting_approval` target): auto-deploy asks once
 * and waits, it does not pile up approval requests every time CI is green.
 */

const AUTO_DEPLOY_LABEL = 'shipyard: auto-deploy';

/** Marks a build as claimed for auto-deploy before the request is made, so a concurrent or
 * replayed `onResult` for the same build can never make a second request (SHP-REQ-150). Not a
 * real `Refusal` — `getBuild` only reports `autoDeployRefusal` when it parses as one, so this
 * transient marker is never shown. */
const CLAIM_MARKER = { claiming: true } as const;

function pendingApprovalRefusal(appName: string): Refusal {
  return refusal(
    'approval_required',
    `${appName} already has a deploy awaiting approval; auto-deploy will not request a second one.`,
    'Decide the pending approval, then the next successful build will auto-deploy.',
  );
}

async function claim(deps: ServiceDeps, buildId: string): Promise<boolean> {
  const claimed = await deps.db.build.updateMany({
    where: { id: buildId, autoDeployId: null, autoDeployRefusal: { equals: Prisma.DbNull } },
    data: { autoDeployRefusal: CLAIM_MARKER },
  });
  return claimed.count === 1;
}

async function recordAccepted(deps: ServiceDeps, buildId: string, deployId: string): Promise<void> {
  await deps.db.build.update({ where: { id: buildId }, data: { autoDeployId: deployId, autoDeployRefusal: Prisma.DbNull } });
}

async function recordRefused(deps: ServiceDeps, buildId: string, why: Refusal): Promise<void> {
  await deps.db.build.update({ where: { id: buildId }, data: { autoDeployRefusal: why } });
}

function directAudit(deps: ServiceDeps): (event: AuditEventInput) => Promise<void> {
  return async (event) => {
    await deps.db.auditEvent.create({
      data: {
        actorType: 'token',
        actorLabel: AUTO_DEPLOY_LABEL,
        action: event.action,
        entityType: event.entityType,
        ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
        ...(event.before !== undefined ? { before: event.before as object } : {}),
        ...(event.after !== undefined ? { after: event.after as object } : {}),
      },
    });
  };
}

export interface HandleBuildResultOptions {
  /** Injected for tests, to force a throw from the request itself (SHP-T-7.20, SHP-REQ-139). */
  createDeploy?: typeof createDeploy;
}

/**
 * The hook body itself, exported (in addition to `registerAutoDeploy`) so the test can call it
 * directly, twice at once on the same build, to prove the claim is race-safe (SHP-REQ-150) without
 * needing two real agents.
 */
export async function handleBuildResult(
  deps: ServiceDeps,
  event: BuildResultEvent,
  options: HandleBuildResultOptions = {},
): Promise<void> {
  if (event.state !== 'succeeded') return;

  const app = await deps.db.app.findUnique({ where: { name: event.app }, select: { manifestYaml: true } });
  if (app === null) return;

  let autoDeploy: boolean;
  let source: string | undefined;
  let repo: string;
  let branch: string;
  try {
    const manifest = parseManifestYaml(app.manifestYaml);
    autoDeploy = manifest.autoDeploy === true;
    source = manifest.build?.source;
    repo = manifest.repo;
    branch = manifest.defaultBranch;
  } catch {
    return;
  }
  if (!autoDeploy || source !== 'shipyard') return;

  if (!(await claim(deps, event.buildId))) return;

  const audit = directAudit(deps);
  const caller: DeployCaller = {
    actor: { type: 'token', label: AUTO_DEPLOY_LABEL },
    role: 'admin',
    tokenApps: new Set([event.app]),
    audit,
  };

  try {
    const alreadyPending = await deps.db.deployTarget.findFirst({
      where: { state: 'awaiting_approval', app: { name: event.app } },
      select: { id: true },
    });
    if (alreadyPending !== null) {
      const why = pendingApprovalRefusal(event.app);
      await recordRefused(deps, event.buildId, why);
      deps.logger.info({ buildId: event.buildId, app: event.app, refusal: why }, 'auto-deploy refused');
      return;
    }

    const doCreateDeploy = options.createDeploy ?? createDeploy;
    const result = await doCreateDeploy(deps, caller, {
      kind: 'deploy',
      app: event.app,
      sha: event.sha,
      requester: { label: AUTO_DEPLOY_LABEL, repo, branch },
    });

    if (isRefusal(result)) {
      await recordRefused(deps, event.buildId, result);
      deps.logger.info({ buildId: event.buildId, app: event.app, refusal: result }, 'auto-deploy refused');
      return;
    }

    await recordAccepted(deps, event.buildId, result.deployId);
    deps.logger.info({ buildId: event.buildId, app: event.app, deployId: result.deployId, state: result.state }, 'auto-deploy requested');
  } catch (err) {
    // Never let a bug here poison the build's own success record; overwrite the claim marker
    // with a real, parseable refusal so BuildDetail shows something instead of the marker
    // forever, and the claim keeps it from ever being retried (SHP-T-7.20, SHP-REQ-139,
    // SHP-REQ-150).
    const message = err instanceof Error ? err.message : String(err);
    const truncated = message.length > 200 ? `${message.slice(0, 200)}…` : message;
    const why = refusal(
      'interrupted',
      `The auto-deploy request failed unexpectedly: ${truncated}`,
      'Deploy this build from the console or MCP.',
    );
    deps.logger.error({ err, buildId: event.buildId, app: event.app }, 'auto-deploy failed');
    await recordRefused(deps, event.buildId, why);
  }
}

/**
 * Registers the auto-deploy hook on `deps.bus`. Returns an unregister function. The app (`app.ts`
 * / `index.ts`) calls this once at boot, alongside the other build hooks.
 */
export function registerAutoDeploy(deps: ServiceDeps): () => void {
  return addBuildHooks(deps.bus, { onResult: handleBuildResult });
}
