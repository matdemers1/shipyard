import { z } from 'zod';

/**
 * First-run setup (SHP-REQ-109): while no account exists, the console creates the first admin in
 * the browser. Two steps — details, then an authenticator code — and nothing is written until the
 * code is confirmed.
 */

export const SETUP_MIN_PASSWORD_LENGTH = 12;

export const SetupStatus = z
  .strictObject({ available: z.boolean() })
  .meta({ id: 'SetupStatus', description: 'Whether first-run setup is open: true only while no account exists' });
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupStartRequest = z
  .strictObject({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(100),
    password: z.string().min(SETUP_MIN_PASSWORD_LENGTH).max(1024),
  })
  .meta({ id: 'SetupStartRequest', description: 'The first admin: email, display name and password' });
export type SetupStartRequest = z.infer<typeof SetupStartRequest>;

export const SetupStarted = z
  .strictObject({
    ticket: z.string().min(1),
    otpauthUri: z.string().startsWith('otpauth://'),
    secret: z.string().regex(/^[A-Z2-7]+=*$/, 'base32'),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'SetupStarted', description: 'The authenticator to enrol and the ticket that finishes setup' });
export type SetupStarted = z.infer<typeof SetupStarted>;

export const SetupCompleteRequest = z
  .strictObject({
    ticket: z.string().min(1).max(256),
    code: z.string().regex(/^[0-9]{6}$/, 'exactly 6 digits'),
  })
  .meta({ id: 'SetupCompleteRequest', description: 'Finishes first-run setup with a code from the new authenticator' });
export type SetupCompleteRequest = z.infer<typeof SetupCompleteRequest>;
