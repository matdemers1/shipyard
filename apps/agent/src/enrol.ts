import type { AgentClient } from './client.js';
import type { AgentIdentity } from './identity.js';

/**
 * Enrolment (SHP-REQ-035; SHP-D-064). The agent presents its public key; the server records it
 * unconfirmed until a deployer types this fingerprint into the console. Until then every other
 * agent request is refused with `not_enrolled`, so the agent logs the fingerprint where the
 * operator on the host can read it, and waits.
 */

export const ENROL_PATH = '/api/agent/enrol';
export const CONFIRM_INSTRUCTION = 'confirm this fingerprint in the Shipyard console';

/** The slice of a pino logger this module uses. */
export interface EnrolLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface EnrolResult {
  confirmed: boolean;
}

function parseEnrolResponse(body: unknown, identity: AgentIdentity): EnrolResult {
  if (typeof body !== 'object' || body === null || !('confirmed' in body) || typeof body.confirmed !== 'boolean') {
    throw new Error(`${ENROL_PATH} returned an unexpected body`);
  }
  if ('fingerprint' in body && body.fingerprint !== identity.fingerprint) {
    throw new Error(`${ENROL_PATH} answered for a different fingerprint than this agent's`);
  }
  return { confirmed: body.confirmed };
}

/** Presents this agent's key once. When unconfirmed, logs the fingerprint for the operator to compare. */
export async function ensureEnrolled(
  client: AgentClient,
  identity: AgentIdentity,
  agentVersion: string,
  log: EnrolLog,
): Promise<EnrolResult> {
  const body = await client.request('POST', ENROL_PATH, { publicKey: identity.publicKeyB64, agentVersion });
  const result = parseEnrolResponse(body, identity);
  if (result.confirmed) {
    log.info({ fingerprint: identity.fingerprint }, 'agent enrolled and confirmed');
  } else {
    log.warn(
      { fingerprint: identity.fingerprint },
      `AGENT NOT YET CONFIRMED: ${CONFIRM_INSTRUCTION}. Fingerprint: ${identity.fingerprint}`,
    );
  }
  return result;
}

export interface WaitOptions {
  /** First delay between attempts. */
  initialDelayMs?: number;
  /** The delay doubles up to this cap. */
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enrols, then retries with capped exponential backoff until an operator confirms the fingerprint.
 * A failed attempt (network, 429) is logged and retried like an unconfirmed one.
 */
export async function waitForConfirmation(
  client: AgentClient,
  identity: AgentIdentity,
  agentVersion: string,
  log: EnrolLog,
  opts: WaitOptions = {},
): Promise<void> {
  const initial = opts.initialDelayMs ?? 5_000;
  const cap = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  let delay = initial;
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      const { confirmed } = await ensureEnrolled(client, identity, agentVersion, log);
      if (confirmed) return;
    } catch (err) {
      log.warn({ err }, 'enrolment attempt failed; retrying');
    }
    await sleep(delay);
    delay = Math.min(delay * 2, cap);
  }
}
