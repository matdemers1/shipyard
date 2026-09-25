# Install Shipyard on a host

Once, by hand (SHP-D-079). After this the server deploys itself through its own manifest (Phase 4);
the agent is upgraded by hand (`upgrade-agent.md`). The host needs only Docker Engine, Compose and a
data root — nothing here assumes ZimaOS (SHP-D-037). The paths below use `/DATA/shipyard` as the data
root; substitute your own.

> [!warning] Two things only a person does
> Creating the first account (in the browser, or `bootstrap-admin` on a headless host) and
> confirming the agent's fingerprint are deliberate human acts. Nothing in this runbook signs in on
> your behalf.

## 1. Directory and secrets

```bash
mkdir -p /DATA/shipyard/apps /DATA/shipyard/agent /DATA/shipyard/backups && chmod 700 /DATA/shipyard
chown 1000:1000 /DATA/shipyard/backups   # the server runs as `node` (uid 1000) and writes its dumps here
cd /DATA/shipyard && umask 077
```

Write four env files, all mode 600 (the compose file names them by absolute path, so it needs no
`${...}` — some host dashboards refuse a compose file that interpolates):

| File | Contents |
|---|---|
| `postgres.env` | `POSTGRES_USER=shipyard`, `POSTGRES_DB=shipyard`, `POSTGRES_PASSWORD=<random>` |
| `server.env` | `DATABASE_URL=postgresql://shipyard:<same>@postgres:5432/shipyard`, `PORT=3300`, `PUBLIC_URL=https://<host name>`, `SESSION_SECRET=<random 32 bytes hex>`, `TRUST_PROXY_HOPS=1` (behind a tunnel or proxy; omit otherwise), `BACKUP_DIR=/backups`, optional `BACKUP_RETENTION_DAYS` (default 14; the newest three dumps are always kept), optional `FOREMAN_URL`/`FOREMAN_TOKEN` (a write-scoped Foreman token), optional `D3AUTH_ISSUER`/`D3AUTH_CLIENT_ID`/`D3AUTH_CLIENT_SECRET` |
| `agent.env` | `SHIPYARD_SERVER_URL=http://server:3300`, `SHIPYARD_DATA_ROOT=/DATA/shipyard`, optional `GITHUB_TOKEN_AGENT` (fine-grained, read-only; public repos work without one, at 60 requests an hour), and `DOCKER_CONFIG=<dir>` when any managed image is private (see §2) |
| `tunnel.env` | `TUNNEL_TOKEN=<token>` if you expose the server through a Cloudflare tunnel |

No shell here has `openssl`? `head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'` makes a secret.

## 2. Compose file

`docker-compose.yml` with four services — `postgres:16`, `server`, `agent`, and (optionally)
`cloudflared` — and **literal** image tags `ghcr.io/matdemers1/shipyard/{server,agent}:sha-<40hex>`.
The server mounts `/DATA/shipyard/backups:/backups` (its nightly dumps; `BACKUP_DIR=/backups`).
The agent:

- mounts `/DATA/shipyard/backups` **read-only at that identical path**, so the server manifest's
  backup step can see the dump it just took (`docs/manifests/shipyard.yml`, `artifactsDir`);
- for private images, mounts the host's docker config directory read-only (e.g.
  `/DATA/.docker:/DATA/.docker:ro`, with `DOCKER_CONFIG=/DATA/.docker` in `agent.env`): the one
  `ghcr.io` credential there both verifies digests (G8) and pulls — a read-only `read:packages`
  token is enough, and it never leaves the host (SHP-T-4.11);
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

## 4. The first account (a person does this, right after first start)

Open `https://<host name>/` in a browser. While Shipyard has no account at all, the console shows a
**Setup** screen instead of sign-in: email, display name and password (12+ characters), then an
authenticator to add — a link that opens your authenticator app, and the base32 setup key to type —
and one six-digit code to confirm it. Finishing creates an admin with TOTP enrolled, audits it
(`auth.setup.completed`) and signs you in. From then on the server refuses setup (`GET /api/setup`
answers `{"available":false}`, and both setup calls answer `409 conflict`); everyone else is
invited from the Users screen.

> [!warning] Claim it right after the first start
> There is no setup code and no time window: until the first account exists, **whoever reaches
> this URL can claim it**. Create the account before the address is reachable by anyone else —
> before the tunnel's public hostname points at it, or with the tunnel down — and then check the
> Users screen shows only you.

**Headless alternative.** With no browser to hand, the CLI creates the same first admin:

```bash
docker compose -p shipyard exec server node dist/cli/bootstrap-admin.js --email you@example.com --name "Your Name"
```

It prompts for a password (12+ characters; never pass it as an argument) and prints an `otpauth://`
URI once — add it to an authenticator. It refuses once any account exists, and the CLI and the
browser take the same database lock, so the two can never both create a first account.

## 5. Enrolling the agent (a person compares the fingerprint)

The agent generates its Ed25519 identity on first start (the key lands at
`/DATA/shipyard/agent/agent.key`, mode 0600) and enrols itself against the server automatically —
there is no separate enrolment step to run. It logs its fingerprint until a person confirms it:

