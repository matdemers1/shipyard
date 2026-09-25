import { refusal } from '@shipyard/schema';
import type { MachineContext } from './machine.js';
import type { SequencePorts } from './ports.js';
import type { DeployResult } from './types.js';

/**
 * Guided restore (SHP-T-5.6, SHP-D-038): the app's own restore command against a backup a deploy
 * took, from the agent's own ledger only (SHP-REQ-085), at most once per app per 24 hours
 * (SHP-REQ-084). A stub until that task fills it.
 */
export interface RestoreRequest {
  /** This restore's own ID (journal, lock, ledger entry). */
  deployId: string;
  app: string;
  /** The deploy whose backup artifact is restored, as the agent's ledger recorded it. */
  backupOf: string;
  requesterLabel: string;
  dryRun?: boolean;
}

export function runRestore(_ports: SequencePorts, _ctx: MachineContext, request: RestoreRequest): Promise<DeployResult> {
  return Promise.resolve({
    deployId: request.deployId,
    app: request.app,
    state: 'refused',
    sha: '',
    images: [],
    schemaRevision: null,
    gates: [],
    refusal: refusal('invalid_request', 'This agent does not run restores yet.'),
    steps: [],
    backupArtifact: null,
  });
}
