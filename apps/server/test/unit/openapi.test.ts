import { Validator } from '@seriousme/openapi-schema-validator';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, openapiRouter } from '../../src/openapi.js';

interface ValidatableDoc {
  components?: { schemas?: Record<string, unknown> };
  paths?: Record<string, unknown>;
}

function collectRefs(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        refs.add(value);
      } else {
        collectRefs(value, refs);
      }
    }
  }
}

describe('buildOpenApiDocument', () => {
  it('validates as OpenAPI 3.1', async () => {
    const doc = buildOpenApiDocument();
    const validator = new Validator();
    const result = await validator.validate(doc as never);
    if (!result.valid) {
      console.error(JSON.stringify(result.errors, null, 2));
    }
    expect(result.valid).toBe(true);
  });

  it('carries the expected schema components', () => {
    const doc = buildOpenApiDocument() as ValidatableDoc;
    const schemas = doc.components?.schemas ?? {};
    for (const id of ['ErrorEnvelope', 'Refusal', 'Manifest', 'DeployRequest', 'HealthResponse']) {
      expect(schemas).toHaveProperty(id);
    }
    const refusal = schemas['Refusal'] as { required?: string[] };
    expect(refusal.required).toEqual(['code', 'gate', 'message', 'fix']);
  });

  it('documents GET /host as a read returning HostResponse, with no write method (SHP-T-14.5)', () => {
    const doc = buildOpenApiDocument() as ValidatableDoc;
    const schemas = doc.components?.schemas ?? {};
    expect(schemas).toHaveProperty('HostResponse');
    expect(schemas).toHaveProperty('HostSnapshot');
    const host = doc.paths?.['/host'] as Record<string, { operationId?: string; responses?: Record<string, unknown> }> | undefined;
    expect(Object.keys(host ?? {})).toEqual(['get']);
    expect(host?.['get']?.operationId).toBe('getHost');
    expect(JSON.stringify(host?.['get']?.responses?.['200'])).toContain('#/components/schemas/HostResponse');
  });

  it('documents every lifecycle action and logs endpoint (SHP-T-15.4)', () => {
    const doc = buildOpenApiDocument() as ValidatableDoc;
    const paths = doc.paths ?? {};
    const ops = (path: string): Record<string, { operationId?: string; requestBody?: unknown; responses?: Record<string, unknown> }> =>
      (paths[path] ?? {}) as Record<string, { operationId?: string; requestBody?: unknown; responses?: Record<string, unknown> }>;
    expect(Object.keys(ops('/actions')).sort()).toEqual(['get', 'post']);
    expect(ops('/actions')['post']?.operationId).toBe('postAction');
    expect(JSON.stringify(ops('/actions')['post']?.requestBody)).toContain('#/components/schemas/ActionRequest');
    expect(JSON.stringify(ops('/actions')['post']?.responses?.['202'])).toContain('#/components/schemas/ActionStatus');
    expect(JSON.stringify(ops('/actions')['get']?.responses?.['200'])).toContain('#/components/schemas/ActionPage');
    expect(Object.keys(ops('/actions/{id}'))).toEqual(['get']);
    expect(JSON.stringify(ops('/logs')['post']?.requestBody)).toContain('#/components/schemas/LogsRequest');
    expect(JSON.stringify(ops('/logs')['post']?.responses?.['201'])).toContain('#/components/schemas/LogsSession');
    expect(JSON.stringify(ops('/logs/{id}/stream')['get']?.responses?.['200'])).toContain('text/event-stream');
    expect(Object.keys(ops('/logs/{id}'))).toEqual(['delete']);
    expect(JSON.stringify(ops('/agent/actions/{id}/progress')['post']?.requestBody)).toContain('#/components/schemas/ActionProgress');
    expect(JSON.stringify(ops('/agent/actions/{id}/result')['post']?.requestBody)).toContain('#/components/schemas/ActionResult');
    expect(JSON.stringify(ops('/agent/logs/{id}/chunks')['post']?.requestBody)).toContain('#/components/schemas/LogsChunk');
    expect(JSON.stringify(ops('/agent/logs/{id}/chunks')['post']?.responses?.['200'])).toContain('#/components/schemas/LogsChunkAck');
  });

  it('every $ref resolves to a component schema key', () => {
    const doc = buildOpenApiDocument() as ValidatableDoc;
    const schemas = doc.components?.schemas ?? {};
    const refs = new Set<string>();
    collectRefs(doc, refs);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      const id = ref.slice('#/components/schemas/'.length);
      expect(schemas).toHaveProperty(id);
    }
  });
});