```bash
docker compose -p shipyard logs agent | grep -m1 'NOT YET CONFIRMED'
```

Confirm it in the console (Agent screen, type the fingerprint), or on the host:

```bash
docker compose -p shipyard exec server node dist/cli/host-admin.js confirm-agent --fingerprint 'SHA256:…'
```

Within a poll the agent logs `agent enrolled and confirmed` and reports its manifests. This
fingerprint is permanent for this host's agent: upgrading the agent's image later
(`upgrade-agent.md`) reuses the same key and needs no re-enrolment or re-confirmation, because the
key lives on the host bind mount, not in the image.

## 6. A token for Claude Code sessions

```bash
docker compose -p shipyard exec server node dist/cli/host-admin.js issue-token \
  --email you@example.com --label "claude: <repo>" --apps app-a,app-b
```

Shown once. Add it to a Claude Code session as a remote MCP server at `https://<host name>/mcp`
with header `Authorization: Bearer <token>` (Streamable HTTP; no OAuth, SHP-D-073).

## 7. Onboard apps

See `onboard-app.md`: a manifest in `/DATA/shipyard/apps/<app>.yml`, the stack directory mounted into
the agent at its identical path, then a dry run and adopt-live before any deploy.

The server upgrades itself through its own manifest once onboarded; the agent never does — see
`upgrade-agent.md` for upgrading it by hand.

## 8. Backups and the restore drill

The server dumps its own database every night at 03:30 (server local time) with PostgreSQL 16
client tools — `pg_dump --format=custom` into `/DATA/shipyard/backups/shipyard-<UTC stamp>.dump` —
then runs the **restore drill**: the newest dump is restored into a scratch database
`shipyard_drill_<stamp>_<hex>` on the same Postgres, checked, and dropped whatever happens. The
check: the restore has `_prisma_migrations` at a migration the live database has applied (and every
live table, when it is the live migration), the key tables `user`, `app`, `deploy`,
`deploy_target`, `audit_event` exist, and `user` and `app` are not empty where they are live.
A missing or day-old dump at start is taken within a minute of boot. Dumps older than
`BACKUP_RETENTION_DAYS` are pruned; the newest three never are. Each outcome is an audit event
(`system.backup`, `system.drill`) on the System screen, and a failure emails `ALERT_TO`.

Run either on demand — the drill is the one command that proves the backups restore:

```bash
docker compose -p shipyard exec server node dist/cli/host-admin.js backup
docker compose -p shipyard exec server node dist/cli/host-admin.js drill
# drill passed: /backups/shipyard-….dump restored 20 tables at 2026…_phase…
```

The drill creates a database, so the server's database user needs `CREATEDB`. The `postgres:16`
image's `POSTGRES_USER` is a superuser and already has it; with any other user, grant it once:

```bash
docker compose -p shipyard exec postgres psql -U postgres -c 'ALTER ROLE shipyard CREATEDB;'
```

## Installed on the D3 Cloud host (2026-09-25)

`shipyard.d3cloud.io` behind its own tunnel (`shipyard`, id `2bd6239d-44bd-4699-8dee-010992593367`,
remotely managed: ingress `shipyard.d3cloud.io → http://server:3300`). Server and agent
`sha-fc4f928ff4811d2da56cf260b2b5da813c5234db`, schema `20260925061243_agent_pat_expiry`. The server
is now deployed by Shipyard itself (`apps/shipyard.yml`; the agent mounts `/DATA/shipyard` at its
identical path); the agent is still upgraded by hand (`upgrade-agent.md`). Agent
`SHA256:3EyGWyLaNLLVUpapKEJr2Gn1+pyB4nlHQmr/uZH6gcA` confirmed via `host-admin`; the outbox posts to
Foreman with a token issued by Foreman's own `issue-token` ("shipyard outbox", read+write).

- Backups: `/DATA/shipyard/backups` (uid 1000) mounted at `/backups`; `host-admin backup` and
  `host-admin drill` both green on 2026-09-25 (21 tables restored at `20260925061243_agent_pat_expiry`).
- The agent mounts `/DATA/.docker` read-only with `DOCKER_CONFIG=/DATA/.docker` in `agent.env`, for
  the private Foreman, Bindery and D3 Auth images (SHP-T-4.11).
- Managed stacks, each mounted at its identical path: d3auth-demo, foreman-board, foreman, bindery,
  d3auth, and shipyard (its server) (d3auth needs a console approval for every deploy).
- Sign in with D3 Auth (the other half of dual login): in D3 Auth's console, **Apps → Add an app**,
  upload `docs/d3auth/shipyard.d3auth.json`; put the issued client secret with
  `D3AUTH_ISSUER=https://auth.d3cloud.io`, `D3AUTH_CLIENT_ID=shipyard`, `D3AUTH_CLIENT_SECRET=…` in
  `server.env`, then `docker compose -p shipyard up -d server`. A D3 Auth identity signs in only once
  it is linked to an existing Shipyard account (Account screen) — it never creates one.
- Not configured yet: `MAIL_RELAY_URL`/`MAIL_RELAY_TOKEN`/`ALERT_TO` (stale-agent and backup-failure
  email; until then they are logged only).
