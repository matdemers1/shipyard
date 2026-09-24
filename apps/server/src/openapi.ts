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
  return components;
}

const ERROR_RESPONSE = {
  description: 'A refusal: every non-2xx response is `{ error: { code, gate, message, fix } }`.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorEnvelope' },
    },
  },
};

function buildPaths(): Record<string, unknown> {
  return {
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
