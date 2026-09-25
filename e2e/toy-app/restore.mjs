// The toy app's restore step (SHP-T-5.6), exec'd in its running container by the manifest's
// `steps.restore` argv, with the artifact's file name substituted into its path argument:
//   node restore.mjs /backups/{artifact}
import { copyFileSync, existsSync } from 'node:fs';

const from = process.argv[2];
if (from === undefined || !from.startsWith('/backups/') || !existsSync(from)) {
  console.error(`toy-restore: no such backup ${String(from)}`);
  process.exit(1);
}
copyFileSync(from, '/data/state.json');
console.log(`toy-restore: restored /data/state.json from ${from}`);
