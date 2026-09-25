import { z } from 'zod';

import { AppName } from './primitives.js';

/**
 * Freeze API contracts (SHP-T-5.1, SHP-REQ-077). While an app is frozen the server refuses new
 * deploys with the freeze reason; rollbacks and restores stay allowed (SHP-D-049).
 */

export const FreezeReason = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, 'must be printable characters on one line')
  .meta({ id: 'FreezeReason', description: 'Why the app is frozen, shown in every deploy refusal while it is' });
export type FreezeReason = z.infer<typeof FreezeReason>;

export const FreezeRequest = z
  .strictObject({
    reason: FreezeReason,
    /** ISO datetime; must be in the future. Omitted, the freeze lasts until explicitly cleared. */
    until: z.iso.datetime().optional(),
  })
  .meta({ id: 'FreezeRequest', description: 'POST /api/apps/:app/freeze body' });
export type FreezeRequest = z.infer<typeof FreezeRequest>;

export const Freeze = z
  .strictObject({
    id: z.uuid(),
    app: AppName,
    reason: FreezeReason,
    by: z.string().min(1),
    from: z.iso.datetime(),
    until: z.iso.datetime().nullable(),
    clearedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Freeze', description: 'A freeze on an app, active or cleared' });
export type Freeze = z.infer<typeof Freeze>;

export const FreezeInfo = z
  .strictObject({
    reason: FreezeReason,
    by: z.string().min(1),
    from: z.iso.datetime(),
    until: z.iso.datetime().nullable(),
  })
  .meta({ id: 'FreezeInfo', description: "An app's active freeze, as shown on its detail page" });
export type FreezeInfo = z.infer<typeof FreezeInfo>;
