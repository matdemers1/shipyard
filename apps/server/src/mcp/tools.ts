import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ShipyardActionInput,
  ShipyardBuildInput,
  ShipyardBuildStatusInput,
  ShipyardDeployInput,
  ShipyardDeployStatusInput,
  ShipyardDryRunInput,
  ShipyardHostInput,
  ShipyardLogsInput,
  ShipyardRollbackInput,
  ShipyardStackUpdateInput,
  ShipyardStatusInput,
  refusal,
  type ActionStatus,
  type DeployStatus,
  type Refusal,
} from '@shipyard/schema';
import type { GitHubPort } from '@shipyard/sequence/github';
import { z } from 'zod';
import type { ServiceDeps } from '../deps.js';
import { getAction, isActionTerminal, requestAction, waitForAction } from '../actions/service.js';
import { enqueueBuild, getBuild, type BuildRequester } from '../builds/service.js';
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
import { readHostSnapshots, snapshotContainers } from '../host/index.js';
import { logsViewerOf, readLogsTail } from '../logs/service.js';
import { getStackUpdate, requestStackUpdate, waitForStackUpdate } from '../stack-updates/service.js';
import { appStatuses } from './status.js';

/**
 * The twelve MCP tools (SHP-REQ-041, SHP-REQ-144, SHP-REQ-179, SHP-REQ-184, SHP-REQ-193, SHP-REQ-199, SHP-REQ-200). Every tool is a
 * thin shell over the deploy, build, host, action or logs service: no deploy or build logic lives here, and no tool accepts a command,
 * a path or an image reference (SHP-REQ-053) — only app names, 40-hex SHAs, deploy/build IDs and who
 * is asking. `shipyard_host` takes nothing at all and is not scoped to an app: the host inventory
 * is the same read-only snapshot for any token (SHP-ADR-009, SHP-REQ-181). `shipyard_action` offers
 * start, restart and recreate and never stop — an API token cannot stop (SHP-ADR-010, SHP-REQ-188);
 * `shipyard_logs` returns a bounded, redacted tail and never follows (SHP-ADR-011, SHP-REQ-193).
 * `shipyard_stack_update` queues an update of an adopted, Operated stack to its reported candidates and
 * `shipyard_stack_update_status` reads it; the update is held for a deployer's approval in the console
 * when the stack's policy is `tokens` (the default) or `always` (SHP-ADR-010, SHP-REQ-199) and is kept
 * with its requester, digests before and after, and outcome (SHP-REQ-200).
 * Freeze, schedule, restore and approval are console-only (SHP-D-072).
 */

export interface McpOptions {
  /**
   * How long `shipyard_dry_run` waits for the agent to finish evaluating the gates before it
   * answers "still running". Under the 90 s cap (SHP-D-025); tests shorten it.
   */
  dryRunWaitSeconds?: number;
  /** Injected for tests; `shipyard_status` defaults to the real GitHub API (SHP-REQ-145). */
  github?: Pick<GitHubPort, 'compare'>;
}

export const DEFAULT_DRY_RUN_WAIT_SECONDS = 85;

/** How long `shipyard_action` waits for the agent's result before it answers "still running". */
export const ACTION_WAIT_MS = 60_000;
/** How long `shipyard_logs` waits for the agent to send the tail. */
export const LOGS_TAIL_WAIT_MS = 30_000;

/**
 * `shipyard_host` sends only the newest samples per container. The full series (up to 500 per
 * container) runs to megabytes on a busy host, more than an MCP client can read; the console's
 * `GET /api/host` keeps all of it for the sparklines.
 */
export const MCP_HOST_SAMPLES_PER_CONTAINER = 12;

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_GREEN_SHA_NOTE =
  'Whether CI passed for the newest commit on main is not reported: the Shipyard server does not track CI. ' +
  'The agent re-checks CI, main and the images in GHCR itself for every deploy; use shipyard_dry_run to check a SHA.';

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

const LOGS_NOT_ALLOWED = refusal(
  'forbidden',
  "This token can't read logs.",
  'Issue a token with logs allowed in Settings › Claude & tokens.',
);

/** A token's stack scope: only the adopted stacks it names. An app-scoped token reaches no stack (SHP-ADR-011). */
function stackOutOfScope(caller: DeployCaller, stack: string): Refusal | null {
  if (caller.tokenStacks?.has(stack) === true) return null;
  return refusal('forbidden', `This token is not scoped to ${stack}.`, `Use a token issued for ${stack}, or issue a new one that names it.`);
}

