import { execFile, spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RawResult extends RunResult {
  /** Exit code; null when the process was killed or could not start. */
  code: number | null;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

/** Run a program with an argv array and report how it exited. Never a shell, never a command string. */
export function runRaw(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RawResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 240_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr: error !== null && code === null ? `${stderr}${error.message}` : stderr });
      },
    );
  });
}

/** Run a program with an argv array; reject with its output if it does not exit 0. */
export async function run(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await runRaw(file, args, opts);
  if (r.code !== 0) {
    const detail = r.stderr.trim() || r.stdout.trim();
    throw new Error(`${file} ${args.join(' ')} exited ${String(r.code)}${detail ? `\n${detail}` : ''}`);
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

/** Poll `probe` until it resolves true or the deadline passes. A thrown probe counts as "not yet". */
export async function pollUntil(
  what: string,
  probe: () => Promise<boolean>,
  { timeoutMs = 120_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`timed out waiting for ${what}${reason}`);
}

/** `docker <from>` (in fromEnv) piped into `docker <to>` (in toEnv), e.g. save | load across daemons. */
export function pipe(
  from: readonly string[],
  fromEnv: NodeJS.ProcessEnv,
  to: readonly string[],
  toEnv: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const producer = spawn('docker', from, { env: fromEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const consumer = spawn('docker', to, { env: toEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const errs: string[] = [];
    producer.stderr.on('data', (c: Buffer) => errs.push(c.toString('utf8')));
    consumer.stderr.on('data', (c: Buffer) => errs.push(c.toString('utf8')));
    consumer.stdout.resume();
    producer.stdout.pipe(consumer.stdin);
    let pending = 2;
    let failed = false;
    const done = (who: string) => (code: number | null) => {
      if (code !== 0 && !failed) {
        failed = true;
        producer.kill();
        consumer.kill();
        reject(new Error(`docker ${who === 'from' ? from.join(' ') : to.join(' ')} exited ${String(code)}\n${errs.join('')}`));
      }
      pending -= 1;
      if (pending === 0 && !failed) resolve();
    };
    producer.on('error', reject);
    consumer.on('error', reject);
    producer.on('close', done('from'));
    consumer.on('close', done('to'));
  });
}
