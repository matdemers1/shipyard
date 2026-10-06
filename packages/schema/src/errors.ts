import { z } from 'zod';

/**
 * The error catalogue (SHP-REQ-031). Every refusal is { code, gate, message, fix }
 * so a caller — human or agent — always has a next step, not just a reason.
 */

export const Gate = z
  .enum(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'none'])
  .meta({ id: 'Gate', description: 'The deploy gate a refusal was raised at, or none' });
export type Gate = z.infer<typeof Gate>;

/**
 * Each gate's human name, the words the console and the MCP tools show for a deploy check
 * (SHP-REQ-165, SHP-REQ-171, SHP-T-13.3). The gate code (G5) is secondary text beside it. The
 * console's `checkName` (apps/web/src/lib/words.ts) carries the same table: importing this module
 * at runtime would put zod and every schema in the phone-first bundle (about 44 kB gzipped), so
 * the console mirrors it and apps/web/test/words.test.ts fails if the two drift. G6's name is the
 * default-branch case; the console says "On main" when it knows the branch. Disk is a check the
 * sequence runs but not a Gate value, so the console names it itself.
 */
export const GATE_DESCRIPTIONS: Record<Gate, string> = {
  G1: 'Allowed',
  G2: 'Not frozen',
  G3: 'No drift',
  G4: 'Not locked',
  G5: 'CI passed',
  G6: 'On the default branch',
  G7: 'Ahead of live',
  G8: 'Images in GHCR',
  G9: 'Env names present',
  G10: 'No contract release since',
  G11: 'Approved',
  none: 'Not a check',
};

export const ErrorCode = z
  .enum([
    'invalid_request',
    'unauthenticated',
    'forbidden',
    'not_found',
    'app_frozen',
    'drift_unresolved',
    'locked',
    'ci_not_green',
    'not_on_default_branch',
    'not_ahead_of_live',
    'image_missing',
    'env_missing',
    'later_contract_release',
    'approval_required',
    'github_unreachable',
    'ghcr_unreachable',
    'agent_offline',
    'conflict',
    'too_many_attempts',
    'insufficient_disk',
    'manifest_invalid',
    'unknown_app',
    'health_failed',
    'digest_mismatch',
    'build_not_green',
    'build_digest_mismatch',
    'revision_mismatch',
    'schema_mismatch',
    'step_failed',
    'backup_failed',
    'migrate_failed',
    'interrupted',
    'not_enrolled',
    'rollback_target_invalid',
    'restore_limited',
    'image_line_invalid',
    'group_stopped',
    'rollout_stopped',
    'step_up_required',
  ])
  .meta({ id: 'ErrorCode', description: 'Machine-readable refusal reason' });
export type ErrorCode = z.infer<typeof ErrorCode>;

interface CatalogueEntry {
  gate: Gate;
  httpStatus: number;
  defaultFix: string;
}

