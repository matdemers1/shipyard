import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ShipyardDeployInput,
  ShipyardDeployStatusInput,
  ShipyardDryRunInput,
  ShipyardRollbackInput,
  ShipyardStatusInput,
  refusal,
  type DeployStatus,
  type Refusal,
} from '@shipyard/schema';
import { z } from 'zod';
import type { ServiceDeps } from '../deps.js';
import {
  MAX_WAIT_SECONDS,
  createDeploy,
  getDeployStatus,
  isRefusal,
  isTerminal,
  waitForChange,
  type DeployCaller,
} from '../deploys/service.js';
import { getGroupDeployStatus, waitForGroupChange } from '../groups/service.js';
import { appStatuses } from './status.js';

/**
 * The five MCP tools (SHP-REQ-041). Every tool is a thin shell over the deploy service: no deploy
 * logic lives here, and no tool accepts a command, a path or an image reference (SHP-REQ-053) —
 * only app names, 40-hex SHAs, deploy IDs and who is asking. Freeze, schedule, restore and approval
 * are console-only (SHP-D-072).
 */

export interface McpOptions {
  /**
   * How long `shipyard_dry_run` waits for the agent to finish evaluating the gates before it
   * answers "still running". Under the 90 s cap (SHP-D-025); tests shorten it.
   */
  dryRunWaitSeconds?: number;
}

export const DEFAULT_DRY_RUN_WAIT_SECONDS = 85;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_GREEN_SHA_NOTE =
  'The newest green SHA on main is not reported: the Shipyard server does not track CI. The agent ' +
  're-verifies CI, main and GHCR itself for every deploy; use shipyard_dry_run to check a SHA.';

/**
 * The schema package's tool inputs carry a `.meta({ id })`, which makes their JSON Schema a root
 * `$ref`; MCP clients require `inputSchema.type === 'object'`. The same fields, still strict (an
 * unknown key is rejected, never ignored). The deploy input's app-xor-group refine is re-checked
 * in its handler.
 */
function toolInput<S extends z.ZodRawShape>(schema: { shape: S }) {
  return z.strictObject(schema.shape);
}

