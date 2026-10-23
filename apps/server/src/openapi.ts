import { Router } from 'express';
import { z } from 'zod';
// Side-effect import: every shared schema calls `.meta({ id })` at module load, which registers
// it in `z.globalRegistry`. Without this import the registry below is empty.
import '@shipyard/schema';

/**
 * The OpenAPI document generated from `@shipyard/schema` (SHP-REQ-005, SHP-T-0.7). Every schema
 * tagged with a `.meta({ id })` in the shared package is rendered into `components.schemas` via
 * Zod 4's `z.toJSONSchema(z.globalRegistry, …)`, so the document and the runtime validators can
 * never drift apart.
 *
 * Paths below cover only what is mounted in `app.ts` today (`/health`, `/openapi.json`, the auth
 * routes). A route added later adds its path here in the same change — deploy/app/agent paths
 * join as those routers land.
 */

interface JsonSchemaObject {
  $schema?: unknown;
  $id?: unknown;
  [key: string]: unknown;
}

/** Strips the top-level `$schema`/`$id` keys `z.toJSONSchema` writes per-schema; the validator
 * used here (and most OpenAPI 3.1 tooling) rejects a component schema carrying its own `$schema`. */
function stripSchemaKeys(schema: JsonSchemaObject): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...schema };
  delete rest['$schema'];
  delete rest['$id'];
  return rest;
}

function buildComponentSchemas(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    uri: (id) => `#/components/schemas/${id}`,
    target: 'draft-2020-12',
  });

  const components: Record<string, unknown> = {};
  for (const [id, schema] of Object.entries(schemas)) {
    components[id] = stripSchemaKeys(schema);
  }
  return { ...components, ...BUILD_COMPONENT_SCHEMAS, ...STACK_COMPONENT_SCHEMAS, ...MAINTENANCE_COMPONENT_SCHEMAS };
}

const ERROR_RESPONSE = {
  description: 'A refusal: every non-2xx response is `{ error: { code, gate, message, fix } }`.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorEnvelope' },
    },
  },
};

/**
 * Response and request shapes of `/api/builds` (SHP-T-7.4). They are server views over the build
 * tables rather than shared-package contracts, so they are written here; their enums and
 * primitives reference the registry's `BuildState`, `BuildStage`, `BuildTrigger`, `AppName`,
 * `Sha40` and `Refusal`.
 */