export const CATALOGUE: Record<ErrorCode, CatalogueEntry> = {
  invalid_request: { gate: 'none', httpStatus: 400, defaultFix: 'Fix the request body and retry.' },
  unauthenticated: { gate: 'none', httpStatus: 401, defaultFix: 'Sign in and retry.' },
  forbidden: { gate: 'G1', httpStatus: 403, defaultFix: 'Ask an owner to grant access to this app.' },
  not_found: { gate: 'none', httpStatus: 404, defaultFix: 'Check the app name or deploy ID and retry.' },
  app_frozen: { gate: 'G2', httpStatus: 409, defaultFix: 'Unfreeze the app before deploying.' },
  drift_unresolved: { gate: 'G3', httpStatus: 409, defaultFix: 'Resolve the drift before deploying.' },
  locked: { gate: 'G4', httpStatus: 409, defaultFix: 'Wait for the current deploy to finish, or ask its holder to release the lock.' },
  ci_not_green: { gate: 'G5', httpStatus: 409, defaultFix: 'Wait for the image workflow to succeed for this SHA.' },
  not_on_default_branch: { gate: 'G6', httpStatus: 409, defaultFix: 'Merge to the default branch before deploying.' },
  not_ahead_of_live: { gate: 'G7', httpStatus: 409, defaultFix: 'Choose a SHA ahead of the currently live one.' },
  image_missing: { gate: 'G8', httpStatus: 409, defaultFix: 'Wait for the image build to publish sha-<40hex> with a digest in GHCR.' },
  env_missing: { gate: 'G9', httpStatus: 409, defaultFix: 'Set the required environment names on the host and retry.' },
  later_contract_release: { gate: 'G10', httpStatus: 409, defaultFix: 'A contract-migrating release exists after this one; deploy that instead, or roll it back first.' },
  approval_required: { gate: 'G11', httpStatus: 409, defaultFix: 'Get approval for this deploy and retry.' },
  github_unreachable: { gate: 'none', httpStatus: 503, defaultFix: 'Retry once GitHub is reachable; the gate fails closed.' },
  ghcr_unreachable: { gate: 'none', httpStatus: 503, defaultFix: 'Retry once GHCR is reachable; the gate fails closed.' },
  agent_offline: { gate: 'none', httpStatus: 503, defaultFix: 'Check the agent long-poll connection and retry.' },
  conflict: { gate: 'none', httpStatus: 409, defaultFix: 'Refresh state and retry.' },
  too_many_attempts: {
    gate: 'none',
    httpStatus: 429,
    defaultFix: 'Too many failed sign-in attempts. Wait for the cooling-off period, then try again.',
  },
  insufficient_disk: { gate: 'none', httpStatus: 507, defaultFix: "Free space on the Docker root (prune old images) or lower the manifest's diskFloorGb." },
  manifest_invalid: { gate: 'none', httpStatus: 422, defaultFix: "Fix the named field in the app's manifest on the host." },
  unknown_app: { gate: 'none', httpStatus: 404, defaultFix: "Add a manifest for this app on the host; the agent reports it on its next poll." },
  health_failed: { gate: 'none', httpStatus: 502, defaultFix: "Check the app's logs; Shipyard rolled back to the previous images." },
  digest_mismatch: { gate: 'none', httpStatus: 502, defaultFix: "The running container is not the verified image; check the compose file's image line." },
  build_not_green: { gate: 'G5', httpStatus: 409, defaultFix: "Wait for Shipyard's build of this commit to succeed, or rebuild it from the console." },
  build_digest_mismatch: { gate: 'G5', httpStatus: 409, defaultFix: 'The pushed image changed since the build; rebuild it from the console.' },
  revision_mismatch: { gate: 'none', httpStatus: 502, defaultFix: "The image's org.opencontainers.image.revision label does not match the SHA; check the app's CI labels." },
  schema_mismatch: { gate: 'none', httpStatus: 502, defaultFix: "/health reported a different schema revision than the release carries; check the migration." },
  step_failed: { gate: 'none', httpStatus: 502, defaultFix: "Read the step's journaled output and fix the step before retrying." },
  backup_failed: { gate: 'none', httpStatus: 502, defaultFix: "The backup did not exit 0 with a new non-empty artifact; nothing was swapped." },
  migrate_failed: { gate: 'none', httpStatus: 502, defaultFix: "The migration failed before the swap; the old release is still serving." },
  interrupted: { gate: 'none', httpStatus: 409, defaultFix: "The agent restarted mid-deploy and restored the last verified-good compose; request the deploy again." },
  not_enrolled: { gate: 'none', httpStatus: 403, defaultFix: "Confirm the agent's key fingerprint in the console." },
  rollback_target_invalid: { gate: 'none', httpStatus: 409, defaultFix: "Choose one of the last five releases in the agent's own ledger." },
  restore_limited: { gate: 'none', httpStatus: 409, defaultFix: "Only backups the agent took may be restored, at most once per app per 24 hours." },
  image_line_invalid: { gate: 'none', httpStatus: 409, defaultFix: "Every mapped service needs exactly one literal image: line for its repository in the compose file." },
  step_up_required: {
    gate: 'none',
    httpStatus: 403,
    defaultFix: 'Confirm it is you with a code from your authenticator (POST /api/auth/step-up), then retry within ten minutes.',
  },
  group_stopped: { gate: 'none', httpStatus: 409, defaultFix: 'Fix the failed member, then deploy the group again; members after it were not touched.' },
  rollout_stopped: { gate: 'none', httpStatus: 409, defaultFix: 'Fix the member that stopped the rollout, then roll again; the apps after it were not touched.' },
};

export const Refusal = z
  .strictObject({
    code: ErrorCode,
    gate: Gate,
    message: z.string().min(1),
    fix: z.string().min(1),
  })
  .meta({ id: 'Refusal', description: 'Every refusal carries a code, the gate, a message and a fix (SHP-REQ-031)' });
export type Refusal = z.infer<typeof Refusal>;

export const ErrorEnvelope = z
  .strictObject({
    error: Refusal,
  })
  .meta({ id: 'ErrorEnvelope', description: 'The body of every non-2xx API response' });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Builds a Refusal, filling gate and (unless overridden) fix from the catalogue. */
export function refusal(code: ErrorCode, message: string, fix?: string): Refusal {
  const entry = CATALOGUE[code];
  return {
    code,
    gate: entry.gate,
    message,
    fix: fix ?? entry.defaultFix,
  };
}
