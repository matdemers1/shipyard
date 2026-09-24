import type { Manifest } from '@shipyard/schema';

import type { ComposeTarget, DockerPort, Log } from './ports.js';

/**
 * The free-space gate's pruning (SHP-T-1.11, SHP-REQ-028, SHP-REQ-086). The disk has filled up on
 * this host before (SHP-D-083): before the `disk` gate can refuse a deploy, the agent first prunes
 * images it knows about — only the ones local to the manifest's own mapped repositories — and never
 * touches a running image, a digest the ledger still needs, or another app's image. `evaluateGates`
 * (`gates.ts`) turns the resulting `freeBytes` into the `insufficient_disk` refusal; this module only
 * decides what may be pruned and does the pruning.
 */

export interface LocalImage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  created: number;
  size: number;
}

export interface PruneCandidateOptions {
  /** Digests the ledger still needs (recent releases) — never pruned. */
  keepDigests: Set<string>;
  /** Image IDs currently backing a running container — never pruned. */
  runningImageIds: Set<string>;
  /** How many of the newest (by `created`) otherwise-eligible images to keep. */
  retain: number;
}

/**
 * Pure: from one repository's local images, the ones that are safe to prune — not running, not in
 * `keepDigests`, and beyond the newest `retain`. Returned oldest-first, the order pruning should
 * happen in so the newest surviving images are always the last ones touched.
 */
export function pruneCandidates(images: LocalImage[], opts: PruneCandidateOptions): LocalImage[] {
  const eligible = images.filter(
    (image) => !opts.runningImageIds.has(image.id) && !image.repoDigests.some((digest) => opts.keepDigests.has(digest)),
  );
  const newestFirst = [...eligible].sort((a, b) => b.created - a.created);
  const beyondRetain = newestFirst.slice(opts.retain);
  return beyondRetain.toReversed();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface DiskPorts {
  docker: DockerPort;
  log: Log;
}

/** service.image repos, de-duplicated, in the manifest's own declaration order. */
function mappedRepos(manifest: Manifest): string[] {
  return [...new Set(Object.values(manifest.services).map((service) => service.image))];
}

async function runningDigestsFor(docker: DockerPort, target: ComposeTarget): Promise<Set<string>> {
  const containers = await docker.containers(target);
  const digests = new Set<string>();
  for (const container of containers) {
    for (const digest of container.repoDigests) digests.add(digest);
  }
  return digests;
}

/** Candidates for one repo, given the digests currently running anywhere in the target. */
function candidatesForRepo(images: LocalImage[], runningDigests: Set<string>, keepDigests: Set<string>, retain: number): LocalImage[] {
  const runningImageIds = new Set(images.filter((image) => image.repoDigests.some((digest) => runningDigests.has(digest))).map((image) => image.id));
  return pruneCandidates(images, { keepDigests, runningImageIds, retain });
}

/**
 * SHP-REQ-028: reads free space, and if it is below the manifest's floor, prunes Shipyard-known
 * images — oldest candidate first, per mapped repo — re-measuring after each removal and stopping
 * as soon as the floor is cleared. Never removes a running image, a `keepDigests` entry, or an
 * image outside the manifest's mapped repos (each repo is read from Docker one at a time, so a
 * foreign image is never even considered). A failed removal is logged and skipped.
 */
export async function ensureFreeSpace(
  ports: DiskPorts,
  manifest: Manifest,
  target: ComposeTarget,
  keepDigests: Set<string>,
): Promise<{ freeBytes: number; pruned: string[] }> {
  const floorBytes = manifest.diskFloorGb * 1024 ** 3;
  let freeBytes = await ports.docker.freeBytes();
  const pruned: string[] = [];
  if (freeBytes >= floorBytes) {
    return { freeBytes, pruned };
  }

  const runningDigests = await runningDigestsFor(ports.docker, target);

  for (const repo of mappedRepos(manifest)) {
    if (freeBytes >= floorBytes) break;
    const images = await ports.docker.images(repo);
    const candidates = candidatesForRepo(images, runningDigests, keepDigests, manifest.retainImages);
    for (const candidate of candidates) {
      if (freeBytes >= floorBytes) break;
      try {
        await ports.docker.removeImage(candidate.id);
        pruned.push(candidate.id);
      } catch (err) {
        ports.log.warn({ repo, id: candidate.id, err: errMessage(err) }, 'failed to prune image while clearing space for the disk gate');
        continue;
      }
      freeBytes = await ports.docker.freeBytes();
    }
  }

  return { freeBytes, pruned };
}

/**
 * SHP-REQ-086: after a successful deploy, removes each mapped repo's images beyond the manifest's
 * `retainImages`, never a running image or a `keepDigests` entry. Unlike `ensureFreeSpace` this is
 * not stopped early by free space — it always trims down to the retained count.
 */
export async function pruneAfterSuccess(ports: DiskPorts, manifest: Manifest, target: ComposeTarget, keepDigests: Set<string>): Promise<{ pruned: string[] }> {
  const pruned: string[] = [];
  const runningDigests = await runningDigestsFor(ports.docker, target);

  for (const repo of mappedRepos(manifest)) {
    const images = await ports.docker.images(repo);
    const candidates = candidatesForRepo(images, runningDigests, keepDigests, manifest.retainImages);
    for (const candidate of candidates) {
      try {
        await ports.docker.removeImage(candidate.id);
        pruned.push(candidate.id);
      } catch (err) {
        ports.log.warn({ repo, id: candidate.id, err: errMessage(err) }, 'failed to prune image after a successful deploy');
      }
    }
  }

  return { pruned };
}
