import { oidcRedirectUri } from '../auth/oidc.js';

/**
 * The app manifest D3 Auth's console takes under Apps → Add an app — docs/d3auth/shipyard.d3auth.json,
 * with the redirect and post-logout URIs built from this server's PUBLIC_URL instead of the D3 Cloud
 * host's. A unit test holds the two in step.
 */
export function d3authManifest(publicUrl: string, clientId = 'shipyard'): Record<string, unknown> {
  return {
    client_id: clientId,
    name: 'Shipyard',
    client_type: 'confidential_web',
    description:
      "One deploy button for this host's compose stacks, for the console and for Claude Code sessions over MCP.",
    redirect_uris: [oidcRedirectUri(publicUrl)],
    post_logout_redirect_uris: [new URL('/', publicUrl).toString()],
    roles: [
      {
        key: 'admin',
        display: 'Administrator',
        description: 'A deployer who also manages users, tokens and the agent.',
      },
      {
        key: 'deployer',
        display: 'Deployer',
        description: 'Deploys, rolls back, approves, freezes and restores.',
        default: true,
      },
      {
        key: 'viewer',
        display: 'Viewer',
        description: 'Reads everything, changes nothing.',
      },
    ],
  };
}
