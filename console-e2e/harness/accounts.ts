import type { Db } from './db.js';
import { reseedWorld, wipeAll } from './seed.js';

/**
 * A world with no account at all, for first-run setup (SHP-REQ-109) — and the way back.
 *
 * Every other spec starts signed in from the `storageState` files global setup wrote, which name
 * sessions in the database. Emptying the `user` table would end them. So the accounts, identities
 * and sessions are copied out first and written back verbatim afterwards — same IDs, same session
 * token hashes — and the saved browser states stay valid without signing anyone in again.
 */

export interface AccountsSnapshot {
  users: Awaited<ReturnType<Db['user']['findMany']>>;
  identities: Awaited<ReturnType<Db['identity']['findMany']>>;
  sessions: Awaited<ReturnType<Db['session']['findMany']>>;
}

/** Copies the accounts out, then empties the whole database: the server has no account now. */
export async function enterZeroUserWorld(db: Db): Promise<AccountsSnapshot> {
  const snapshot: AccountsSnapshot = {
    users: await db.user.findMany(),
    identities: await db.identity.findMany(),
    sessions: await db.session.findMany(),
  };
  await wipeAll(db);
  return snapshot;
}

/**
 * Empties the database again (whatever the test created goes), writes the saved accounts back, and
 * reseeds the baseline world around them.
 */
export async function restoreAccounts(db: Db, snapshot: AccountsSnapshot): Promise<void> {
  await wipeAll(db);
  await db.user.createMany({ data: snapshot.users });
  await db.identity.createMany({ data: snapshot.identities });
  await db.session.createMany({ data: snapshot.sessions });
  await reseedWorld(db);
}