describe('stack update paths (SHP-T-16.3)', () => {
  it('documents every stack update endpoint with its request and response schemas', () => {
    const doc = buildOpenApiDocument() as ValidatableDoc;
    const paths = doc.paths ?? {};
    const schemas = doc.components?.schemas ?? {};
    type Op = { operationId?: string; requestBody?: unknown; responses?: Record<string, unknown> };
    const ops = (path: string): Record<string, Op> => (paths[path] ?? {}) as Record<string, Op>;
    for (const id of ['StackView', 'StackList', 'StackNeedsYou', 'StackUpdateStatus', 'StackUpdatePage', 'StackUpdateRequest', 'StackRollbackRequest']) {
      expect(schemas).toHaveProperty(id);
    }
    expect(JSON.stringify(ops('/stacks')['get']?.responses?.['200'])).toContain('#/components/schemas/StackList');
    expect(Object.keys(ops('/stacks/{name}/updates')).sort()).toEqual(['get', 'post']);
    expect(JSON.stringify(ops('/stacks/{name}/updates')['post']?.requestBody)).toContain('#/components/schemas/StackUpdateRequest');
    expect(JSON.stringify(ops('/stacks/{name}/updates')['post']?.responses?.['202'])).toContain('#/components/schemas/StackUpdateStatus');
    expect(JSON.stringify(ops('/stacks/{name}/updates')['get']?.responses?.['200'])).toContain('#/components/schemas/StackUpdatePage');
    expect(JSON.stringify(ops('/stacks/{name}/rollback')['post']?.requestBody)).toContain('#/components/schemas/StackRollbackRequest');
    expect(JSON.stringify(ops('/stack-updates')['get']?.responses?.['200'])).toContain('#/components/schemas/StackUpdatePage');
    expect(JSON.stringify(ops('/stack-updates/needs-you')['get']?.responses?.['200'])).toContain('#/components/schemas/StackNeedsYou');
    expect(Object.keys(ops('/stack-updates/{id}'))).toEqual(['get']);
    expect(ops('/stack-updates/{id}/approve')['post']?.operationId).toBe('approveStackUpdate');
    expect(ops('/stack-updates/{id}/deny')['post']?.operationId).toBe('denyStackUpdate');
    expect(JSON.stringify(ops('/agent/stack-updates/{id}/progress')['post']?.requestBody)).toContain('#/components/schemas/StackUpdateProgress');
    expect(JSON.stringify(ops('/agent/stack-updates/{id}/result')['post']?.requestBody)).toContain('#/components/schemas/StackUpdateResult');
  });

  it('resolves every $ref it uses', () => {
    const doc = buildOpenApiDocument() as ValidatableDoc;
    const refs = new Set<string>();
    collectRefs(doc.paths, refs);
    collectRefs(doc.components, refs);
    const schemas = doc.components?.schemas ?? {};
    for (const ref of refs) {
      if (!ref.startsWith('#/components/schemas/')) continue;
      expect(schemas, ref).toHaveProperty(ref.slice('#/components/schemas/'.length));
    }
  });
});

describe('GET /api/openapi.json', () => {
  it('serves a valid OpenAPI document', async () => {
    const app = express();
    app.use('/api', openapiRouter());

    const response = await request(app).get('/api/openapi.json');
    expect(response.status).toBe(200);
    expect(response.type).toBe('application/json');

    const validator = new Validator();
    const result = await validator.validate(response.body as never);
    if (!result.valid) {
      console.error(JSON.stringify(result.errors, null, 2));
    }
    expect(result.valid).toBe(true);
  });
});
