import { z } from 'zod';

/**
 * Server configuration, parsed once at startup (SHP-T-0.4). A bad env fails fast with a clear
 * message rather than surfacing as a confusing runtime error later.
 */
export const Config = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3300),
  PUBLIC_URL: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(1).optional(),
  LOG_LEVEL: z.string().min(1).default('info'),
  SHIPYARD_VERSION: z.string().min(1).default('dev'),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse(env);
}