function ok(value: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** A refusal, verbatim as the REST API sends it: `{"error":{code,gate,message,fix}}`. */
function refused(r: Refusal): CallToolResult {
  const body = { error: r };
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

function scopeOf(caller: DeployCaller): ReadonlySet<string> {
  return caller.tokenApps ?? new Set<string>();
}

function outOfScope(caller: DeployCaller, app: string): Refusal | null {
  if (scopeOf(caller).has(app)) return null;
  return refusal('forbidden', `This token is not scoped to ${app}.`, `Use a token issued for ${app}, or issue a new one that names it.`);
}

const NO_SUCH_DEPLOY = refusal('not_found', 'No such deploy.', 'Use the deployId that shipyard_deploy or shipyard_rollback returned.');

/**
 * A fresh server for one stateless request. `signal` aborts when the HTTP request closes, so a
 * long wait never outlives the caller.
 */
export function buildMcpServer(
  deps: ServiceDeps,
  caller: DeployCaller,
  signal: AbortSignal,
  options: McpOptions = {},
): McpServer {
  const server = new McpServer({ name: 'shipyard', version: deps.config.SHIPYARD_VERSION });
  const dryRunWait = Math.min(options.dryRunWaitSeconds ?? DEFAULT_DRY_RUN_WAIT_SECONDS, MAX_WAIT_SECONDS);

  server.registerTool(
    'shipyard_status',
    {
      title: 'Shipyard status',
      description:
        'Read-only. For each app this token is scoped to (or just `app`): the live release (SHA, image digest per ' +
        'service, schema revision), open drift, who holds the deploy lock and at which step, and the last finished ' +
        'result. The newest green SHA on main is not included: the server does not track CI. Changes nothing.',
      inputSchema: toolInput(ShipyardStatusInput),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app }) => {
      let names: string[];
      if (app !== undefined) {
        const denied = outOfScope(caller, app);
        if (denied !== null) return refused(denied);
        names = [app];
      } else {
        names = [...scopeOf(caller)];
      }
      const apps = await appStatuses(deps.db, names);
      if (app !== undefined && apps.length === 0) {
        return refused(refusal('unknown_app', `No app named ${app} has been reported by the agent.`));
      }
      return ok({ apps, note: NO_GREEN_SHA_NOTE });
    },
  );

  server.registerTool(
    'shipyard_dry_run',
    {
      title: 'Dry-run a deploy',
      description:
        'Asks the agent to evaluate every deploy gate for `app` at `sha` without changing anything and without ' +
        `taking the lock. Waits up to ${String(dryRunWait)} s, then returns each gate with pass/fail and its reason. ` +
        'If the agent has not finished by then, returns the deployId with finished: false; follow up with ' +
        'shipyard_deploy_status. `sha` must be a full 40-character commit SHA.',
      inputSchema: toolInput(ShipyardDryRunInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ app, sha }) => {
      const denied = outOfScope(caller, app);
      if (denied !== null) return refused(denied);
      const row = await deps.db.app.findUnique({ where: { name: app }, select: { repo: true, defaultBranch: true } });
      const label = `${caller.actor?.label ?? 'token'} (dry run)`;
      const accepted = await createDeploy(deps, caller, {
        kind: 'deploy',
        app,
        sha,
        dryRun: true,
        requester: { label, repo: row?.repo ?? 'unknown', branch: row?.defaultBranch ?? 'unknown' },
      });
      if (isRefusal(accepted)) return refused(accepted);

      const deadline = Date.now() + dryRunWait * 1000;
      let status: DeployStatus | null = await getDeployStatus(deps.db, accepted.deployId);
      while (status !== null && !isTerminal(status.state) && !signal.aborted) {
        const remaining = (deadline - Date.now()) / 1000;
        if (remaining <= 0) break;
        status = await waitForChange(deps, accepted.deployId, remaining, signal);
      }
      if (status === null) return refused(NO_SUCH_DEPLOY);
      const finished = isTerminal(status.state);
      return ok({
        deployId: accepted.deployId,
        finished,
        state: status.state,
        gates: status.gates,
        refusal: status.refusal,
        ...(finished
          ? {}
          : {
              message: `Still running after ${String(dryRunWait)} s. Call shipyard_deploy_status with this deployId and wait to follow it.`,
            }),
      });
    },
  );

  server.registerTool(
    'shipyard_deploy',
    {
      title: 'Deploy an app',
      description:
        'Requests a deploy of `app` at the full 40-character `sha` and returns { deployId, state } at once, without ' +
        'waiting for it to finish; follow it with shipyard_deploy_status. `requester` (repo, branch, label) is ' +
        'required and recorded; the label is shown to anyone this deploy locks out, so make it say who you are ' +
        '(e.g. "claude: <session>"). If another deploy holds the app, the call is refused at once naming the holder — ' +
        'Shipyard never queues. Pass `group` instead of `app` to deploy every member of a group at `sha`: every ' +
        'member is locked at once (or the call is refused naming the holder), the canary — if the group declares one — ' +
        'is deployed and soaked first, the rest follow in order with the canary\'s exact digests, and the first ' +
        'member that fails stops the group before the rest are touched.',
      inputSchema: toolInput(ShipyardDeployInput),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ app, group, sha, requester }) => {
      if ((app === undefined) === (group === undefined)) {
        return refused(refusal('invalid_request', 'Name exactly one of app or group.'));
      }
      const target = group !== undefined ? { group } : { app };
      const result = await createDeploy(deps, caller, { kind: 'deploy', ...target, sha, requester });
      return isRefusal(result) ? refused(result) : ok(result);
    },
  );

  server.registerTool(
    'shipyard_deploy_status',
    {
      title: 'Deploy status',
      description:
        "Returns a deploy's status: state, current step, requester, gate results and any refusal. Once it has " +
        'succeeded, also the SHA and digest of every image and the schema revision. With `wait` (seconds, at most ' +
        '90) it returns on the next state change or when the wait runs out, whichever is first; a finished deploy ' +
        'returns at once. Poll again with wait to keep following it. For a group deploy it returns { group, canary, ' +
        'state, members }, every member\'s status in deploy order.',
      inputSchema: toolInput(ShipyardDeployStatusInput),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ deployId, wait }) => {
      if (!UUID_RE.test(deployId)) return refused(NO_SUCH_DEPLOY);
      // Scope is checked before waiting, so an out-of-scope caller cannot hold a long poll open.
      const first = await getDeployStatus(deps.db, deployId);
      if (first === null) return refused(NO_SUCH_DEPLOY);
      const denied = outOfScope(caller, first.app);
      if (denied !== null) return refused(denied);
      const seconds = Math.min(wait ?? 0, MAX_WAIT_SECONDS);
      const group = await getGroupDeployStatus(deps.db, deployId);
      if (group !== null) {
        for (const member of group.members) {
          const memberDenied = outOfScope(caller, member.app);
          if (memberDenied !== null) return refused(memberDenied);
        }
        const groupStatus = seconds === 0 ? group : await waitForGroupChange(deps, deployId, seconds, signal);
        return groupStatus === null ? refused(NO_SUCH_DEPLOY) : ok(groupStatus);
      }
      const status = seconds === 0 ? first : await waitForChange(deps, deployId, seconds, signal);
      return status === null ? refused(NO_SUCH_DEPLOY) : ok(status);
    },
  );

  server.registerTool(
    'shipyard_rollback',
    {
      title: 'Roll back an app',
      description:
        'Requests a rollback of `app` to the images of `toDeployId`, an earlier successful deploy of the same app, ' +
        'and returns { deployId, state } at once; follow it with shipyard_deploy_status. Image-only: the database ' +
        'is not rolled back. `requester` (repo, branch, label) is required and recorded. Refused at once if another ' +
        'deploy holds the app.',
      inputSchema: toolInput(ShipyardRollbackInput),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ app, toDeployId, requester }) => {
      const denied = outOfScope(caller, app);
      if (denied !== null) return refused(denied);
      if (!UUID_RE.test(toDeployId)) {
        return refused(
          refusal('rollback_target_invalid', `Deploy ${toDeployId} is not an earlier successful deploy of ${app}.`),
        );
      }
      const result = await createDeploy(deps, caller, { kind: 'rollback', app, toDeployId, requester });
      return isRefusal(result) ? refused(result) : ok(result);
    },
  );

  return server;
}
