# Install Shipyard on a host

Once, by hand (SHP-D-079). After this the server deploys itself through its own manifest (Phase 4);
the agent is upgraded by hand (`upgrade-agent.md`). The host needs only Docker Engine, Compose and a
data root — nothing here assumes ZimaOS (SHP-D-037). The paths below use `/DATA/shipyard` as the data
root; substitute your own.

> [!warning] Two things only a person does
> Creating the first account (`bootstrap-admin`) and confirming the agent's fingerprint are
> deliberate human acts. Nothing in this runbook signs in on your behalf.

## 1. Directory and secrets

```bash
mkdir -p /DATA/shipyard/apps /DATA/shipyard/agent && chmod 700 /DATA/shipyard
cd /DATA/shipyard && umask 077
```

Write four env files, all mode 600 (the compose file names them by absolute path, so it needs no
`${...}` — some host dashboards refuse a compose file that interpolates):

| File | Contents |
|---|---|
| `postgres.env` | `POSTGRES_USER=shipyard`, `POSTGRES_DB=shipyard`, `POSTGRES_PASSWORD=<random>` |
| `server.env` | `DATABASE_URL=postgresql://shipyard:<same>@postgres:5432/shipyard`, `PORT=3300`, `PUBLIC_URL=https://<host name>`, `SESSION_SECRET=<random 32 bytes hex>`, `TRUST_PROXY_HOPS=1` (behind a tunnel or proxy; omit otherwise), optional `FOREMAN_URL`/`FOREMAN_TOKEN` (a write-scoped Foreman token), optional `D3AUTH_ISSUER`/`D3AUTH_CLIENT_ID`/`D3AUTH_CLIENT_SECRET` |
| `agent.env` | `SHIPYARD_SERVER_URL=http://server:3300`, `SHIPYARD_DATA_ROOT=/DATA/shipyard`, optional `GITHUB_TOKEN_AGENT` (fine-grained, read-only; public repos work without one, at 60 requests an hour) |
| `tunnel.env` | `TUNNEL_TOKEN=<token>` if you expose the server through a Cloudflare tunnel |

No shell here has `openssl`? `head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'` makes a secret.

## 2. Compose file

`docker-compose.yml` with four services — `postgres:16`, `server`, `agent`, and (optionally)
`cloudflared` — and **literal** image tags `ghcr.io/matdemers1/shipyard/{server,agent}:sha-<40hex>`.
The agent:

- mounts `/var/run/docker.sock`, `/DATA/shipyard/agent` (its key, journal, ledger), and
  `/DATA/shipyard/apps` read-only;
- mounts **each managed stack directory at its identical host path** (e.g. `/DATA/d3auth-demo`),
  added when that app is onboarded (SHP-D-053) — not the whole data root;
- publishes **no ports** (SHP-ADR-002). Neither does the server: ingress is the tunnel.

## 3. Database, then everything

```bash
docker compose -p shipyard pull
docker compose -p shipyard up -d --wait postgres
docker compose -p shipyard run --rm --no-deps server node node_modules/prisma/build/index.js migrate deploy
docker compose -p shipyard up -d
curl -s https://<host name>/api/health     # {"status":"ok","schemaRevision":"…","version":"<sha>"}
```

## 4. The first account (a person runs this)

```bash
docker compose -p shipyard exec server node dist/cli/bootstrap-admin.js --email you@example.com --name "Your Name"
```

It prompts for a password (12+ characters; never pass it as an argument) and prints an `otpauth://`
URI once — add it to an authenticator. It refuses a second run. There is no signup.

## 5. Confirm the agent (a person compares the fingerprint)

The agent logs its fingerprint until it is confirmed:

```bash
docker compose -p shipyard logs agent | grep -m1 'NOT YET CONFIRMED'
```

Confirm it in the console (Agent screen, type the fingerprint), or on the host:

```bash
docker compose -p shipyard exec server node dist/cli/host-admin.js confirm-agent --fingerprint 'SHA256:…'
```

Within a poll the agent logs `agent enrolled and confirmed` and reports its manifests.

## 6. A token for Claude Code sessions

```bash
docker compose -p shipyard exec server node dist/cli/host-admin.js issue-token \
  --email you@example.com --label "claude: <repo>" --apps app-a,app-b
```

Shown once. Add it to a Claude Code session as a remote MCP server at `https://<host name>/mcp`
with header `Authorization: Bearer <token>` (Streamable HTTP; no OAuth, SHP-D-073).

## 7. Onboard apps

See `onboard-app.md`: a manifest in `/DATA/shipyard/apps/<app>.yml`, the stack directory mounted into
the agent at its identical path, then a dry run.

## Installed on the D3 Cloud host (2026-09-25)

`shipyard.d3cloud.io` behind its own tunnel (`shipyard`, id `2bd6239d-44bd-4699-8dee-010992593367`,
remotely managed: ingress `shipyard.d3cloud.io → http://server:3300`), images
`sha-a4acc3350ad88e21fc349c2a4a906851124c32e5`, schema `20260925005523_phase2_to_5`. Agent
`SHA256:3EyGWyLaNLLVUpapKEJr2Gn1+pyB4nlHQmr/uZH6gcA` confirmed via `host-admin`; the outbox posts to
Foreman with a token issued by Foreman's own `issue-token` ("shipyard outbox", read+write).
