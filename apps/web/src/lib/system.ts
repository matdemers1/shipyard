import type { SystemStatus } from '@shipyard/schema';
import { request } from './api';

/**
 * The System screen's call (S15) — `GET /api/system` (SHP-T-6.5): versions, the agent's
 * heartbeat and PAT expiry, the Foreman outbox backlog, and Shipyard's own last backup and drill.
 */
export const system = {
  status: (): Promise<SystemStatus> => request<SystemStatus>('/api/system'),
};
