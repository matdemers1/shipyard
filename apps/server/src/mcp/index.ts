import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-2 pre-flight). SHP-T-2.8 fills it: the five MCP tools over Streamable HTTP at /mcp.
export function mcpRouter(_deps: ServiceDeps): Router {
  return Router();
}
