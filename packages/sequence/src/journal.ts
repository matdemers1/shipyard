import type { Clock, ComposeTarget, DockerPort, FsPort, Log } from './ports.js';
import type { JournalEntry } from './types.js';
import { restoreFromHistory } from './rewrite.js';

/**
 * The local deploy journal (SHP-REQ-021, SHP-REQ-022, SHP-T-1.9). Every step is appended
 * *before* it runs (SHP-D-029); on restart the agent never resumes forward — it rolls the app
 * back to the last verified-good compose file and marks the interrupted deploy `failed`
 * (SHP-D-081 covers syncing these lines to the server once reachable, out of scope here).
 *
 * Backed by a JSONL file: one `JournalEntry` per line, appended in order. A `deploy` step
 * brackets a whole deploy — its `start` line's `detail` carries `{ historyDeployId,
 * composeFiles, project }`, and its `end` line's `detail` carries `{ state, ... }`.
 */

export interface UnfinishedDeploy {
  deployId: string;
  app: string;
  /** The `detail` of the deploy's `start` line, e.g. `{ historyDeployId, composeFiles, project }`. */
  detail: Record<string, unknown> | undefined;
  /** The name of the last step that started without an end line, if any (e.g. `swap`). */
  lastStep: string | undefined;
}

export class Journal {
  constructor(
    private readonly fs: FsPort,
    private readonly path: string,
    private readonly clock: Clock,
    private readonly log: Log,
  ) {}

  /** Appends a `start` line. Resolves only once the append has been written. */
  async begin(entry: Omit<JournalEntry, 'phase' | 'at'>): Promise<void> {
    await this.append({ ...entry, phase: 'start', at: this.clock.now().toISOString() });
  }

  /** Appends an `end` line. Resolves only once the append has been written. */
  async end(entry: Omit<JournalEntry, 'phase' | 'at'>): Promise<void> {
    await this.append({ ...entry, phase: 'end', at: this.clock.now().toISOString() });
  }

  private async append(full: JournalEntry): Promise<void> {
    await this.fs.appendLine(this.path, JSON.stringify(full));
  }

  /**
   * All successfully-parsed entries, in file order. A torn last line (a crash mid-append) is
   * dropped and warned about, never thrown. Any other unparsable line is treated the same way,
   * since the journal must never block a restart.
   */
  async readAll(): Promise<JournalEntry[]> {
    return (await this.readLines()).entries;
  }

  /** The number of successfully-parsed lines currently in the journal (a sync cursor). */
  async cursor(): Promise<number> {
    return (await this.readLines()).validLineCount;
  }

  /** Entries appended since `sinceCursor`, and the cursor to resume from next time. */
  async pendingSync(sinceCursor: number): Promise<{ entries: JournalEntry[]; cursor: number }> {
    const { entries } = await this.readLines();
    return { entries: entries.slice(sinceCursor), cursor: entries.length };
  }

  private async readLines(): Promise<{ entries: JournalEntry[]; validLineCount: number }> {
    const exists = await this.fs.exists(this.path);
    if (!exists) return { entries: [], validLineCount: 0 };

    const raw = await this.fs.readFile(this.path);
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);

    const entries: JournalEntry[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch (err) {
        this.log.warn(
          { index, err: err instanceof Error ? err.message : String(err) },
          'journal: ignoring unparsable line (likely a torn write at a crash)',
        );
      }
    }
    return { entries, validLineCount: entries.length };
  }

  /**
   * Deploys with a `deploy` start line and no `deploy` end line, each with the name of the
   * last step that started without ending (SHP-REQ-022).
   */
  async unfinished(): Promise<UnfinishedDeploy[]> {
    const entries = await this.readAll();

    interface DeployState {
      app: string;
      detail: Record<string, unknown> | undefined;
      ended: boolean;
      /** Names of steps currently open, in the order they started (a stack). */
      openSteps: string[];
    }

    const deploys = new Map<string, DeployState>();
    const order: string[] = [];

    for (const entry of entries) {
      let state = deploys.get(entry.deployId);
      if (!state) {
        state = { app: entry.app, detail: undefined, ended: false, openSteps: [] };
        deploys.set(entry.deployId, state);
        order.push(entry.deployId);
      }

      if (entry.step === 'deploy') {
        if (entry.phase === 'start') {
          state.detail = entry.detail;
        } else {
          state.ended = true;
        }
        continue;
      }

      if (entry.phase === 'start') {
        state.openSteps.push(entry.step);
      } else {
        const lastIndex = state.openSteps.lastIndexOf(entry.step);
        if (lastIndex !== -1) state.openSteps.splice(lastIndex, 1);
      }
    }

    const unfinished: UnfinishedDeploy[] = [];
    for (const deployId of order) {
      const state = deploys.get(deployId);
      if (!state || state.ended) continue;
      unfinished.push({
        deployId,
        app: state.app,
        detail: state.detail,
        lastStep: state.openSteps.at(-1),
      });
    }
    return unfinished;
  }
}

