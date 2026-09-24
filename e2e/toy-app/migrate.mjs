// One-shot migration step, run by the manifest's `steps.migrate` argv in the app's image.
const mode = process.env.TOY_MODE ?? 'pass';
const schema = process.env.TOY_SCHEMA ?? '0';

if (mode === 'fail-migrate') {
  console.error(`toy-migrate: failing on purpose (schema ${schema})`);
  process.exit(1);
}
console.log(`toy-migrate: migrated to schema ${schema}`);
