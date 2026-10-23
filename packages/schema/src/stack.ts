import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { AppName } from './primitives.js';
import { ComposeConfig } from './manifest.js';

/**
 * A third-party stack adopted into Shipyard's Operated tier (SHP-ADR-010). Written as YAML on the
 * host under `<data root>/stacks/<name>.yml`, apart from the D3 app manifests in `apps/`, so no
 * deploy code path ever reads one as an app. Adoption stays a host act (SHP-D-059): the agent only
 * acts on a stack a host-local file names.
 *
 * Until SHP-P-16 a stack takes lifecycle verbs only (`updates: none`); digest updates widen
 * `updates` and add per-service image tracking then. Strict: an unknown key is refused.
 */
export const StackManifest = z
  .strictObject({
    kind: z.literal('stack'),
    name: AppName,
    compose: ComposeConfig,
    /** Env files whose values are redacted from action output and logs (SHP-ADR-011). Absolute paths. */
    envFiles: z.array(z.string().regex(/^\//, 'env file paths must be absolute')).optional(),
    /** `none`: start, stop, restart and recreate only; something else (ZimaOS's app store, say) updates it. */
    updates: z.literal('none').default('none'),
  })
  .meta({ id: 'StackManifest', description: 'A host-local manifest adopting a third-party compose stack (SHP-ADR-010)' });
export type StackManifest = z.infer<typeof StackManifest>;

/** Parses a stack manifest YAML document, throwing a ZodError (or SyntaxError for bad YAML) on failure. */
export function parseStackManifestYaml(text: string): StackManifest {
  const parsed: unknown = parseYaml(text);
  return StackManifest.parse(parsed);
}

/** One adopted stack as the agent reports it. */
export const AgentStack = z
  .strictObject({
    manifest: StackManifest,
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters'),
  })
  .meta({ id: 'AgentStack', description: 'An adopted stack as reported by the agent' });
export type AgentStack = z.infer<typeof AgentStack>;
