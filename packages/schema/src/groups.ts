import type { DeployStatus } from './api.js';
import type { DeployTargetState } from './agent.js';

/**
 * Group deploy API contracts (SHP-T-5.2/5.3, SHP-REQ-078/079, SHP-D-047).
 *
 * A group deploy is requested through `POST /api/deploys` (or the `shipyard_deploy` MCP tool) with
 * `group` in place of `app` — the request is validated by `DeployRequest`. Its members are the apps
 * whose manifest names that group; they are all locked in one transaction and deployed one at a
 * time — the canary first, if one is declared, then the rest by app name — stopping at the first
 * member that does not succeed.
 *
 * These are response shapes only (the server writes them; nothing parses them), so they are plain
 * types rather than Zod schemas, and carry no fixtures.
 */

/** A group as the agent's reports describe it: its members, in deploy order. */
export interface GroupSummary {
  name: string;
  /** The member deployed and soaked first, whose digests the rest must match; null when none is declared. */
  canary: string | null;
  /** Every member, in the order a group deploy ships them (the canary first). */
  members: string[];
}

/** A group deploy's status: the overall state and every member's own status, in deploy order. */
export interface GroupDeployStatus {
  deployId: string;
  group: string;
  sha: string;
  canary: string | null;
  /**
   * `succeeded` once every member has; otherwise the state of the first member that has not
   * succeeded — the one running, or the one that stopped the group.
   */
  state: DeployTargetState;
  members: DeployStatus[];
}
