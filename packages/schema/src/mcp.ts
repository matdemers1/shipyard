import { z } from 'zod';

import { AppName, Sha40 } from './primitives.js';
import { Requester } from './api.js';

/**
 * MCP tool input shapes (SHP-REQ-004): one Zod schema per tool, so the MCP
 * server at /mcp validates the same way the REST API does.
 */

export const ShipyardStatusInput = z
  .strictObject({
    app: AppName.optional(),
  })
  .meta({ id: 'ShipyardStatusInput', description: 'Input for the shipyard_status tool' });
export type ShipyardStatusInput = z.infer<typeof ShipyardStatusInput>;

export const ShipyardDryRunInput = z
  .strictObject({
    app: AppName,
    sha: Sha40,
  })
  .meta({ id: 'ShipyardDryRunInput', description: 'Input for the shipyard_dry_run tool' });
export type ShipyardDryRunInput = z.infer<typeof ShipyardDryRunInput>;

// Same exactly-one-of-app/group shape as DeployRequest; see api.ts for the
// JSON Schema caveat this refine introduces.
export const ShipyardDeployInput = z
  .strictObject({
    app: AppName.optional(),
    group: z.string().min(1).optional(),
    sha: Sha40,
    requester: Requester,
  })
  .refine((v) => (v.app === undefined) !== (v.group === undefined), 'exactly one of app or group is required')
  .meta({ id: 'ShipyardDeployInput', description: 'Input for the shipyard_deploy tool' });
export type ShipyardDeployInput = z.infer<typeof ShipyardDeployInput>;

export const ShipyardDeployStatusInput = z
  .strictObject({
    deployId: z.string().min(1),
    wait: z.int().min(0).max(90).optional(),
  })
  .meta({ id: 'ShipyardDeployStatusInput', description: 'Input for the shipyard_deploy_status tool' });
export type ShipyardDeployStatusInput = z.infer<typeof ShipyardDeployStatusInput>;

export const ShipyardRollbackInput = z
  .strictObject({
    app: AppName,
    toDeployId: z.string().min(1),
    requester: Requester,
  })
  .meta({ id: 'ShipyardRollbackInput', description: 'Input for the shipyard_rollback tool' });
export type ShipyardRollbackInput = z.infer<typeof ShipyardRollbackInput>;

export const ShipyardBuildInput = z
  .strictObject({
    app: AppName,
    sha: Sha40,
    requester: Requester,
  })
  .meta({ id: 'ShipyardBuildInput', description: 'Input for the shipyard_build tool' });
export type ShipyardBuildInput = z.infer<typeof ShipyardBuildInput>;

export const ShipyardBuildStatusInput = z
  .strictObject({
    buildId: z.uuid(),
  })
  .meta({ id: 'ShipyardBuildStatusInput', description: 'Input for the shipyard_build_status tool' });
export type ShipyardBuildStatusInput = z.infer<typeof ShipyardBuildStatusInput>;

// No fields at all (SHP-ADR-009): nothing reaches the agent, and the tool reads every host.
export const ShipyardHostInput = z
  .strictObject({})
  .meta({ id: 'ShipyardHostInput', description: 'Input for the shipyard_host tool (none: it reads every host)' });
export type ShipyardHostInput = z.infer<typeof ShipyardHostInput>;

/** `shipyard_action` (SHP-ADR-010): stop is console-only (SHP-REQ-188), so it is not a choice here. */
export const ShipyardActionInput = z
  .strictObject({
    name: AppName,
    verb: z.enum(['start', 'restart', 'recreate']),
    service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/).optional(),
    requester: Requester,
  })
  .meta({ id: 'ShipyardActionInput', description: 'Input for the shipyard_action tool' });
export type ShipyardActionInput = z.infer<typeof ShipyardActionInput>;

/** `shipyard_logs` (SHP-ADR-011): a bounded tail, never a follow. */
export const ShipyardLogsInput = z
  .strictObject({
    /** A container name as the Host view shows it, or its full ID. */
    container: z.string().min(1).max(255),
    tail: z.int().min(1).max(500).default(100),
  })
  .meta({ id: 'ShipyardLogsInput', description: 'Input for the shipyard_logs tool' });
export type ShipyardLogsInput = z.infer<typeof ShipyardLogsInput>;

/** `shipyard_stack_update` (SHP-P-16): to the reported candidates; held for approval by default. */
export const ShipyardStackUpdateInput = z
  .strictObject({
    stack: AppName,
    requester: Requester,
  })
  .meta({ id: 'ShipyardStackUpdateInput', description: 'Input for the shipyard_stack_update tool' });
export type ShipyardStackUpdateInput = z.infer<typeof ShipyardStackUpdateInput>;

export const MCP_TOOLS = {
  shipyard_status: ShipyardStatusInput,
  shipyard_dry_run: ShipyardDryRunInput,
  shipyard_deploy: ShipyardDeployInput,
  shipyard_deploy_status: ShipyardDeployStatusInput,
  shipyard_rollback: ShipyardRollbackInput,
  shipyard_build: ShipyardBuildInput,
  shipyard_build_status: ShipyardBuildStatusInput,
  shipyard_host: ShipyardHostInput,
  shipyard_action: ShipyardActionInput,
  shipyard_logs: ShipyardLogsInput,
  shipyard_stack_update: ShipyardStackUpdateInput,
} as const;
