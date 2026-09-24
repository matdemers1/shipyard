import { defineConfig } from 'prisma/config';

const url = process.env['DATABASE_URL'];
const shadowDatabaseUrl = process.env['SHADOW_DATABASE_URL'];

// `prisma generate` needs no database, so CI and image builds run without DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url ? { datasource: { url, ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}) } } : {}),
});
