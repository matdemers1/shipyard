import http from 'node:http';

/**
 * The image HEALTHCHECK script (SHP-T-0.8). Plain `http` rather than a dependency: this runs
 * inside the running container with no dev tooling available, just `node dist/healthcheck.js`.
 */
const port = process.env['PORT'] ?? '3300';

const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});

req.on('error', () => {
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
