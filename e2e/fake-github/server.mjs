// A fake of the slice of the GitHub REST API Shipyard's agent uses, with in-memory state.
//   GET  /repos/:owner/:repo/actions/runs?head_sha=…
//   GET  /repos/:owner/:repo/compare/:base...:head
// Test control:
//   POST   /_control/state      replace the state (see logic.d.mts StateInput)
//   GET    /_control/requests   the API requests received so far
//   DELETE /_control/requests   forget them
import { createServer } from 'node:http';
import { emptyState, normalizeState, route } from './logic.mjs';

const port = Number(process.env.PORT ?? '8080');
let state = emptyState();
let requests = [];

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer((req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const path = url.split('?')[0];

  if (path === '/_control/state' && method === 'POST') {
    readBody(req)
      .then((text) => {
        try {
          state = normalizeState(JSON.parse(text));
          send(res, 204);
        } catch (err) {
          send(res, 400, { message: err instanceof Error ? err.message : String(err) });
        }
      })
      .catch((err) => send(res, 500, { message: String(err) }));
    return;
  }
  if (path === '/_control/state' && method === 'GET') return send(res, 200, state);
  if (path === '/_control/requests' && method === 'GET') return send(res, 200, requests);
  if (path === '/_control/requests' && method === 'DELETE') {
    requests = [];
    return send(res, 204);
  }

  requests.push({
    method,
    url,
    authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
    at: new Date().toISOString(),
  });
  const reply = route(state, method, url);
  send(res, reply.status, reply.body);
});

server.listen(port, () => console.log(`fake-github: listening on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
