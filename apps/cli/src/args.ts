import { AppName, BuildName, Sha40 } from '@shipyard/schema';

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

/**
 * `build-secret set|delete|list` (SHP-T-7.9, SHP-REQ-125): manages the agent's encrypted build
 * secrets. `set` reads the value from stdin only — never argv, which lands in shell history and in
 * every process listing on the host.
 */
export type BuildSecretCommand =
  | { kind: 'build-secret'; action: 'set'; app: string; name: string }
  | { kind: 'build-secret'; action: 'delete'; app: string; name: string }
  | { kind: 'build-secret'; action: 'list'; app: string };

export type Command = DeployCommand | StatusCommand | RecoverCommand | CheckManifestsCommand | BuildSecretCommand | HelpCommand;

export type ParseResult = { ok: true; command: Command } | { ok: false; message: string };

export const USAGE = `Usage:
  shipyard-run deploy <app> <sha> [--dry-run] [--label <text>] [--json]
  shipyard-run status <app>
  shipyard-run recover
  shipyard-run check-manifests
  shipyard-run build-secret set <app> <name>      (the value is read from stdin)
  shipyard-run build-secret delete <app> <name>
  shipyard-run build-secret list <app>
  shipyard-run --help`;

/** Why `build-secret set` refuses anything after the name. */
export const SECRET_ON_ARGV =
  'build-secret set takes the value on stdin only, never as an argument: an argument is kept in shell history and is visible to every process on the host. Pipe it or type it: printf %s "$TOKEN" | shipyard-run build-secret set <app> <name>';

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

function parseSecretName(name: string): { ok: true; value: string } | { ok: false; message: string } {
  const result = BuildName.safeParse(name);
  // The name is not echoed: when someone passes a value where the name goes, it must not be printed.
  if (!result.success) return { ok: false, message: `invalid secret name: ${result.error.issues[0]?.message ?? 'invalid'}` };
  return { ok: true, value: result.data };
}

function parseBuildSecret(rest: string[]): ParseResult {
  const [action, ...args] = rest;
  if (action === 'set' && args.length > 2) {
    // Refused before anything is parsed further: the extra argument is almost certainly the value.
    return { ok: false, message: SECRET_ON_ARGV };
  }
  if (args.some((a) => a.startsWith('-'))) {
    return action === 'set' ? { ok: false, message: SECRET_ON_ARGV } : { ok: false, message: `build-secret takes no options\n\n${USAGE}` };
  }
  if (action === 'list') {
    if (args.length !== 1) return { ok: false, message: `build-secret list requires <app>\n\n${USAGE}` };
    const app = parseApp(args[0] as string);
    if (!app.ok) return app;
    return { ok: true, command: { kind: 'build-secret', action: 'list', app: app.value } };
  }
  if (action === 'set' || action === 'delete') {
    if (args.length !== 2) return { ok: false, message: `build-secret ${action} requires <app> <name>\n\n${USAGE}` };
    const app = parseApp(args[0] as string);
    if (!app.ok) return app;
    const name = parseSecretName(args[1] as string);
    if (!name.ok) return name;
    return { ok: true, command: { kind: 'build-secret', action, app: app.value, name: name.value } };
  }
  return { ok: false, message: `build-secret requires set, delete or list\n\n${USAGE}` };
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
    case 'build-secret':
      return parseBuildSecret(rest);
    case 'check-manifests':
      return rest.length === 0 ? { ok: true, command: { kind: 'check-manifests' } } : { ok: false, message: 'check-manifests takes no arguments' };
    default:
      return { ok: false, message: `unknown command "${cmd}"\n\n${USAGE}` };
  }
}