const NULLABLE_DATE = { type: ['string', 'null'], format: 'date-time' };
const BUILD_COMPONENT_SCHEMAS: Record<string, unknown> = {
  BuildRequestBody: {
    type: 'object',
    description: 'Queue a Shipyard build of one SHA of one app (trigger manual).',
    properties: {
      app: { $ref: '#/components/schemas/AppName' },
      sha: { $ref: '#/components/schemas/Sha40' },
      requester: {
        type: 'object',
        properties: { label: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['label'],
        additionalProperties: false,
      },
    },
    required: ['app', 'sha'],
    additionalProperties: false,
  },
  BuildActionBody: {
    type: 'object',
    description: 'Optional body for rebuild and cancel.',
    properties: {
      requester: {
        type: 'object',
        properties: { label: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['label'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  BuildSummary: {
    type: 'object',
    properties: {
      buildId: { type: 'string', format: 'uuid' },
      app: { $ref: '#/components/schemas/AppName' },
      sha: { $ref: '#/components/schemas/Sha40' },
      state: { $ref: '#/components/schemas/BuildState' },
      trigger: { $ref: '#/components/schemas/BuildTrigger' },
      queueSeq: { type: 'string', description: 'Arrival order (a bigint, as a decimal string).' },
      requesterLabel: { type: 'string' },
      rebuildOfId: { type: ['string', 'null'], format: 'uuid' },
      failedStage: { oneOf: [{ $ref: '#/components/schemas/BuildStage' }, { type: 'null' }] },
      cancelRequestedAt: NULLABLE_DATE,
      dispatchedAt: NULLABLE_DATE,
      startedAt: NULLABLE_DATE,
      endedAt: NULLABLE_DATE,
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: [
      'buildId', 'app', 'sha', 'state', 'trigger', 'queueSeq', 'requesterLabel', 'rebuildOfId', 'failedStage',
      'cancelRequestedAt', 'dispatchedAt', 'startedAt', 'endedAt', 'createdAt',
    ],
  },
  BuildStageView: {
    type: 'object',
    properties: {
      stage: { $ref: '#/components/schemas/BuildStage' },
      state: { type: 'string', enum: ['running', 'succeeded', 'failed', 'skipped'] },
      startedAt: { type: 'string', format: 'date-time' },
      endedAt: NULLABLE_DATE,
    },
    required: ['stage', 'state', 'startedAt', 'endedAt'],
    additionalProperties: false,
  },
  BuildDetail: {
    allOf: [
      { $ref: '#/components/schemas/BuildSummary' },
      {
        type: 'object',
        properties: {
          digests: { type: 'object', additionalProperties: { type: 'string' } },
          refusal: { oneOf: [{ $ref: '#/components/schemas/Refusal' }, { type: 'null' }] },
          stages: { type: 'array', items: { $ref: '#/components/schemas/BuildStageView' } },
        },
        required: ['digests', 'refusal', 'stages'],
      },
    ],
  },
  BuildPage: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/BuildSummary' } },
      nextCursor: { type: ['string', 'null'] },
    },
    required: ['items', 'nextCursor'],
    additionalProperties: false,
  },
  BuildLogs: {
    type: 'object',
    properties: {
      logs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            stage: { $ref: '#/components/schemas/BuildStage' },
            chunk: { type: 'string' },
            at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'stage', 'chunk', 'at'],
          additionalProperties: false,
        },
      },
    },
    required: ['logs'],
    additionalProperties: false,
  },
  BuildEnqueued: {
    type: 'object',
    properties: {
      buildId: { type: 'string', format: 'uuid' },
      state: { $ref: '#/components/schemas/BuildState' },
      created: { type: 'boolean', description: 'False when an open build of this app and SHA already existed.' },
    },
    required: ['buildId', 'state', 'created'],
    additionalProperties: false,
  },
  BuildCancelled: {
    type: 'object',
    properties: {
      buildId: { type: 'string', format: 'uuid' },
      state: { $ref: '#/components/schemas/BuildState' },
      cancelRequested: { type: 'boolean', description: 'True when the build was running and stops at its next stage boundary.' },
    },
    required: ['buildId', 'state', 'cancelRequested'],
    additionalProperties: false,
  },
};

const BUILD_ID_PARAM = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

function jsonResponse(description: string, ref: string): Record<string, unknown> {
  return { description, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } };
}

/**
 * Server views over the stack mirror and stack updates (SHP-T-16.3): `GET /api/stacks` and the
 * Needs you read. Their parts reference the registry's `StackTrack`, `Digest` and `StackUpdateStatus`.
 */
const STACK_COMPONENT_SCHEMAS: Record<string, unknown> = {
  StackView: {
    type: 'object',
    description: 'An adopted stack with its tracked services, their running digests and update candidates',
    properties: {
      name: { $ref: '#/components/schemas/AppName' },
      composeProject: { type: 'string' },
      updates: { type: 'string', enum: ['none', 'digest'] },
      approval: { type: ['string', 'null'], enum: ['tokens', 'always', 'never', null] },
      soakSeconds: { type: ['integer', 'null'] },
      services: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            service: { type: 'string' },
            image: { type: 'string' },
            track: { $ref: '#/components/schemas/StackTrack' },
            running: { anyOf: [{ $ref: '#/components/schemas/Digest' }, { type: 'null' }] },
            candidate: {
              anyOf: [
                { type: 'object', properties: { tag: { type: 'string' }, digest: { $ref: '#/components/schemas/Digest' } }, required: ['tag', 'digest'] },
                { type: 'null' },
              ],
            },
            checkedAt: NULLABLE_DATE,
            error: { type: ['string', 'null'] },
          },
          required: ['service', 'image', 'track', 'running', 'candidate', 'checkedAt', 'error'],
        },
      },
      reportedAt: { type: 'string', format: 'date-time' },
      activeUpdate: { anyOf: [{ $ref: '#/components/schemas/StackUpdateStatus' }, { type: 'null' }] },
      lastUpdate: { anyOf: [{ $ref: '#/components/schemas/StackUpdateStatus' }, { type: 'null' }] },
    },
    required: ['name', 'composeProject', 'updates', 'approval', 'soakSeconds', 'services', 'reportedAt', 'activeUpdate', 'lastUpdate'],
  },
  StackList: {
    type: 'object',
    description: 'Every adopted stack (a token: only those its scope names)',
    properties: { stacks: { type: 'array', items: { $ref: '#/components/schemas/StackView' } } },
    required: ['stacks'],
  },
  StackNeedsYou: {
    type: 'object',
    description: "Stack updates held for approval (oldest first), and each stack's newest failed or rolled-back update until a later one succeeds",
    properties: {
      approvals: { type: 'array', items: { $ref: '#/components/schemas/StackUpdateStatus' } },
      failed: { type: 'array', items: { $ref: '#/components/schemas/StackUpdateStatus' } },
    },
    required: ['approvals', 'failed'],
  },
};

/**
 * Server views over volume maintenance (SHP-T-17.3, SHP-ADR-012): a volume's archive list and the
 * Needs you read. Their parts reference the registry's `VolumeArchive` and `MaintenanceStatus`.
 */
