// The toy app Shipyard deploys in e2e. Behaviour is fixed at build time (see Dockerfile):
//   TOY_MODE      pass | fail-health | wrong-schema | fail-migrate | exit-mid | print-secret
//   TOY_SCHEMA    the schema revision /health reports
//   TOY_REVISION  the 40-hex commit this image claims to be (also the OCI revision label)
import { createServer } from 'node:http';

export const MODES = ['pass', 'fail-health', 'wrong-schema', 'fail-migrate', 'exit-mid', 'print-secret'];

const mode = process.env.TOY_MODE ?? 'pass';
const schema = process.env.TOY_SCHEMA ?? '0';
const revision = process.env.TOY_REVISION ?? '';
const port = Number(process.env.PORT ?? '3000');

if (!MODES.includes(mode)) {
  console.error(`toy: unknown TOY_MODE ${JSON.stringify(mode)}`);
  process.exit(2);
}

if (mode === 'print-secret') {
  // Deliberately leaks, so redaction of step/container output can be tested.
  console.log(`toy: TOY_SECRET=${process.env.TOY_SECRET ?? ''}`);
}

if (mode === 'exit-mid') {
  const after = Number(process.env.TOY_EXIT_AFTER_MS ?? '3000');
  setTimeout(() => {
    console.error('toy: exit-mid, exiting 1');
    process.exit(1);
  }, after);
}

function reportedSchema() {
  return mode === 'wrong-schema' ? `${schema}-wrong` : schema;
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    if (mode === 'fail-health') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'unavailable', schemaRevision: reportedSchema() }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', schemaRevision: reportedSchema() }));
    return;
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'toy', mode, revision }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, () => {
  console.log(`toy: listening on ${port} mode=${mode} schema=${schema} revision=${revision}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
