import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { networkInterfaces } from 'node:os';

/**
 * supertest serves an app with `listen(0)`, which binds `::` (dual-stack), then dials
 * `127.0.0.1:<port>`. When another process holds that port on IPv4 loopback only — Docker
 * Desktop's port forwards do, constantly — the kernel hands the connection to *that* process, and a
 * correct test sees a stray registry 401 or a 404/501 at random. Dialling `[::1]` reaches the
 * dual-stack listener supertest bound and nothing else. Test-only; the server is unchanged.
 */
interface SupertestTest {
  prototype: { serverAddress: (this: { _server?: Server }, app: Server, path: string) => string };
}
const require = createRequire(import.meta.url);
// Only where the machine has an IPv6 loopback; otherwise supertest's own 127.0.0.1 is kept.
const hasIpv6Loopback = Object.values(networkInterfaces()).some((list) =>
  (list ?? []).some((i) => i.internal && i.family === 'IPv6' && i.address === '::1'),
);
const HOST = hasIpv6Loopback ? '[::1]' : '127.0.0.1';
const Test = require('supertest/lib/test.js') as SupertestTest;

Test.prototype.serverAddress = function serverAddress(this: { _server?: Server }, app: Server, path: string): string {
  if (app.address() === null) this._server = app.listen(0);
  const address = app.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://${HOST}:${String(port)}${path}`;
};
