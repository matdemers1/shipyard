import { z } from 'zod';

/**
 * Shared primitive types (SHP-REQ-004). Kept transform/refinement-free so they
 * remain plain Zod that z.toJSONSchema can render for the OpenAPI document
 * generated in SHP-T-0.7.
 */

export const AppName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric and hyphens, starting alphanumeric, max 63 chars')
  .meta({ id: 'AppName', description: 'Host-local compose app identifier' });

export const Sha40 = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'exactly 40 lowercase hex characters')
  .meta({ id: 'Sha40', description: 'Full lowercase git commit SHA' });

export const ImageTag = z
  .string()
  .regex(/^sha-[0-9a-f]{40}$/, 'sha-<40 lowercase hex characters>')
  .meta({ id: 'ImageTag', description: 'GHCR image tag derived from a commit SHA' });

export const Digest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'sha256:<64 lowercase hex characters>')
  .meta({ id: 'Digest', description: 'OCI content digest' });

export const GhRepo = z
  .string()
  .regex(/^[^\s/]+\/[^\s/]+$/, 'owner/name')
  .meta({ id: 'GhRepo', description: 'GitHub repository in owner/name form' });

export const ProjectCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,7}$/, 'uppercase code, 2-8 characters, starting with a letter')
  .meta({ id: 'ProjectCode', description: 'Foreman project code' });

export const Argv = z
  .array(z.string())
  .min(1, 'argv must not be empty')
  .meta({ id: 'Argv', description: 'Argument vector run in a named compose service; never a shell string' });

export const Step = z
  .strictObject({
    service: z.string().min(1),
    argv: Argv,
  })
  .meta({ id: 'Step', description: 'A journaled step run in a named compose service' });

export type AppName = z.infer<typeof AppName>;
export type Sha40 = z.infer<typeof Sha40>;
export type ImageTag = z.infer<typeof ImageTag>;
export type Digest = z.infer<typeof Digest>;
export type GhRepo = z.infer<typeof GhRepo>;
export type ProjectCode = z.infer<typeof ProjectCode>;
export type Argv = z.infer<typeof Argv>;
export type Step = z.infer<typeof Step>;
