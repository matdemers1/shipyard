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

export const MCP_TOOLS = {
  shipyard_status: ShipyardStatusInput,
  shipyard_dry_run: ShipyardDryRunInput,
  shipyard_deploy: ShipyardDeployInput,
  shipyard_deploy_status: ShipyardDeployStatusInput,
  shipyard_rollback: ShipyardRollbackInput,
} as const;
