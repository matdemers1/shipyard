import { AppName, Sha40 } from '@shipyard/schema';

/**
 * `shipyard-run` argument parsing (SHP-T-1.12). Pure and port-free: a bad app name or SHA is
 * rejected here, before any adapter is built, so the CLI never touches Docker, GitHub or the
 * registry over an invalid request.
 */

export interface DeployCommand {
  kind: 'deploy';
  app: string;
  sha: string;
  dryRun: boolean;
  label: string | undefined;
  json: boolean;
}

export interface StatusCommand {
  kind: 'status';
  app: string;
}

export interface RecoverCommand {
  kind: 'recover';
}

export interface CheckManifestsCommand {
  kind: 'check-manifests';
}

export interface HelpCommand {
  kind: 'help';
}

export type Command = DeployCommand | StatusCommand | RecoverCommand | CheckManifestsCommand | HelpCommand;

export type ParseResult = { ok: true; command: Command } | { ok: false; message: string };

export const USAGE = `Usage:
  shipyard-run deploy <app> <sha> [--dry-run] [--label <text>] [--json]
  shipyard-run status <app>
  shipyard-run recover
  shipyard-run check-manifests
  shipyard-run --help`;

function parseApp(app: string): { ok: true; value: string } | { ok: false; message: string } {
  const result = AppName.safeParse(app);
  if (!result.success) return { ok: false, message: `invalid app "${app}": ${result.error.issues[0]?.message ?? 'invalid'}` };
  return { ok: true, value: result.data };
}

function parseSha(sha: string): { ok: true; value: string } | { ok: false; message: string } {
  const result = Sha40.safeParse(sha);
  if (!result.success) return { ok: false, message: `invalid sha "${sha}": ${result.error.issues[0]?.message ?? 'invalid'}` };
  return { ok: true, value: result.data };
}

function parseDeploy(rest: string[]): ParseResult {
  const positionals: string[] = [];
  let dryRun = false;
  let json = false;
  let label: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--label') {
      const value = rest[i + 1];
      if (value === undefined) return { ok: false, message: '--label requires a value' };
      label = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      return { ok: false, message: `unknown option "${arg}"` };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 2) {
    return { ok: false, message: `deploy requires <app> <sha>\n\n${USAGE}` };
  }
  const [app, sha] = positionals as [string, string];
  const appResult = parseApp(app);
  if (!appResult.ok) return appResult;
  const shaResult = parseSha(sha);
  if (!shaResult.ok) return shaResult;

  return { ok: true, command: { kind: 'deploy', app: appResult.value, sha: shaResult.value, dryRun, label, json } };
}

function parseStatus(rest: string[]): ParseResult {
  if (rest.length !== 1) return { ok: false, message: `status requires <app>\n\n${USAGE}` };
  const appResult = parseApp(rest[0] as string);
  if (!appResult.ok) return appResult;
  return { ok: true, command: { kind: 'status', app: appResult.value } };
}

/** Parses argv (already stripped of `node`/script). Never touches env or ports. */
export function parseArgs(argv: string[]): ParseResult {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    return { ok: true, command: { kind: 'help' } };
  }

  switch (cmd) {
    case 'deploy':
      return parseDeploy(rest);
    case 'status':
      return parseStatus(rest);
    case 'recover':
      return rest.length === 0 ? { ok: true, command: { kind: 'recover' } } : { ok: false, message: 'recover takes no arguments' };
    case 'check-manifests':
      return rest.length === 0 ? { ok: true, command: { kind: 'check-manifests' } } : { ok: false, message: 'check-manifests takes no arguments' };
    default:
      return { ok: false, message: `unknown command "${cmd}"\n\n${USAGE}` };
  }
}
