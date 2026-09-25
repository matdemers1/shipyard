import type { ServiceDeps } from '../deps.js';

// Stub (SHP-P-2 pre-flight). SHP-T-2.9 replaces it: the Foreman outbox drain loop.
export function startOutbox(_deps: ServiceDeps): { stop(): Promise<void> } {
  return { stop: () => Promise.resolve() };
}
