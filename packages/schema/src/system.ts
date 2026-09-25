import { z } from 'zod';

/**
 * System screen contracts (SHP-T-6.5, SHP-REQ-094/095/106). `GET /api/system` — versions, the
 * agent's heartbeat and PAT expiry, the Foreman outbox backlog, and Shipyard's own backups.
 * Deployer-only: a viewer or a token is refused before this is ever built.
 */

export const PatWarning = z
  .enum(['none', 'expiring', 'expired'])
  .meta({ id: 'PatWarning', description: "The agent's GitHub PAT expiry warning state" });
export type PatWarning = z.infer<typeof PatWarning>;

export const SystemVersions = z
  .strictObject({
    server: z.string().min(1),
    agent: z.string().nullable(),
    compose: z.string().nullable(),
    engineApi: z.string().nullable(),
  })
  .meta({ id: 'SystemVersions', description: 'Reported component versions' });
export type SystemVersions = z.infer<typeof SystemVersions>;

export const SystemAgent = z
  .strictObject({
    fingerprint: z.string().min(1),
    lastHeartbeatAt: z.iso.datetime().nullable(),
    stale: z.boolean(),
    patExpiresAt: z.iso.datetime().nullable(),
    patWarning: PatWarning,
  })
  .meta({ id: 'SystemAgent', description: "The confirmed agent's status, or null when none is enrolled" });
export type SystemAgent = z.infer<typeof SystemAgent>;

export const SystemOutbox = z
  .strictObject({
    /** Rows not yet delivered to Foreman. */
    unsent: z.int().min(0),
    /** Of those, the ones created more than an hour ago (SHP-REQ-095). */
    unsentOverHour: z.int().min(0),
    oldestUnsentAt: z.iso.datetime().nullable(),
    lastError: z.string().nullable(),
  })
  .meta({ id: 'SystemOutbox', description: 'The Foreman outbox backlog' });
export type SystemOutbox = z.infer<typeof SystemOutbox>;

export const SystemBackupRun = z
  .strictObject({
    at: z.iso.datetime(),
    ok: z.boolean(),
    file: z.string().nullable(),
    bytes: z.int().min(0).nullable(),
    durationMs: z.int().min(0).nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'SystemBackupRun', description: "Shipyard's own last nightly backup or restore drill" });
export type SystemBackupRun = z.infer<typeof SystemBackupRun>;

export const SystemBackups = z
  .strictObject({
    lastBackup: SystemBackupRun.nullable(),
    lastDrill: SystemBackupRun.nullable(),
  })
  .meta({ id: 'SystemBackups', description: "Shipyard's own backups (SHP-D-035)" });
export type SystemBackups = z.infer<typeof SystemBackups>;

export const SystemStatus = z
  .strictObject({
    versions: SystemVersions,
    agent: SystemAgent.nullable(),
    outbox: SystemOutbox,
    backups: SystemBackups,
  })
  .meta({ id: 'SystemStatus', description: 'GET /api/system response' });
export type SystemStatus = z.infer<typeof SystemStatus>;
