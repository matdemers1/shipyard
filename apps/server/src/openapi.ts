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
  return { ...components, ...BUILD_COMPONENT_SCHEMAS };
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

function buildPaths(): Record<string, unknown> {
  return {
    ...buildPathsForBuilds(),
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
