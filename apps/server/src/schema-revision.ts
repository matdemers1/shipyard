import type { Db } from './db.js';

interface MigrationRow {
  migration_name: string;
}

/**
 * The applied migration name, for `GET /api/health` (SHP-T-0.4). Reads `_prisma_migrations`
 * directly rather than trusting a build-time constant, so health reflects what actually ran
 * against this database.
 */
export async function getSchemaRevision(db: Db): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<MigrationRow[]>`
      select migration_name
      from _prisma_migrations
      where finished_at is not null and rolled_back_at is null
      order by finished_at desc
      limit 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    // Table missing (a database that has never been migrated): not an error, just unknown.
    return null;
  }
}