const NO_SUCH_STACK_UPDATE = refusal('not_found', 'No such stack update.', 'Use the update id that shipyard_stack_update returned.');

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
        'Read-only. For each app this token is scoped to (or just `app`): what is live (SHA, image digest per ' +
        'service, schema revision), open drift, who holds the deploy lock and at which step, ' +
        'the last finished result (succeeded, failed, rolled back or refused), `buildSource` (`shipyard` or ' +
        '`github`), and the commits waiting on the default branch ahead of live — each with ' +
        '`build: { state, buildId } | null`, the state of the latest Shipyard build of that SHA when this app is ' +
        '`build: shipyard` (queue one with shipyard_build). Whether CI passed for a waiting commit is not included: ' +
        'the server does not track CI, so use shipyard_dry_run to check a commit. Changes nothing.',
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
      const apps = await appStatuses(deps, names, options.github !== undefined ? { github: options.github } : {});
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
        'Asks the agent to run every deploy check (allowed, not frozen, no drift, not locked, CI passed, on the ' +
        'default branch, ahead of live, images in GHCR, env names present, no contract release since, approved, ' +
        'disk space) for `app` at `sha` without changing anything and without taking the lock. Waits up to ' +
        `${String(dryRunWait)} s, then returns each check with pass/fail and its reason; a check that fails is ` +
        'refused, with the fix. If the agent has not finished by then, returns the deployId with finished: false; ' +
        'follow up with shipyard_deploy_status. `sha` must be a full 40-character commit SHA.',
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
        'waiting for it to finish; a failed check refuses it before anything changes, and a deploy that fails its ' +
        'soak is rolled back to the previous release. Follow it with shipyard_deploy_status. `requester` (repo, branch, label) is ' +
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
        "Returns a deploy's status: state (waiting for approval, deploying, soaking, succeeded, failed, rolled " +
        'back or refused), current step, requester, the result of each check and any refusal. Once it has ' +
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
        'Rolls `app` back to the images of `toDeployId`, an earlier successful deploy of the same app, and ' +
        'returns { deployId, state } at once; follow it with shipyard_deploy_status. Image-only: the database ' +
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

  server.registerTool(
    'shipyard_build',
    {
      title: 'Build an app',
      description:
        'Queues a build of `app` at the full 40-character `sha`, only for an app whose manifest declares ' +
        '`build.source: shipyard` (its images come from Shipyard itself, not GitHub CI). Returns ' +
        '{ buildId, state, created } at once; follow it with shipyard_build_status. Idempotent: a second call for ' +
        'the same app and SHA while a build is still open (queued or running) returns that build\'s id with ' +
        'created: false rather than starting a second one. `requester` (repo, branch, label) is required and ' +
        'recorded. Only shipyard_deploy makes the result live — a build only produces images to deploy from.',
      inputSchema: toolInput(ShipyardBuildInput),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ app, sha, requester }) => {
      const denied = outOfScope(caller, app);
      if (denied !== null) return refused(denied);
      const actor = caller.actor ?? { type: 'system' as const, label: requester.label };
      const buildRequester: BuildRequester = {
        label: requester.label,
        ...(actor.type === 'user' && actor.id !== undefined ? { userId: actor.id } : {}),
        ...(actor.type === 'token' && actor.id !== undefined ? { tokenId: actor.id } : {}),
      };
      const result = await enqueueBuild(deps, { app, sha, trigger: 'mcp', requester: buildRequester }, { actor, audit: (event) => caller.audit(event) });
      if (isRefusal(result)) return refused(result);
      return ok({ ...result, message: 'Poll shipyard_build_status with this buildId to follow it.' });
    },
  );

  server.registerTool(
    'shipyard_build_status',
    {
      title: 'Build status',
      description:
        "Returns a build's status by `buildId`: state, each stage's state (fetch, test, integration, build, push), " +
        'the failed stage if any, any refusal verbatim, and the digest pushed for each service once it has ' +
        'succeeded. `deployable` is true once the build has succeeded and its images are ready — only then can ' +
        'shipyard_deploy use them. Changes nothing.',
      inputSchema: toolInput(ShipyardBuildStatusInput),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ buildId }) => {
      const build = await getBuild(deps.db, buildId);
      if (build === null) {
        return refused(refusal('not_found', 'No such build.', 'Use the buildId that shipyard_build returned.'));
      }
      const denied = outOfScope(caller, build.app);
      if (denied !== null) return refused(denied);
      return ok({ ...build, deployable: build.state === 'succeeded' });
    },
  );

  server.registerTool(
    'shipyard_host',
    {
      title: 'Host inventory',
      description:
        'Read-only. Everything Docker runs on the Shipyard host, per agent, as of `reportedAt` (when the agent ' +
        'last reported): every container with its tier — Shipped (a D3 app Shipyard deploys), Operated (a ' +
        'third-party stack adopted with a manifest) or Observed (seen only) — state, health, restarts, compose ' +
        'project, ports, mounts and sampled CPU/memory; volumes with size, who mounts them and orphans; images ' +
        'with size and use; Docker\'s build cache; free space on the data root and Docker root; and the last ' +
        String(MCP_HOST_SAMPLES_PER_CONTAINER) +
        ' CPU/memory samples per container. `hosts` is empty until an agent has reported an inventory. Takes no ' +
        'input and works for any token whatever apps it is scoped to. Changes nothing.',
      inputSchema: toolInput(ShipyardHostInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const { hosts } = await readHostSnapshots(deps.db, deps.logger);
      return ok({
        hosts: hosts.map((host) => ({
          ...host,
          samples: Object.fromEntries(Object.entries(host.samples).map(([name, series]) => [name, series.slice(-MCP_HOST_SAMPLES_PER_CONTAINER)])),
        })),
      });
    },
  );

  server.registerTool(
    'shipyard_action',
    {
      title: 'Start, restart or recreate',
      description:
        'Restart, recreate or start a Deployed app or an Operated stack (or one `service` of it), by `name`, and ' +
        'waits up to 60 s for the agent to finish. Returns { action, finished }: the action\'s id and state ' +
        '(queued, running, succeeded, failed or refused) with the refusal or output if any. If `finished` is ' +
        'false the agent has not answered yet — the action is still in flight and its final state is in Activity ' +
        'in the console; do not repeat the call. Stop is console-only: an API token can never stop a service. ' +
        'Observed containers can\'t be acted on. An app that is being deployed is Locked and the call is ' +
        'refused naming who holds it. `requester` (repo, branch, label) is required and recorded; the label ' +
        'shows in Activity (e.g. "claude: <session>"). The token must be scoped to `name` (an app, or an adopted stack it names).',
      inputSchema: toolInput(ShipyardActionInput),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, verb, service, requester }) => {
      // A token may be scoped to an adopted stack as well as to apps (SHP-ADR-011 amendment); the
      // service then checks the scope against the resolved kind.
      const denied = caller.tokenStacks?.has(name) === true ? null : outOfScope(caller, name);
      if (denied !== null) return refused(denied);
      // An app wins over an adopted stack of the same name; a name that is neither is passed on as
      // an app so the service says why (unknown_app, or not_adopted for an Observed project).
      const isApp = (await deps.db.app.findFirst({ where: { name, retiredAt: null }, select: { id: true } })) !== null;
      const isStack = !isApp && (await deps.db.stack.findFirst({ where: { name, retiredAt: null }, select: { id: true } })) !== null;
      const queued = await requestAction(deps, caller, {
        target: { kind: isStack ? 'stack' : 'app', name },
        verb,
        ...(service === undefined ? {} : { service }),
        requester,
      });
      if ('code' in queued) return refused(queued);
      const settled: ActionStatus = (await waitForAction(deps, queued.id, ACTION_WAIT_MS, signal)) ?? (await getAction(deps.db, queued.id)) ?? queued;
      const finished = isActionTerminal(settled.state);
      return ok({
        action: settled,
        finished,
        ...(finished
          ? {}
          : { message: 'Still in flight after 60 s. Its final state is in Activity in the console; do not repeat the call.' }),
      });
    },
  );

  server.registerTool(
    'shipyard_stack_update',
    {
      title: 'Update a stack',
      description:
        'Requests an update of `stack`, an adopted Operated stack whose manifest says it is updated by digest, to ' +
        'the newest images its track resolves to (the candidates the agent last reported); the agent re-checks each ' +
        'one when it runs. Returns { update, message } at once without waiting: an update from a token is usually ' +
        '`awaiting_approval` — a deployer must approve it in the console\'s Needs you, so do not poll for it; ' +
        'it is `queued` only when the stack\'s approval policy is never. An approved update backs up, pulls, swaps one ' +
        'service at a time, checks and soaks, and is rolled back to the previous images if it fails; the database ' +
        'is not rolled back. Refused at once for a stack adopted with updates: none, an app, an Observed ' +
        'project, a stack that is already being updated or has an action in flight, or an agent that cannot ' +
        'update stacks. `requester` (repo, branch, label) is required and recorded. The token must be scoped to ' +
        '`stack`. Follow it with shipyard_stack_update_status.',
      inputSchema: toolInput(ShipyardStackUpdateInput),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ stack, requester }) => {
      const denied = stackOutOfScope(caller, stack);
      if (denied !== null) return refused(denied);
      // No digests: the reported candidates (SHP-REQ-195). The service refuses what cannot be updated.
      const result = await requestStackUpdate(deps, caller, stack, { requester });
      if ('code' in result) return refused(result);
      const message =
        result.state === 'awaiting_approval'
          ? 'Held for approval: a deployer must approve it in the console (Needs you). Do not poll for it; follow it with shipyard_stack_update_status later.'
          : 'Queued for the agent. Follow it with shipyard_stack_update_status and wait.';
      return ok({ update: result, message });
    },
  );

  server.registerTool(
    'shipyard_stack_update_status',
    {
      title: 'Stack update status',
      description:
        "Returns a stack update's status by `updateId`: state (awaiting approval, queued, running, succeeded, failed, " +
        'rolled back, refused or denied), current step, requester, who approved it, the digests asked for, the ' +
        'images before and after, and any refusal verbatim. With `wait` (seconds, at most 90) it returns once the ' +
        'update has finished or the wait runs out, whichever is first; a finished update returns at once. An ' +
        'update awaiting approval does not change until a deployer decides in the console. The token must be ' +
        'scoped to the stack. Changes nothing.',
      // Mirrors shipyard_build_status: an id and an optional wait (the schema package owns no input for it).
      inputSchema: z.strictObject({ updateId: z.uuid(), wait: z.int().min(0).max(MAX_WAIT_SECONDS).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ updateId, wait }) => {
      if (!UUID_RE.test(updateId)) return refused(NO_SUCH_STACK_UPDATE);
      // Scope is checked before waiting, so an out-of-scope caller cannot hold a long poll open.
      const first = await getStackUpdate(deps.db, updateId);
      if (first === null) return refused(NO_SUCH_STACK_UPDATE);
      const denied = stackOutOfScope(caller, first.stack);
      if (denied !== null) return refused(denied);
      const seconds = Math.min(wait ?? 0, MAX_WAIT_SECONDS);
      const status = seconds === 0 ? first : await waitForStackUpdate(deps, updateId, seconds * 1000, signal);
      return status === null ? refused(NO_SUCH_STACK_UPDATE) : ok(status);
    },
  );

  server.registerTool(
    'shipyard_logs',
    {
      title: 'Container logs',
      description:
        'Read-only. The last `tail` lines (1 to 500, default 100) of one container\'s logs, by `container` — the ' +
        'name the Host view shows, or its full 64-character ID — redacted on the host and never stored. Returns ' +
        '{ container: { id, name }, lines: [{ at, stream, text }] } within 30 s. A token reads ' +
        'only the containers of the apps and adopted stacks it is scoped to (a Deployed app\'s containers or an ' +
        'Operated stack\'s), never an Observed one or another app\'s; the console is where an ' +
        'operator reads anything. Needs a token issued with logs allowed (Settings › Claude & tokens); a token ' +
        'without it is refused. A tail only: it never follows.',
      inputSchema: toolInput(ShipyardLogsInput),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ container, tail }) => {
      // Who may read comes before what exists, so a token that cannot read learns nothing about names.
      const viewer = await logsViewerOf(deps, caller);
      if ('code' in viewer) {
        return refused(caller.actor?.type === 'token' && viewer.message.startsWith('This token may not read') ? LOGS_NOT_ALLOWED : viewer);
      }
      const all = await snapshotContainers(deps.db);
      const found = CONTAINER_ID_RE.test(container)
        ? all.find((c) => c.container.id === container)
        : all.find((c) => c.container.name === container);
      if (found === undefined) {
        return refused(
          refusal('unknown_container', `The agent does not report a container ${container}.`, 'Use a name or ID from shipyard_host.'),
        );
      }
      const lines = await readLogsTail(deps, caller, { containerId: found.container.id, tail }, LOGS_TAIL_WAIT_MS);
      if (!Array.isArray(lines)) return refused(lines);
      return ok({
        container: { id: found.container.id, name: found.container.name },
        lines,
        note: 'Redacted on the host; never stored.',
      });
    },
  );

  return server;
}
