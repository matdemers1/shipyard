import { z } from 'zod';

import { AppName, Digest } from './primitives.js';

/**
 * The host inventory (SHP-ADR-008, SHP-ADR-009): everything Docker runs on the agent's host, as the
 * agent reports it and as the console's Host destination and `shipyard_host` show it. Read-only:
 * nothing here is ever a request to the host.
 *
 * Every object is strict and names only what the Host view needs. A container's environment,
 * command, entrypoint and labels have no field here, so they cannot reach the server even by
 * mistake (SHP-REQ-177); compose's project and service labels arrive as `compose` instead.
 */

/**
 * How much Shipyard is trusted to change a container (SHP-ADR-008). Derived on the agent from its
 * host-local manifests, never from a request: `shipped` when a D3 manifest maps it, `operated` when
 * a `kind: stack` manifest names its compose project (SHP-ADR-010), otherwise `observed`.
 */
export const ContainerTier = z
  .enum(['shipped', 'operated', 'observed'])
  .meta({ id: 'ContainerTier', description: 'Shipped (a D3 app), Operated (an adopted stack) or Observed (seen only)' });
export type ContainerTier = z.infer<typeof ContainerTier>;

/** Docker's container states (`State.Status`). */
export const ContainerState = z
  .enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'])
  .meta({ id: 'ContainerState', description: "Docker's container state" });
export type ContainerState = z.infer<typeof ContainerState>;

/** The container's own healthcheck result; `none` when the image declares no healthcheck. */
export const ContainerHealth = z
  .enum(['healthy', 'unhealthy', 'starting', 'none'])
  .meta({ id: 'ContainerHealth', description: "The container's healthcheck status, or none" });
export type ContainerHealth = z.infer<typeof ContainerHealth>;

const ContainerId = z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters');
const ImageId = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'sha256:<64 lowercase hex characters>');
const Bytes = z.int().min(0);

/** Compose's `com.docker.compose.project` / `.service` labels, the only labels the agent reads. */
export const ComposeRef = z
  .strictObject({
    project: z.string().min(1).max(255),
    service: z.string().min(1).max(255),
  })
  .meta({ id: 'ComposeRef', description: "A container's compose project and service" });
export type ComposeRef = z.infer<typeof ComposeRef>;

export const HostPort = z
  .strictObject({
    privatePort: z.int().min(0).max(65535),
    /** Null when the port is exposed but not published. */
    publicPort: z.int().min(0).max(65535).nullable(),
    protocol: z.enum(['tcp', 'udp', 'sctp']),
    /** The host address it is published on; null when unpublished. */
    ip: z.string().max(64).nullable(),
  })
  .meta({ id: 'HostPort', description: 'A port a container exposes or publishes' });
export type HostPort = z.infer<typeof HostPort>;

export const HostMount = z
  .strictObject({
    type: z.enum(['volume', 'bind', 'tmpfs', 'npipe', 'cluster', 'image']),
    /** The volume's name for a `volume` mount; null otherwise. */
    volume: z.string().min(1).max(255).nullable(),
    /** The host path for a `bind` mount; null otherwise. */
    source: z.string().min(1).max(4096).nullable(),
    destination: z.string().min(1).max(4096),
    readOnly: z.boolean(),
  })
  .meta({ id: 'HostMount', description: 'A mount on a container: a named volume, a bind path or tmpfs' });
export type HostMount = z.infer<typeof HostMount>;

/** One-shot resource use sampled on the report interval (SHP-ADR-009); never streamed. */
export const ContainerStats = z
  .strictObject({
    cpuPercent: z.number().min(0),
    memoryBytes: Bytes,
    /** The container's memory limit; null when it has none. */
    memoryLimitBytes: Bytes.nullable(),
  })
  .meta({ id: 'ContainerStats', description: "A container's sampled CPU and memory use" });
export type ContainerStats = z.infer<typeof ContainerStats>;

export const HostContainer = z
  .strictObject({
    id: ContainerId,
    /** The name without Docker's leading slash. */
    name: z.string().min(1).max(255),
    /** The image reference as the container was created with it. */
    image: z.string().min(1).max(500),
    imageId: ImageId,
    /** The repo digest of the image for the container's own repository; null for a local build. */
    digest: Digest.nullable(),
    state: ContainerState,
    health: ContainerHealth,
    restartCount: z.int().min(0),
    createdAt: z.iso.datetime({ offset: true }),
    /** When it last started; null when it never has. */
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    /** Null for a container compose did not create. */
    compose: ComposeRef.nullable(),
    tier: ContainerTier,
    /** The Shipyard app (shipped) or stack (operated) it belongs to; null when observed. */
    app: AppName.nullable(),
    ports: z.array(HostPort).max(200),
    mounts: z.array(HostMount).max(200),
    /** Null when the container is not running or the sample failed. */
    stats: ContainerStats.nullable(),
  })
  .meta({ id: 'HostContainer', description: 'One container on the host, with its tier' });
export type HostContainer = z.infer<typeof HostContainer>;

