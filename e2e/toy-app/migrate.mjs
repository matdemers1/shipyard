// One-shot migration step, run by the manifest's `steps.migrate` argv in the app's image.
import { existsSync, writeFileSync } from 'node:fs';

const mode = process.env.TOY_MODE ?? 'pass';
const schema = process.env.TOY_SCHEMA ?? '0';

if (mode === 'fail-migrate') {
  console.error(`toy-migrate: failing on purpose (schema ${schema})`);
  process.exit(1);
}
// When the stack mounts a data directory (the restore e2e), the migration leaves its mark there,
// so a backup and a restore of that data can be observed.
if (existsSync('/data')) writeFileSync('/data/state.json', JSON.stringify({ schema }));
console.log(`toy-migrate: migrated to schema ${schema}`);
