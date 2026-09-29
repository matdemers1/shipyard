// The CLAUDE.md snippet has one source, the file managed repos copy it from (SHP-REQ-089).
import deploySnippetFile from '../../../../docs/claude/deploy-snippet.md?raw';

/**
 * Connect Claude Code (SHP-T-3.12): the text a person copies to point Claude Code at this
 * Shipyard's MCP server. Pure, so the exact strings are tested rather than eyeballed.
 */

/** The name Claude Code lists the server under, and the env var a repo's `.mcp.json` reads. */
export const SERVER_NAME = 'shipyard';
export const TOKEN_ENV = 'SHIPYARD_TOKEN';

export function mcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

/** One command, every repo on this machine: `--scope user` keeps the token out of any repo. */
export function claudeAddCommand(origin: string, token: string): string {
  return `claude mcp add --transport http --scope user ${SERVER_NAME} ${mcpUrl(origin)} --header "Authorization: Bearer ${token}"`;
}

/**
 * A repo's `.mcp.json` that is safe to commit: Claude Code expands `${SHIPYARD_TOKEN}` from the
 * environment, so the file names the variable and never holds the secret.
 */
export function mcpJsonWithEnv(origin: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          url: mcpUrl(origin),
          headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        },
      },
    },
    null,
    2,
  );
}

/** The line for a shell profile that gives `.mcp.json` its token. */
export function envLine(token: string): string {
  return `export ${TOKEN_ENV}=${token}`;
}

/** The snippet as a repo's CLAUDE.md takes it: without the file's own leading comment. */
export const DEPLOY_SNIPPET = deploySnippetFile.replace(/^<!--[\s\S]*?-->\s*/, '').trimEnd() + '\n';

/**
 * The snippet names the Shipyard it was written for (its "Connect once" line gives `<origin>/mcp`);
 * a self-hosted one shows its own origin in every place that one appears.
 */
export function deploySnippetFor(origin: string): string {
  const written = /`(https?:\/\/[^/`\s]+)\/mcp`/.exec(DEPLOY_SNIPPET)?.[1];
  return written === undefined ? DEPLOY_SNIPPET : DEPLOY_SNIPPET.replaceAll(written, origin.replace(/\/+$/, ''));
}

/** What each MCP tool does, in the words the page shows. The server's tool list is the source. */
export const TOOLS: readonly { name: string; does: string }[] = [
  { name: 'shipyard_status', does: 'What is live for each app, what is waiting to ship, and its build state.' },
  { name: 'shipyard_dry_run', does: 'Runs every check for a commit without changing anything.' },
  { name: 'shipyard_deploy', does: 'Ships a commit to an app or a group — the same checks, backup and rollback as the Ship button.' },
  { name: 'shipyard_deploy_status', does: 'Follows a deploy to the end and reports the SHA per image and the schema revision.' },
  { name: 'shipyard_rollback', does: 'Puts an earlier successful release back, from the agent’s own ledger.' },
  { name: 'shipyard_build', does: 'Queues a Shipyard build of a commit, for an app whose images Shipyard builds.' },
  { name: 'shipyard_build_status', does: 'Follows a build and says when it is deployable.' },
];
