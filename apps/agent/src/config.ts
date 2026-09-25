import { existsSync } from 'node:fs';

/**
 * The agent's configuration, from the environment only. There is no port to configure: the agent
 * opens none and reaches the server only through outbound requests (SHP-REQ-033).
 */
export interface AgentConfig {
  /** Where the server is, e.g. `https://shipyard.example.com`. */
  serverUrl: string;
  /** The host data root: manifests under `apps/`, the agent's own state under `agent/`. */
  dataRoot: string;
  /** A fine-grained read-only PAT for private repos (SHP-D-043). Omit for public repos. */
  githubToken: string | undefined;
  /** Reported to the server; defaults to the image revision. */
  agentVersion: string;
  /** The agent's own container ID when it runs in one; selects the network-join health probe. */
  selfContainerId: string | undefined;
  /** Passed to compose as DOCKER_HOST when set. */
  dockerHost: string | undefined;
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Reads the agent's configuration. `SHIPYARD_SERVER_URL` and `SHIPYARD_DATA_ROOT` are required.
 * The self container is `SHIPYARD_SELF_CONTAINER_ID`, else `HOSTNAME` when `/.dockerenv` exists
 * (Docker sets a container's hostname to its short ID).
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv, inContainer: () => boolean = () => existsSync('/.dockerenv')): AgentConfig {
  const serverUrl = nonEmpty(env['SHIPYARD_SERVER_URL']);
  if (serverUrl === undefined) throw new AgentConfigError('SHIPYARD_SERVER_URL is required');
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new AgentConfigError(`SHIPYARD_SERVER_URL is not a URL: ${serverUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AgentConfigError(`SHIPYARD_SERVER_URL must be http(s), got ${parsed.protocol}`);
  }

  const dataRoot = nonEmpty(env['SHIPYARD_DATA_ROOT']);
  if (dataRoot === undefined) throw new AgentConfigError('SHIPYARD_DATA_ROOT is required');

  const explicitSelf = nonEmpty(env['SHIPYARD_SELF_CONTAINER_ID']);
  const hostname = nonEmpty(env['HOSTNAME']);
  const selfContainerId = explicitSelf ?? (hostname !== undefined && inContainer() ? hostname : undefined);

  return {
    serverUrl: parsed.toString(),
    dataRoot: dataRoot.replace(/\/+$/, '') || '/',
    githubToken: nonEmpty(env['GITHUB_TOKEN_AGENT']),
    agentVersion: nonEmpty(env['SHIPYARD_AGENT_VERSION']) ?? nonEmpty(env['SHIPYARD_VERSION']) ?? 'unknown',
    selfContainerId,
    dockerHost: nonEmpty(env['DOCKER_HOST']),
  };
}
