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
 * The agent cannot see the host's firewall (it runs in a container, without the host's network
 * namespace or iptables). `verifyBuildNetwork` checks what it can see through Docker — the network
 * exists, has the expected subnet and bridge name, is not internal (that would cut registry access)
 * and has IPv6 off — and refuses with the script as the fix when it does not. Whether the rules are
 * installed is not observable from there; that is why the script must run after every reboot.
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

/**
 * Per-build integration networks (SHP-REQ-119, SHP-REQ-123).
 *
 * An `internal: true` Docker network has no route off its own subnet, but by default the host still
 * owns the bridge's gateway address, and a packet to that address is delivered through the host's
 * `INPUT` chain — so anything listening on the host's wildcard address (dockerd, SSH, every host
 * service) would be reachable from an integration test. Two independent fixes, both applied:
 *
 * 1. **No host address at all.** The generated override sets the bridge option
 *    `com.docker.network.bridge.gateway_mode_ipv4=isolated` (Docker Engine 28+), so the host never
 *    configures an address on the bridge; there is nothing on the host to connect to.
 * 2. **A firewall that does not depend on (1).** Every per-build network is allocated a /24 from
 *    `INTEGRATION_SUBNET_POOL`, on a bridge named `INTEGRATION_BRIDGE_PREFIX<n>`, and
 *    `build-network.sh` drops, in `INPUT` and `DOCKER-USER`, everything arriving from a bridge with
 *    that prefix or from a source in the pool (replies to connections the host opened aside). An
 *    engine that ignores the option, or a future default that brings the gateway back, still leaves
 *    the host unreachable.
 *
 * The agent cannot see the host's iptables from inside its container, so `verifyBuildNetwork` cannot
 * prove the rules are installed; the script is the operator's responsibility, re-run after a reboot.
 * The script refuses to install the rules when a network or route that is not Shipyard's already
 * overlaps the pool.
 */
export const INTEGRATION_SUBNET_POOL = '172.30.0.0/16';
/** Bridge interface prefix for per-build networks; iptables matches it as `shp-it-+`. */
export const INTEGRATION_BRIDGE_PREFIX = 'shp-it-';
/** The bridge driver option that leaves the host with no address on the network. */
export const INTEGRATION_GATEWAY_MODE_OPTION = 'com.docker.network.bridge.gateway_mode_ipv4';
export const INTEGRATION_FORWARD_CHAIN = 'SHIPYARD-ITEST';
export const INTEGRATION_INPUT_CHAIN = 'SHIPYARD-ITEST-INPUT';
/** How many /24s the pool holds. */
export const INTEGRATION_SUBNET_SLOTS = 256;

/** The first slot tried for a build: deterministic in the build ID (FNV-1a over its lowercase form). */
export function integrationSubnetSlot(buildId: string): number {
  let hash = 0x811c9dc5;
  for (const ch of buildId.toLowerCase()) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % INTEGRATION_SUBNET_SLOTS;
}

/** The subnet and bridge name for one slot of the pool: `172.30.<slot>.0/24` on `shp-it-<slot>`. */
export function integrationNetworkSlot(slot: number): { subnet: string; bridge: string } {
  if (!Number.isInteger(slot) || slot < 0 || slot >= INTEGRATION_SUBNET_SLOTS) throw new RangeError(`integration subnet slot ${String(slot)} is outside the pool`);
  return { subnet: `172.30.${String(slot)}.0/24`, bridge: `${INTEGRATION_BRIDGE_PREFIX}${String(slot)}` };
}

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
