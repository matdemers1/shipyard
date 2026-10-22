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
