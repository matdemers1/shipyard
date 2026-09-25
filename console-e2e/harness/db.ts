// The server's own Prisma client and password hashing, by relative path: the harness writes rows
// exactly as the server would read them, with no second copy of the schema and no new dependency.
import { createDb, type Db } from '../../apps/server/src/db.js';
import { databaseUrl } from './env.js';

export type { Db };
export { hashPassword } from '../../apps/server/src/auth/passwords.js';

/** A client on the harness's test database. Disconnect it when done. */
export function openDb(): Db {
  return createDb(databaseUrl());
}

/** Opens a client, runs `work`, and always disconnects. */
export async function withDb<T>(work: (db: Db) => Promise<T>): Promise<T> {
  const db = openDb();
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}