export const HostVolume = z
  .strictObject({
    name: z.string().min(1).max(255),
    driver: z.string().min(1).max(100),
    /** From `/system/df`; null when Docker cannot say (it reports -1). */
    sizeBytes: Bytes.nullable(),
    /** Names of every container, running or stopped, that mounts it. */
    mountedBy: z.array(z.string().min(1).max(255)).max(500),
    /** Compose's project label on the volume; null when compose did not create it. */
    composeProject: z.string().min(1).max(255).nullable(),
    /** True when no container, running or stopped, mounts it. */
    orphan: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'HostVolume', description: 'A named volume, its size and who mounts it' });
export type HostVolume = z.infer<typeof HostVolume>;

export const HostImage = z
  .strictObject({
    id: ImageId,
    repoTags: z.array(z.string().min(1).max(500)).max(100),
    repoDigests: z.array(z.string().min(1).max(600)).max(100),
    sizeBytes: Bytes,
    createdAt: z.iso.datetime({ offset: true }),
    /** How many containers, running or stopped, use it. */
    containers: z.int().min(0),
    /** No tag at all: what a dangling-image prune would remove. */
    dangling: z.boolean(),
  })
  .meta({ id: 'HostImage', description: 'A local image, its size and whether anything uses it' });
export type HostImage = z.infer<typeof HostImage>;

export const HostNetwork = z
  .strictObject({
    id: z.string().regex(/^[0-9a-f]{12,64}$/, 'lowercase hex network ID'),
    name: z.string().min(1).max(255),
    driver: z.string().min(1).max(100),
    scope: z.string().min(1).max(50),
    internal: z.boolean(),
    /** How many containers are attached. */
    containers: z.int().min(0),
    composeProject: z.string().min(1).max(255).nullable(),
  })
  .meta({ id: 'HostNetwork', description: 'A Docker network and how many containers it carries' });
export type HostNetwork = z.infer<typeof HostNetwork>;

/** One filesystem's space, from statfs. */
export const HostFilesystem = z
  .strictObject({
    path: z.string().min(1).max(4096),
    freeBytes: Bytes,
    totalBytes: Bytes,
  })
  .meta({ id: 'HostFilesystem', description: 'Free and total bytes on one filesystem' });
export type HostFilesystem = z.infer<typeof HostFilesystem>;

export const HostDisk = z
  .strictObject({
    /** The agent's data root (where manifests, ledger and backups live). */
    dataRoot: HostFilesystem,
    /** Docker's root (`/var/lib/docker` or its configured `DockerRootDir`); null when it cannot be read. */
    dockerRoot: HostFilesystem.nullable(),
  })
  .meta({ id: 'HostDisk', description: 'Space on the data root and the Docker root' });
export type HostDisk = z.infer<typeof HostDisk>;

/** Docker's own builder cache from `/system/df` (not Shipyard's BuildKit cache, `AgentBuildCache`). */
export const HostBuilderCache = z
  .strictObject({
    bytes: Bytes,
    reclaimableBytes: Bytes,
  })
  .meta({ id: 'HostBuilderCache', description: "Docker's builder cache size and how much of it is unused" });
export type HostBuilderCache = z.infer<typeof HostBuilderCache>;

export const HostInventory = z
  .strictObject({
    /** When the agent read it from the Engine. */
    sampledAt: z.iso.datetime({ offset: true }),
    containers: z.array(HostContainer).max(2000),
    volumes: z.array(HostVolume).max(2000),
    images: z.array(HostImage).max(5000),
    networks: z.array(HostNetwork).max(500),
    builderCache: HostBuilderCache,
    disk: HostDisk,
  })
  .meta({ id: 'HostInventory', description: 'Everything Docker runs on the host, as the agent reported it' });
export type HostInventory = z.infer<typeof HostInventory>;

/** One point of a container's resource history, for the Host view's sparklines. */
export const HostSample = z
  .strictObject({
    at: z.iso.datetime({ offset: true }),
    cpuPercent: z.number().min(0),
    memoryBytes: Bytes,
  })
  .meta({ id: 'HostSample', description: "One sample of a container's CPU and memory" });
export type HostSample = z.infer<typeof HostSample>;

/**
 * The latest inventory one agent reported, with the time the server received it and a short
 * rolling window of samples keyed by container name (names survive a recreate; IDs do not).
 */
export const HostSnapshot = z
  .strictObject({
    /** The reporting agent, by ID and the key fingerprint the console shows for it. */
    agent: z.strictObject({ id: z.uuid(), fingerprint: z.string().min(1).max(200) }),
    reportedAt: z.iso.datetime({ offset: true }),
    inventory: HostInventory,
    samples: z.record(z.string().min(1).max(255), z.array(HostSample).max(500)),
  })
  .meta({ id: 'HostSnapshot', description: "One agent's latest host inventory and recent samples" });
export type HostSnapshot = z.infer<typeof HostSnapshot>;

/**
 * `GET /api/host` and `shipyard_host` (SHP-REQ-179): one snapshot per agent that has reported an
 * inventory; empty until one has.
 */
export const HostResponse = z
  .strictObject({
    hosts: z.array(HostSnapshot),
  })
  .meta({ id: 'HostResponse', description: 'The latest host snapshot of every agent that has reported one' });
export type HostResponse = z.infer<typeof HostResponse>;