const MAINTENANCE_COMPONENT_SCHEMAS: Record<string, unknown> = {
  VolumeArchiveList: {
    type: 'object',
    description: "A volume's unretired archives in the agent ledger, newest first (a token: only its owners')",
    properties: { archives: { type: 'array', items: { $ref: '#/components/schemas/VolumeArchive' } } },
    required: ['archives'],
  },
  MaintenanceNeedsYou: {
    type: 'object',
    description: "Each volume's latest finished backup when it failed or was refused, and every filesystem at least 90% full",
    properties: {
      failedBackups: { type: 'array', items: { $ref: '#/components/schemas/MaintenanceStatus' } },
      lowDisk: {
        type: 'array',
        items: {
          type: 'object',
          properties: { mount: { type: 'string' }, usedPercent: { type: 'number' }, freeBytes: { type: 'integer', minimum: 0 } },
          required: ['mount', 'usedPercent', 'freeBytes'],
        },
      },
    },
    required: ['failedBackups', 'lowDisk'],
  },
};

function buildPathsForBuilds(): Record<string, unknown> {
  const actionBody = {
    required: false,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildActionBody' } } },
  };
  return {
    '/builds': {
      get: {
        summary: 'List builds, newest first (a token sees only its apps)',
        operationId: 'listBuilds',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [
          { name: 'app', in: 'query', required: false, schema: { $ref: '#/components/schemas/AppName' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': jsonResponse('One page of builds.', 'BuildPage'), '4XX': ERROR_RESPONSE },
      },
      post: {
        summary: 'Queue a build of one SHA (deployer and up); an open build of that SHA is returned instead',
        operationId: 'postBuild',
        security: [{ session: [] }, { bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildRequestBody' } } } },
        responses: {
          '201': jsonResponse('Queued; it runs after every build that arrived before it.', 'BuildEnqueued'),
          '200': jsonResponse('An open build of this app and SHA already existed.', 'BuildEnqueued'),
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/builds/{id}': {
      get: {
        summary: 'One build with its stages',
        operationId: 'getBuild',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [BUILD_ID_PARAM],
        responses: { '200': jsonResponse('The build.', 'BuildDetail'), '4XX': ERROR_RESPONSE },
      },
    },
    '/builds/{id}/logs': {
      get: {
        summary: "A build's log chunks, oldest first (kept 30 days after it ends)",
        operationId: 'getBuildLogs',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [BUILD_ID_PARAM, { name: 'after', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': jsonResponse('The log chunks after `after`.', 'BuildLogs'), '4XX': ERROR_RESPONSE },
      },
    },
    '/builds/{id}/events': {
      get: {
        summary: 'Live build progress as Server-Sent Events: build, logs, end',
        operationId: 'getBuildEvents',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [BUILD_ID_PARAM],
        responses: {
          '200': { description: 'An event stream; closes after `end` on a terminal state.', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/builds/{id}/rebuild': {
      post: {
        summary: 'Queue a new build of the same SHA (deployer and up)',
        operationId: 'postBuildRebuild',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [BUILD_ID_PARAM],
        requestBody: actionBody,
        responses: {
          '201': jsonResponse('Queued. 409 when a build of that SHA is still open.', 'BuildEnqueued'),
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/builds/{id}/cancel': {
      post: {
        summary: 'Cancel a build: at once when queued, at its next stage boundary when running (deployer and up)',
        operationId: 'postBuildCancel',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [BUILD_ID_PARAM],
        requestBody: actionBody,
        responses: {
          '200': jsonResponse('Cancelled, or cancel requested. 409 when the build has already ended.', 'BuildCancelled'),
          '4XX': ERROR_RESPONSE,
        },
      },
    },
  };
}

/** "Roll all" (SHP-T-12.1): the responses are plain types in `@shipyard/schema/rollouts`. */
function buildPathsForRollouts(): Record<string, unknown> {
  const body = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RolloutRequest' } } } };
  const plain = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
  return {
    '/rollouts/plan': {
      post: {
        summary: 'What a rollout of these apps would ship, in order (Shipyard last), or the refusal it would get now; writes nothing',
        operationId: 'planRollout',
        security: [{ session: [] }, { bearer: [] }],
        requestBody: body,
        responses: { '200': plain('The plan: { members: [{ app, sha, liveSha, self }] } in rollout order.'), '4XX': ERROR_RESPONSE },
      },
    },
    '/rollouts': {
      post: {
        summary: 'Roll several apps one at a time, each at its own SHA; every lock is taken at once and the first failure stops the rest',
        operationId: 'postRollout',
        security: [{ session: [] }, { bearer: [] }],
        requestBody: body,
        responses: { '201': plain('Accepted: { rolloutId, deployIds } in rollout order.'), '4XX': ERROR_RESPONSE },
      },
    },
    '/rollouts/{id}': {
      get: {
        summary: "A rollout with every member's deploy status, in order; ?wait= holds until one changes (at most 90 s)",
        operationId: 'getRollout',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'wait', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 90 } },
        ],
        responses: { '200': plain('The rollout status.'), '4XX': ERROR_RESPONSE },
      },
    },
  };
}

/**
 * Lifecycle actions and container logs (SHP-T-15.4; SHP-ADR-010, SHP-ADR-011): the console/token
 * routes, and the agent's signed routes that feed them.
 */
export function buildPathsForActionsAndLogs(): Record<string, unknown> {
  const uuidParam = (description: string) => ({ name: 'id', in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });
  const body = (ref: string) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
  // The agent signs every request (SHP-D-064): these headers, not a session or bearer token.
  const signed = {
    security: [],
    parameters: ['x-shipyard-key', 'x-shipyard-timestamp', 'x-shipyard-nonce', 'x-shipyard-signature'].map((name) => ({
      name,
      in: 'header',
      required: true,
      schema: { type: 'string' },
    })),
  };
  return {
    '/actions': {
      get: {
        summary: 'Lifecycle actions, newest first (any signed-in role; a token sees only its apps) — an Activity source',
        operationId: 'listActions',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': jsonResponse('One page of actions.', 'ActionPage'), '4XX': ERROR_RESPONSE },
      },
      post: {
        summary:
          'Start, stop, restart or recreate a Deployed app or Operated stack, or one service (deployer and up; a token may not stop). Refused for an Observed container, an unknown target, an app whose deploy holds the lock, or an agent that cannot',
        operationId: 'postAction',
        security: [{ session: [] }, { bearer: [] }],
        requestBody: body('ActionRequest'),
        responses: { '202': jsonResponse('Queued for the agent.', 'ActionStatus'), '4XX': ERROR_RESPONSE, '5XX': ERROR_RESPONSE },
      },
    },
    '/actions/{id}': {
      get: {
        summary: 'One lifecycle action and its outcome',
        operationId: 'getAction',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [uuidParam('The action ID')],
        responses: { '200': jsonResponse('The action.', 'ActionStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/logs': {
      post: {
        summary: "Open a bounded read of one container's logs: a tail of at most 2000 lines, following for at most five minutes (admin or operator; a token with can_read_logs). Audited; never stored",
        operationId: 'postLogs',
        security: [{ session: [] }, { bearer: [] }],
        requestBody: body('LogsRequest'),
        responses: { '201': jsonResponse('The session; attach to its stream.', 'LogsSession'), '4XX': ERROR_RESPONSE, '5XX': ERROR_RESPONSE },
      },
    },
    '/logs/{id}/stream': {
      get: {
        summary: 'The session\'s lines as Server-Sent Events: `lines` ({ seq, lines }) in order, then `end` ({ reason, error? }). Only the viewer who opened it; leaving ends it',
        operationId: 'getLogsStream',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [uuidParam('The log session ID')],
        responses: {
          '200': { description: 'An event stream; closes after `end`.', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/logs/{id}': {
      delete: {
        summary: 'Stop a log session; the agent is told to stop on its next chunk',
        operationId: 'deleteLogs',
        security: [{ session: [] }, { bearer: [] }],
        parameters: [uuidParam('The log session ID')],
        responses: { '204': { description: 'Stopped.' }, '4XX': ERROR_RESPONSE },
      },
    },
    '/agent/actions/{id}/progress': {
      post: {
        summary: 'Agent: a dispatched lifecycle action has started on the host',
        operationId: 'postAgentActionProgress',
        ...signed,
        parameters: [...signed.parameters, uuidParam('The action ID')],
        requestBody: body('ActionProgress'),
        responses: { '200': jsonResponse('The action, now running.', 'ActionStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/agent/actions/{id}/result': {
      post: {
        summary: "Agent: a lifecycle action's terminal result, once, for an action dispatched to this agent",
        operationId: 'postAgentActionResult',
        ...signed,
        parameters: [...signed.parameters, uuidParam('The action ID')],
        requestBody: body('ActionResult'),
        responses: { '200': jsonResponse('The action, ended.', 'ActionStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/agent/logs/{id}/chunks': {
      post: {
        summary: 'Agent: one ordered batch of redacted log lines (body up to 2 MB), relayed to the viewer and dropped; continue is false once the viewer has gone',
        operationId: 'postAgentLogsChunk',
        ...signed,
        parameters: [...signed.parameters, uuidParam('The log session ID')],
        requestBody: body('LogsChunk'),
        responses: { '200': jsonResponse('Whether to keep streaming.', 'LogsChunkAck'), '413': ERROR_RESPONSE, '4XX': ERROR_RESPONSE },
      },
    },
  };
}

/**
 * Stack updates by digest (SHP-T-16.3; SHP-ADR-010, SHP-REQ-195, SHP-REQ-199, SHP-REQ-200): the
 * console/token routes, and the agent's signed routes that feed them.
 */
export function buildPathsForStackUpdates(): Record<string, unknown> {
  const auth = { security: [{ session: [] }, { bearer: [] }] };
  const nameParam = { name: 'name', in: 'path', required: true, description: 'The adopted stack', schema: { $ref: '#/components/schemas/AppName' } };
  const uuidParam = (description: string) => ({ name: 'id', in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });
  const pageParams = [
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
    { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
  ];
  const body = (ref: string) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
  const signedHeaders = ['x-shipyard-key', 'x-shipyard-timestamp', 'x-shipyard-nonce', 'x-shipyard-signature'].map((name) => ({
    name,
    in: 'header',
    required: true,
    schema: { type: 'string' },
  }));
  return {
    '/stacks': {
      get: {
        summary: 'Every adopted stack with its tracked services, running digests and update candidates (any signed-in role; a token sees only its stacks)',
        operationId: 'listStacks',
        ...auth,
        responses: { '200': jsonResponse('The stacks.', 'StackList'), '4XX': ERROR_RESPONSE },
      },
    },
    '/stacks/{name}/updates': {
      get: {
        summary: "One stack's updates and rollbacks, newest first: who asked, the digests before and after, and the outcome",
        operationId: 'listStackHistory',
        ...auth,
        parameters: [nameParam, ...pageParams],
        responses: { '200': jsonResponse('One page of the history.', 'StackUpdatePage'), '4XX': ERROR_RESPONSE },
      },
      post: {
        summary:
          "Update an updates: digest stack to the candidates the agent reported, or to the digests named for tracked services (deployer and up; a token only within its scope). Held for a deployer's approval by the stack's policy (tokens by default); refused for updates: none, a stack another update or an action holds, or an agent that cannot",
        operationId: 'postStackUpdate',
        ...auth,
        parameters: [nameParam],
        requestBody: body('StackUpdateRequest'),
        responses: { '202': jsonResponse('Queued, or awaiting approval.', 'StackUpdateStatus'), '4XX': ERROR_RESPONSE, '5XX': ERROR_RESPONSE },
      },
    },
    '/stacks/{name}/rollback': {
      post: {
        summary:
          "Roll a stack back to an earlier succeeded update; the agent takes its digests from its own ledger. The same roles, scope, lock and approval policy as an update; a native session needs step-up",
        operationId: 'postStackRollback',
        ...auth,
        parameters: [nameParam],
        requestBody: body('StackRollbackRequest'),
        responses: { '202': jsonResponse('Queued, or awaiting approval.', 'StackUpdateStatus'), '4XX': ERROR_RESPONSE, '5XX': ERROR_RESPONSE },
      },
    },
    '/stack-updates': {
      get: {
        summary: 'Every stack update and rollback, newest first (a token sees only its stacks) — an Activity source',
        operationId: 'listStackUpdates',
        ...auth,
        parameters: pageParams,
        responses: { '200': jsonResponse('One page of stack updates.', 'StackUpdatePage'), '4XX': ERROR_RESPONSE },
      },
    },
    '/stack-updates/needs-you': {
      get: {
        summary: "What needs a person: held stack updates, and each stack's failed or rolled-back update until a later one succeeds (console users)",
        operationId: 'getStackNeedsYou',
        security: [{ session: [] }],
        responses: { '200': jsonResponse('Held and failed stack updates.', 'StackNeedsYou'), '4XX': ERROR_RESPONSE },
      },
    },
    '/stack-updates/{id}': {
      get: {
        summary: 'One stack update or rollback and its outcome',
        operationId: 'getStackUpdate',
        ...auth,
        parameters: [uuidParam('The stack update ID')],
        responses: { '200': jsonResponse('The stack update.', 'StackUpdateStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/stack-updates/{id}/approve': {
      post: {
        summary: 'Approve a held stack update (deployer and up, console only; a native session needs step-up); it is queued for the agent',
        operationId: 'approveStackUpdate',
        security: [{ session: [] }],
        parameters: [uuidParam('The stack update ID')],
        responses: { '200': jsonResponse('Approved and queued.', 'StackUpdateStatus'), '4XX': ERROR_RESPONSE, '5XX': ERROR_RESPONSE },
      },
    },
    '/stack-updates/{id}/deny': {
      post: {
        summary: 'Deny a held stack update (deployer and up, console only; a native session needs step-up)',
        operationId: 'denyStackUpdate',
        security: [{ session: [] }],
        parameters: [uuidParam('The stack update ID')],
        responses: { '200': jsonResponse('Denied.', 'StackUpdateStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/agent/stack-updates/{id}/progress': {
      post: {
        summary: 'Agent: a dispatched stack update moved to a new step',
        operationId: 'postAgentStackUpdateProgress',
        security: [],
        parameters: [...signedHeaders, uuidParam('The stack update ID')],
        requestBody: body('StackUpdateProgress'),
        responses: { '200': jsonResponse('The stack update, now running.', 'StackUpdateStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/agent/stack-updates/{id}/result': {
      post: {
        summary: "Agent: a stack update's terminal result with the images before and after, once, for an update dispatched to this agent",
        operationId: 'postAgentStackUpdateResult',
        security: [],
        parameters: [...signedHeaders, uuidParam('The stack update ID')],
        requestBody: body('StackUpdateResult'),
        responses: { '200': jsonResponse('The stack update, ended.', 'StackUpdateStatus'), '4XX': ERROR_RESPONSE },
      },
    },
  };
}

/**
 * Volume backups, restores and deletes, and prune (SHP-T-17.3; SHP-ADR-012, SHP-REQ-201..205): the
 * console/token routes, and the agent's signed routes that feed them.
 */
export function buildPathsForMaintenance(): Record<string, unknown> {
  const auth = { security: [{ session: [] }, { bearer: [] }] };
  const sessionOnly = { security: [{ session: [] }] };
  const volumeParam = { name: 'volume', in: 'path', required: true, description: 'A Docker named volume', schema: { $ref: '#/components/schemas/VolumeName' } };
  const uuidParam = (description: string) => ({ name: 'id', in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });
  const body = (ref: string) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
  const signedHeaders = ['x-shipyard-key', 'x-shipyard-timestamp', 'x-shipyard-nonce', 'x-shipyard-signature'].map((name) => ({
    name,
    in: 'header',
    required: true,
    schema: { type: 'string' },
  }));
  const queued = { '202': jsonResponse('Queued for the agent.', 'MaintenanceStatus'), '4XX': ERROR_RESPONSE, '5XX': ERROR_RESPONSE };
  const deleteOp = (operationId: string) => ({
    summary:
      'Delete an orphan volume (admin, console only — never an API token; a step-up from the last ten minutes for console and native sessions alike; the name typed back). The agent re-checks nothing mounts it',
    operationId,
    ...sessionOnly,
    parameters: [volumeParam],
    requestBody: body('VolumeDeleteRequest'),
    responses: queued,
  });
  return {
    '/volumes/{volume}/backup': {
      post: {
        summary: 'Back up a volume an app or adopted stack owns (deployer and up; a token only within the owner\'s scope); quiesced when its manifest says so',
        operationId: 'postVolumeBackup',
        ...auth,
        parameters: [volumeParam],
        requestBody: body('VolumeBackupRequest'),
        responses: queued,
      },
    },
    '/volumes/{volume}/restore': {
      post: {
        summary:
          "Restore a volume from an archive in the agent's own ledger (admin, console only — never an API token; a step-up from the last ten minutes; the name typed back; refused while the owner is deploying, updating or acting)",
        operationId: 'postVolumeRestore',
        ...sessionOnly,
        parameters: [volumeParam],
        requestBody: body('VolumeRestoreRequest'),
        responses: queued,
      },
    },
    '/volumes/{volume}/delete': { post: deleteOp('postVolumeDelete') },
    '/volumes/{volume}': { delete: deleteOp('deleteVolume') },
    '/volumes/{volume}/archives': {
      get: {
        summary: "A volume's unretired archives, newest first",
        operationId: 'listVolumeArchives',
        ...auth,
        parameters: [volumeParam],
        responses: { '200': jsonResponse('The archives.', 'VolumeArchiveList'), '4XX': ERROR_RESPONSE },
      },
    },
    '/prune': {
      post: {
        summary:
          'Dry-run a prune of dangling and old unused images and old build cache, or prune what a succeeded dry run of the same host from the last hour listed (deployer and up, any token)',
        operationId: 'postPrune',
        ...auth,
        requestBody: body('PruneRequest'),
        responses: queued,
      },
    },
    '/maintenance': {
      get: {
        summary: 'Every volume backup, restore and delete and every prune, newest first (a token sees its owners\' jobs and prunes)',
        operationId: 'listMaintenance',
        ...auth,
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': jsonResponse('One page of maintenance jobs.', 'MaintenancePage'), '4XX': ERROR_RESPONSE },
      },
    },
    '/maintenance/needs-you': {
      get: {
        summary: "What needs a person: each volume's failed latest backup, and filesystems at least 90% full (console users)",
        operationId: 'getMaintenanceNeedsYou',
        ...auth,
        responses: { '200': jsonResponse('Failed backups and low disk.', 'MaintenanceNeedsYou'), '4XX': ERROR_RESPONSE },
      },
    },
    '/maintenance/{id}': {
      get: {
        summary: 'One maintenance job and its outcome; `wait` holds the answer up to 90 s until it ends',
        operationId: 'getMaintenance',
        ...auth,
        parameters: [uuidParam('The maintenance job ID'), { name: 'wait', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 90 } }],
        responses: { '200': jsonResponse('The maintenance job.', 'MaintenanceStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/agent/maintenance/{id}/progress': {
      post: {
        summary: 'Agent: a dispatched maintenance job moved to a new step',
        operationId: 'postAgentMaintenanceProgress',
        security: [],
        parameters: [...signedHeaders, uuidParam('The maintenance job ID')],
        requestBody: body('MaintenanceProgress'),
        responses: { '200': jsonResponse('The job, now running.', 'MaintenanceStatus'), '4XX': ERROR_RESPONSE },
      },
    },
    '/agent/maintenance/{id}/result': {
      post: {
        summary: "Agent: a maintenance job's terminal result, once, for a job dispatched to this agent",
        operationId: 'postAgentMaintenanceResult',
        security: [],
        parameters: [...signedHeaders, uuidParam('The maintenance job ID')],
        requestBody: body('MaintenanceResult'),
        responses: { '200': jsonResponse('The job, ended.', 'MaintenanceStatus'), '4XX': ERROR_RESPONSE },
      },
    },
  };
}

function buildPaths(): Record<string, unknown> {
  return {
    ...buildPathsForMaintenance(),
    ...buildPathsForStackUpdates(),
    ...buildPathsForBuilds(),
    ...buildPathsForRollouts(),
    ...buildPathsForActionsAndLogs(),
    '/host': {
      get: {
        summary: "Every agent's latest host inventory with recent container samples (any signed-in role, any token); read-only",
        operationId: 'getHost',
        security: [{ session: [] }, { bearer: [] }],
        responses: { '200': jsonResponse('One snapshot per agent that has reported an inventory; empty until one has.', 'HostResponse'), '4XX': ERROR_RESPONSE },
      },
    },
    '/health': {
      get: {
        summary: 'Health check',
        operationId: 'getHealth',
        security: [],
        responses: {
          '200': {
            description: 'The server and its schema revision are reachable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'This document',
        operationId: 'getOpenApiDocument',
        security: [],
        responses: {
          '200': {
            description: 'The OpenAPI 3.1 document for this API.',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Start app-native login with email and password',
        operationId: 'postAuthLogin',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Credentials accepted; a TOTP code is required to finish signing in.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { next: { type: 'string', const: 'totp' } },
                  required: ['next'],
                  additionalProperties: false,
                },
              },
            },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/auth/totp': {
      post: {
        summary: 'Complete login with a TOTP code',
        operationId: 'postAuthTotp',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TotpRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Login complete; a session is established.' },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'End the current session',
        operationId: 'postAuthLogout',
        security: [{ session: [] }],
        responses: {
          '200': {
            description: 'Session ended.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean', const: true } },
                  required: ['ok'],
                },
              },
            },
          },
          '401': ERROR_RESPONSE,
        },
      },
    },
    '/auth/me': {
      get: {
        summary: 'The current authenticated actor',
        operationId: 'getAuthMe',
        security: [{ session: [] }, { bearer: [] }],
        responses: {
          '200': {
            description: 'The signed-in user.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    displayName: { type: 'string' },
                    role: { type: 'string' },
                    identities: { type: 'array', items: { type: 'object' } },
                  },
                  required: ['id', 'email', 'displayName', 'role', 'identities'],
                  additionalProperties: false,
                },
              },
            },
          },
          '401': ERROR_RESPONSE,
        },
      },
    },
    '/setup': {
      get: {
        summary: 'Whether first-run setup is open (only while no account exists)',
        operationId: 'getSetup',
        security: [],
        responses: {
          '200': {
            description: 'available is true only while the server has no account at all.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SetupStatus' } } },
          },
        },
      },
    },
    '/setup/start': {
      post: {
        summary: 'Begin creating the first admin: details, then an authenticator to enrol',
        operationId: 'postSetupStart',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SetupStartRequest' } } },
        },
        responses: {
          '200': {
            description: 'Nothing is written yet; the ticket finishes setup within ten minutes.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SetupStarted' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/setup/complete': {
      post: {
        summary: 'Finish first-run setup with a code from the new authenticator',
        operationId: 'postSetupComplete',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SetupCompleteRequest' } } },
        },
        responses: {
          '201': { description: 'The first admin exists and is signed in; a session is established.' },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/settings/d3auth': {
      get: {
        summary: 'Sign in with D3 Auth as configured (admin only; never the client secret)',
        operationId: 'getSettingsD3Auth',
        responses: {
          '200': {
            description: 'Where it is configured, whether it is live, the redirect URI and the app manifest.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/D3AuthSettings' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
      put: {
        summary: 'Save the D3 Auth issuer, client ID and client secret; takes effect without a restart',
        operationId: 'putSettingsD3Auth',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/D3AuthSettingsUpdate' } } },
        },
        responses: {
          '200': {
            description: 'Saved and applied. 409 when server.env sets D3AUTH_* (env wins).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/D3AuthSettings' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
      delete: {
        summary: 'Clear the D3 Auth setting: the D3 Auth button turns off',
        operationId: 'deleteSettingsD3Auth',
        responses: {
          '200': {
            description: 'Cleared. 409 when server.env sets D3AUTH_* (env wins).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/D3AuthSettings' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/settings/d3auth/test': {
      post: {
        summary: "Fetch an issuer's OpenID discovery document and report what it says",
        operationId: 'postSettingsD3AuthTest',
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/D3AuthTestRequest' } } },
        },
        responses: {
          '200': {
            description: 'The result, reachable or not.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/D3AuthTestResult' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/settings/mail': {
      get: {
        summary: 'Alert email as configured (admin only; never the relay token)',
        operationId: 'getSettingsMail',
        responses: {
          '200': {
            description: 'Where it is configured (server.env, Settings or nowhere), the relay, recipient and whether it would send.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MailSettings' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
      put: {
        summary: 'Save the mail relay URL, its token and the alert recipient; applies to the next alert without a restart',
        operationId: 'putSettingsMail',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MailSettingsUpdate' } } },
        },
        responses: {
          '200': {
            description: 'Saved. 409 when server.env sets MAIL_RELAY_URL, MAIL_RELAY_TOKEN or ALERT_TO (env wins).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MailSettings' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
      delete: {
        summary: 'Clear the alert email setting: alerts are no longer emailed',
        operationId: 'deleteSettingsMail',
        responses: {
          '200': {
            description: 'Cleared. 409 when server.env owns it (env wins).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MailSettings' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/settings/mail/test': {
      post: {
        summary: 'Send one test message through the relay in effect and report its answer',
        operationId: 'postSettingsMailTest',
        responses: {
          '200': {
            description: "The relay's answer, sent or not. 409 when alert email is not configured.",
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MailTestResult' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/settings/github': {
      get: {
        summary: "The server's GitHub access and GitHub's current rate limit — never the token",
        operationId: 'getSettingsGitHub',
        responses: {
          '200': { description: 'GitHub access.', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitHubSettings' } } } },
          '4XX': ERROR_RESPONSE,
        },
      },
      put: {
        summary: "Save the server's (write-only) GitHub token; used on the next call, no restart",
        operationId: 'putSettingsGitHub',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GitHubSettingsUpdate' } } },
        },
        responses: {
          '200': { description: 'Saved.', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitHubSettings' } } } },
          '4XX': ERROR_RESPONSE,
        },
      },
      delete: {
        summary: 'Clear the stored GitHub token; GitHub is then called anonymously',
        operationId: 'deleteSettingsGitHub',
        responses: {
          '200': { description: 'Cleared.', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitHubSettings' } } } },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/settings/github/test': {
      post: {
        summary: 'Ask GitHub for its rate limit with a token (or the one in use) and report its answer',
        operationId: 'postSettingsGitHubTest',
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GitHubTestRequest' } } },
        },
        responses: {
          '200': {
            description: "GitHub's answer, accepted or not.",
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GitHubTestResult' } } },
          },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
    '/auth/oidc/start': {
      get: {
        summary: 'Begin Sign in with D3 Auth',
        operationId: 'getAuthOidcStart',
        security: [],
        responses: {
          '302': { description: 'Redirects to D3 Auth.' },
        },
      },
    },
    '/auth/oidc/callback': {
      get: {
        summary: 'Complete Sign in with D3 Auth',
        operationId: 'getAuthOidcCallback',
        security: [],
        responses: {
          '302': { description: 'Redirects back into the app with a session established.' },
          '4XX': ERROR_RESPONSE,
        },
      },
    },
  };
}

let cachedDocument: object | undefined;

/**
 * Builds (and caches) the OpenAPI 3.1 document for the API. Pure — no request state — so the test
 * suite and the route below share one build.
 */
export function buildOpenApiDocument(): object {
  cachedDocument ??= {
    openapi: '3.1.0',
    info: {
      title: 'Shipyard',
      version: process.env['SHIPYARD_VERSION'] ?? 'dev',
    },
    servers: [{ url: '/api' }],
    paths: buildPaths(),
    components: {
      schemas: buildComponentSchemas(),
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'shipyard_session',
        },
        bearer: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
  };
  return cachedDocument;
}

/** Mounted at `/api`; serves `GET /api/openapi.json` (SHP-REQ-005). */
export function openapiRouter(): Router {
  const router = Router();

  router.get('/openapi.json', (_req, res) => {
    res.status(200).json(buildOpenApiDocument());
  });

  return router;
}