// ─── Restart recovery (SHP-REQ-022) ──────────────────────────────────────────

export interface RecoverPorts {
  fs: FsPort;
  docker: DockerPort;
  log: Log;
  clock: Clock;
}

export interface RecoveryResult {
  deployId: string;
  app: string;
  restored: string[];
  upExitCode: number | null;
  lastStep: string | undefined;
  /** Present only when recovering this one deploy failed; the others still ran. */
  error?: string;
}

function historyManifestPath(historyDir: string, deployId: string): string {
  return `${historyDir}/${deployId}/manifest.json`;
}

function composeTargetFromDetail(detail: Record<string, unknown> | undefined): ComposeTarget | null {
  if (!detail) return null;
  const files = detail['composeFiles'];
  const project = detail['project'];
  if (!Array.isArray(files) || typeof project !== 'string') return null;
  if (!files.every((f): f is string => typeof f === 'string')) return null;
  return { files, project };
}

function historyDeployIdFromDetail(detail: Record<string, unknown> | undefined, fallback: string): string {
  const value = detail?.['historyDeployId'];
  return typeof value === 'string' ? value : fallback;
}

/**
 * Rolls each unfinished deploy back to its last verified-good compose file and marks it
 * interrupted (SHP-REQ-022, SHP-D-081). Never resumes forward. A failure recovering one deploy
 * is logged and reported; it does not stop the others.
 */
export async function recoverInterrupted(
  ports: RecoverPorts,
  journal: Journal,
  opts: { historyDir: string },
): Promise<RecoveryResult[]> {
  const unfinished = await journal.unfinished();
  const results: RecoveryResult[] = [];

  for (const deploy of unfinished) {
    try {
      results.push(await recoverOne(ports, journal, opts.historyDir, deploy));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ports.log.error({ deployId: deploy.deployId, app: deploy.app, err: message }, 'recovery failed for deploy');
      results.push({
        deployId: deploy.deployId,
        app: deploy.app,
        restored: [],
        upExitCode: null,
        lastStep: deploy.lastStep,
        error: message,
      });
    }
  }

  return results;
}

async function recoverOne(
  ports: RecoverPorts,
  journal: Journal,
  historyDir: string,
  deploy: UnfinishedDeploy,
): Promise<RecoveryResult> {
  const { fs, docker, log } = ports;

  await journal.begin({ deployId: deploy.deployId, app: deploy.app, step: 'recover' });

  const historyDeployId = historyDeployIdFromDetail(deploy.detail, deploy.deployId);
  const hasHistory = await fs.exists(historyManifestPath(historyDir, historyDeployId));
  const restored = hasHistory ? await restoreFromHistory(fs, historyDir, historyDeployId) : [];

  const target = composeTargetFromDetail(deploy.detail);
  let upExitCode: number | null = null;
  if (target) {
    const result = await docker.compose(target, ['up', '-d', '--remove-orphans']);
    upExitCode = result.exitCode;
  } else {
    log.warn({ deployId: deploy.deployId, app: deploy.app }, 'recovery: no compose target recorded, skipping "up"');
  }

  await journal.end(
    upExitCode === null
      ? { deployId: deploy.deployId, app: deploy.app, step: 'recover' }
      : { deployId: deploy.deployId, app: deploy.app, step: 'recover', exitCode: upExitCode },
  );
  await journal.end({
    deployId: deploy.deployId,
    app: deploy.app,
    step: 'deploy',
    detail: { state: 'failed', interrupted: true, lastStep: deploy.lastStep },
  });

  return { deployId: deploy.deployId, app: deploy.app, restored, upExitCode, lastStep: deploy.lastStep };
}
