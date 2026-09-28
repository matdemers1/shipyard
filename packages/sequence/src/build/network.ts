import { refusal } from '@shipyard/schema';

import { RefusalError } from '../ports.js';

/**
 * The build network (SHP-T-7.8, SHP-REQ-123, SHP-REQ-124).
 *
 * Rootless `buildkitd` runs in its own container attached only to the `shipyard-build` bridge. A
 * Dockerfile `RUN` step executes in buildkitd's network namespace (the rootless image runs
 * RootlessKit with the host network of its container, and the OCI worker's `auto` network mode
 * with no CNI config is `host`), so whatever that container can reach, a build step can reach.
 * Isolating the container isolates every build step.
 *
 * The network and its firewall rules are made once, by the operator, with
 * `docs/install/build-network.sh` — never by the agent, which is portless and has no business
 * holding iptables. The script:
 *
 * - creates `shipyard-build` with the fixed subnet below, IPv6 off, and a fixed bridge interface
 *   name, so the rules can match the interface rather than a (spoofable) source address;
 * - in `DOCKER-USER` (forwarded traffic), drops everything from that bridge to
 *   `BUILD_BLOCKED_CIDRS` — every private, link-local, CGNAT/tailnet, loopback and multicast range
 *   — and to the host's default-route gateway; everything else (the public internet, so package
 *   registries per SHP-REQ-124) returns to Docker's own rules;
 * - in `INPUT` (traffic addressed to the host itself, on any of its addresses, which never reaches
 *   `DOCKER-USER`), drops everything from that bridge. This is what keeps a build step off the
 *   Docker host — the network's gateway address is the host.
 *
 * Other compose projects' networks come from Docker's private address pools, so they are covered by
 * the RFC1918 drops as well as by Docker's own inter-bridge isolation.
 *
 * The agent cannot see the host's firewall. `verifyBuildNetwork` checks what it can see through
 * Docker — the network exists, has the expected subnet and bridge name, is not internal (that would
 * cut registry access) and has IPv6 off — and refuses with the script as the fix when it does not.
 */

/** The Docker network buildkitd is attached to (and nothing else is). */
export const BUILD_NETWORK_NAME = 'shipyard-build';
/** The fixed IPv4 subnet `build-network.sh` creates it with (override there and here together). */
export const BUILD_NETWORK_SUBNET = '172.31.254.0/24';
/** The network's gateway — the Docker host's address on that bridge. Blocked like the rest of the host. */
export const BUILD_NETWORK_GATEWAY = '172.31.254.1';
/** The Linux bridge interface name (≤ 15 characters), matched by the firewall rules. */
export const BUILD_NETWORK_BRIDGE = 'br-shipyard-bld';

/**
 * Destinations a build or test container must never reach (SHP-REQ-123): RFC1918, link-local
 * (cloud metadata lives here), CGNAT (Tailscale's tailnet), loopback, "this network", multicast
 * and reserved. The script installs one DROP per entry, in this order.
 */
export const BUILD_BLOCKED_CIDRS: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '0.0.0.0/8',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

/** The iptables chains the script owns. */
export const BUILD_FORWARD_CHAIN = 'SHIPYARD-BUILD';
export const BUILD_INPUT_CHAIN = 'SHIPYARD-BUILD-INPUT';

/** What the agent can observe about a Docker network. */
export interface BuildNetworkInfo {
  name: string;
  /** IPv4/IPv6 subnets from the network's IPAM config. */
  subnets: string[];
  internal: boolean;
  enableIPv6: boolean;
  /** The network's driver options (`com.docker.network.bridge.name`, …). */
  options: Record<string, string>;
}

/**
 * The narrow Docker seam `verifyBuildNetwork` needs: a network inspect, null when absent. Not yet on
 * `DockerPort` (ports.ts is shared); the lead adds `inspectNetwork` there, backed by dockerode's
 * `getNetwork(name).inspect()`, and the agent passes its DockerPort straight in.
 */
export interface NetworkInspector {
  inspectNetwork(name: string): Promise<BuildNetworkInfo | null>;
}

const FIX = `Run docs/install/build-network.sh as root on the Docker host (once, idempotent), then retry the build.`;

function refuse(message: string): never {
  throw new RefusalError(refusal('step_failed', message, FIX));
}

/**
 * Preflight before any build (SHP-REQ-123, SHP-REQ-124): refuses when the build network is
 * missing or is not the one the script makes. Resolves with what it saw when it passes.
 */
export async function verifyBuildNetwork(docker: NetworkInspector, name: string = BUILD_NETWORK_NAME): Promise<BuildNetworkInfo> {
  const info = await docker.inspectNetwork(name);
  if (info === null) refuse(`The build network ${name} does not exist, so build steps would have no isolation.`);
  if (!info.subnets.includes(BUILD_NETWORK_SUBNET)) {
    refuse(`The build network ${name} has subnet ${info.subnets.join(', ') || 'none'}, not ${BUILD_NETWORK_SUBNET}; the firewall rules would not cover it.`);
  }
  if (info.subnets.some((s) => s.includes(':')) || info.enableIPv6) {
    refuse(`The build network ${name} has IPv6 enabled; the firewall rules cover IPv4 only.`);
  }
  if (info.options['com.docker.network.bridge.name'] !== BUILD_NETWORK_BRIDGE) {
    refuse(`The build network ${name} is not on bridge ${BUILD_NETWORK_BRIDGE}; the firewall rules match that interface.`);
  }
  if (info.internal) {
    refuse(`The build network ${name} is internal, so builds could not reach package registries (SHP-REQ-124).`);
  }
  return info;
}
