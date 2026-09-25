import { refusal } from '@shipyard/schema';
import type { Manifest, Refusal } from '@shipyard/schema';

import type { ComposeTarget, DockerPort } from './ports.js';
import { LABEL_REVISION, LABEL_SCHEMA } from './types.js';
import type { VerifiedImage } from './types.js';

/**
 * The post-swap check (SHP-REQ-015), used by both `check` and every `soak` tick (SHP-REQ-025).
 * A target is checked only when each mapped service's running container is on the verified digest,
 * carries the SHA as its revision label, and the app's /health answers 2xx, says ok, and reports a
 * schema revision that matches the expected one when there is one.
 */

export type CheckOutcome =
  | { ok: true; schema: string }
  | {
      ok: false;
      refusal: Refusal;
      /**
       * True when polling again cannot change the answer (a running container on the wrong digest,
       * the wrong revision label, or a healthy app on the wrong schema). A health endpoint that is
       * not answering yet is not definitive.
       */
      definitive: boolean;
    };

/** `{ ok: true }` or `{ status: 'ok' }` (case-insensitive). */
export function healthSaysOk(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  if (record['ok'] === true) return true;
  const status = record['status'];
  return typeof status === 'string' && status.trim().toLowerCase() === 'ok';
}

/** The schema revision a /health body reports (`schema` or `schemaRevision`), or null. */
export function reportedSchema(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ['schema', 'schemaRevision']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** The schema /health must report: the manifest's `expectSchema`, else the release's schema label. */
export function expectedSchema(manifest: Manifest, images: VerifiedImage[]): string | null {
  if (manifest.health.expectSchema !== undefined) return manifest.health.expectSchema;
  const healthImage = images.find((image) => image.service === manifest.health.service);
  const fromHealth = healthImage?.labels[LABEL_SCHEMA];
  if (fromHealth !== undefined && fromHealth.length > 0) return fromHealth;
  for (const image of images) {
    const label = image.labels[LABEL_SCHEMA];
    if (label !== undefined && label.length > 0) return label;
  }
  return null;
}

/**
 * The service → digest running now for each mapped service (null when none is running, or when
 * the running image has no digest for the mapped repository).
 */
export async function runningDigests(
  docker: DockerPort,
  target: ComposeTarget,
  services: Record<string, { image: string }>,
): Promise<Record<string, string | null>> {
  const containers = await docker.containers(target);
  const running: Record<string, string | null> = {};
  for (const [service, config] of Object.entries(services)) {
    const prefix = `${config.image}@`;
    const container = containers.find((c) => c.service === service && c.state === 'running');
    const repoDigest = container?.repoDigests.find((d) => d.startsWith(prefix));
    running[service] = repoDigest === undefined ? null : repoDigest.slice(prefix.length);
  }
  return running;
}

export interface CheckOptions {
  /** Per-probe timeout. */
  probeTimeoutMs: number;
}

/** One pass of the check. Never throws for a probe failure; the caller decides whether to poll. */
export async function checkOnce(
  docker: DockerPort,
  target: ComposeTarget,
  manifest: Manifest,
  images: VerifiedImage[],
  options: CheckOptions,
): Promise<CheckOutcome> {
  for (const image of images) {
    let running;
    try {
      running = (await docker.containers(target, image.service)).filter((c) => c.state === 'running');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, definitive: false, refusal: refusal('health_failed', `Could not list containers for "${image.service}": ${message}`) };
    }
    if (running.length === 0) {
      return { ok: false, definitive: false, refusal: refusal('health_failed', `No running container for service "${image.service}".`) };
    }
    const expectedDigest = `${image.repo}@${image.digest}`;
    for (const container of running) {
      if (!container.repoDigests.includes(expectedDigest)) {
        const seen = container.repoDigests.length > 0 ? container.repoDigests.join(', ') : 'no digest';
        return {
          ok: false,
          definitive: true,
          refusal: refusal('digest_mismatch', `Service "${image.service}" is running ${seen}, not the verified ${expectedDigest}.`),
        };
      }
      const revision = container.labels[LABEL_REVISION];
      if (revision !== image.sha) {
        return {
          ok: false,
          definitive: true,
          refusal: refusal(
            'revision_mismatch',
            `Service "${image.service}" carries ${LABEL_REVISION}=${revision ?? '(none)'}, not ${image.sha}.`,
          ),
        };
      }
    }
  }

  const { service, port, path } = manifest.health;
  let response;
  try {
    response = await docker.probeHealth(target, service, port, path, options.probeTimeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, definitive: false, refusal: refusal('health_failed', `GET ${path} on ${service}:${port} failed: ${message}`) };
  }
  if (response.httpStatus < 200 || response.httpStatus > 299) {
    return { ok: false, definitive: false, refusal: refusal('health_failed', `GET ${path} on ${service}:${port} answered HTTP ${response.httpStatus}.`) };
  }
  if (!healthSaysOk(response.body)) {
    return { ok: false, definitive: false, refusal: refusal('health_failed', `GET ${path} on ${service}:${port} answered without saying ok.`) };
  }
  const schema = reportedSchema(response.body);
  if (schema === null) {
    return { ok: false, definitive: false, refusal: refusal('health_failed', `GET ${path} on ${service}:${port} reported no schema revision.`) };
  }
  const expected = expectedSchema(manifest, images);
  if (expected !== null && schema !== expected) {
    return {
      ok: false,
      definitive: true,
      refusal: refusal('schema_mismatch', `GET ${path} reported schema ${schema}; the release expects ${expected}.`),
    };
  }
  return { ok: true, schema };
}
