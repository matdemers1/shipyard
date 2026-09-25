import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { callerFromRequest } from '../deploys/service.js';
import { buildMcpServer, type McpOptions } from './tools.js';

export { DEFAULT_DRY_RUN_WAIT_SECONDS, type McpOptions } from './tools.js';

/**
 * MCP over Streamable HTTP at `/mcp` (SHP-REQ-041, SHP-D-073): stateless — a new server and
 * transport per POST, no session IDs — and authenticated by an API token only. A session cookie is
 * not enough: an MCP client is a program acting for a token, and the token's app scope is what
 * bounds it (SHP-REQ-047).
 */
export function mcpRouter(deps: ServiceDeps, options: McpOptions = {}): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    // MCP is POST-only, and most calls read (initialize, tools/list, status). A deploy or rollback
    // is audited by the deploy service itself when it changes something.
    req.noAuditNeeded('mcp');
    if (req.actor?.type !== 'token') {
      res.setHeader('WWW-Authenticate', 'Bearer realm="shipyard"');
      res.status(401).json({
        error: refusal(
          'unauthenticated',
          'The MCP endpoint needs an API token.',
          'Send `Authorization: Bearer shp_…` with a token issued in the console.',
        ),
      });
      return;
    }

    const closed = new AbortController();
    const server = buildMcpServer(deps, callerFromRequest(req), closed.signal, options);
    // No sessionIdGenerator: stateless mode (the SDK's `sessionIdGenerator: undefined`).
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      closed.abort();
      void transport.close();
      void server.close();
    });
    // The SDK's optional callbacks don't satisfy exactOptionalPropertyTypes; the shape is the same.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless: no server-initiated stream (GET) and no session to end (DELETE).
  router.all('/', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      error: refusal('invalid_request', 'Only POST is supported at /mcp.', 'Use the Streamable HTTP transport without sessions.'),
    });
  });

  return router;
}
