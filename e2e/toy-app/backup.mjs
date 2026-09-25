// The toy app's backup step (SHP-T-5.6), exec'd in its running container by the manifest's
// `steps.backup` argv: copies /data/state.json to a new, uniquely named file under /backups.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';

const target = `/backups/toy-${String(Date.now())}.json`;
if (existsSync('/data/state.json')) copyFileSync('/data/state.json', target);
else writeFileSync(target, JSON.stringify({ schema: null }));
console.log(`toy-backup: wrote ${target}`);
