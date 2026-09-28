// The toy app's test target (SHP-T-7.16), run by a Shipyard build as the Dockerfile `test` stage's
// RUN step. Everything it reacts to is a file in the source tree, because a Shipyard build passes
// no build args:
//   TOY_TEST_FAIL  present → the tests fail (exit 1), so nothing may be pushed
//   probes.json    ["http://…", …] → each URL is fetched once and the outcome printed, so a test
//                  can read from the build log what a RUN step could and could not reach
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
console.log('TOY-TEST start');

const probesFile = join(here, 'probes.json');
const probes = existsSync(probesFile) ? JSON.parse(readFileSync(probesFile, 'utf8')) : [];
for (const url of probes) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    console.log(`TOY-PROBE ${url} reached ${res.status}`);
  } catch (err) {
    const code = err?.cause?.code ?? err?.name ?? 'error';
    console.log(`TOY-PROBE ${url} blocked ${code}`);
  }
}

if (existsSync(join(here, 'TOY_TEST_FAIL'))) {
  console.log('TOY-TEST fail');
  process.exit(1);
}
console.log('TOY-TEST pass');
