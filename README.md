# Shipyard

One deploy button for a Docker Compose host — for you, from your phone, and for Claude Code
sessions, over MCP.

Name an app and a commit. A **portless agent** on the host checks, on its own, that the commit
passed CI, is on `main`, is newer than what's live, and has images in GHCR. Then it backs up,
migrates, swaps to the exact verified image digests, checks that the right code and schema are
running, soaks, and rolls the images back if anything fails. Per-app locks mean two sessions can't
overwrite each other's deploys.

## Architecture, in five lines

- **`apps/server`** faces the internet. It never touches Docker: no socket, no compose, no shell out.
- **`apps/agent`** touches Docker (the socket, compose) and opens no listening port — it long-polls
  the server, signed.
- The engine (`packages/sequence`) **re-verifies every request itself** against GitHub and GHCR
  before it acts — the server naming a SHA is not enough on its own.
- A step is journaled before it runs, and success means the running image digest, the
  `org.opencontainers.image.revision` label, and `/health`'s schema all agree, then a soak.
- Nothing in the core knows about ZimaOS or any other host dashboard — the target is "Docker
  Engine + Compose + a data root."

See `docs/manifests/README.md` for the manifest format and `CLAUDE.md` for the full non-negotiables.

## Why not Coolify, Dokploy, Komodo, Kamal…

None of them verify a SHA against CI, the default branch and the live version before deploying.
None check that the landed schema matches, and none offer an MCP surface for coding agents.
Shipyard does only those things.

## Quick start (no D3 Auth, no tunnel)

This works on a clean Linux machine with Docker Engine and Compose v2.2x or v5 — nothing here
assumes ZimaOS or any particular dashboard. Sign in with D3 Auth is entirely optional; leaving the
`D3AUTH_*` variables unset gives you app-native password + TOTP login only. To add it later, an
admin configures it in the console under **Settings → Sign in with D3 Auth** (issuer, client ID,
client secret — the secret encrypted at rest with a key derived from `SESSION_SECRET`), and it takes
effect without a restart. `D3AUTH_*` variables in `server.env` still work, and when set they win:
the Settings screen then shows them read-only.

```bash
mkdir shipyard-install && cd shipyard-install
mkdir -p data/apps data/agent data/backups
cp <path-to-repo>/docs/install/compose.example.yml docker-compose.yml
cp <path-to-repo>/docs/install/postgres.env.example postgres.env
cp <path-to-repo>/docs/install/server.env.example server.env
cp <path-to-repo>/docs/install/agent.env.example agent.env
```

Fill in the secrets — a shell with no `openssl` can still generate one:

```bash
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
```

Put that (a different one each time) in `postgres.env`'s `POSTGRES_PASSWORD`, `server.env`'s
matching `DATABASE_URL` password and its own `SESSION_SECRET`. Leave every `D3AUTH_*` line blank.

`server.env`'s `PUBLIC_URL` matters: the session cookie is `Secure` only when `PUBLIC_URL` starts
with `https://` (`apps/server/src/auth/cookies.ts`), so a local, tunnel-free try needs
`PUBLIC_URL=http://localhost:3466` (or whatever port you publish) — not `https://` — or the
browser will never send the cookie back over plain HTTP.

Pick a published image tag, `ghcr.io/matdemers1/shipyard/{server,agent}:sha-<40hex>` (see the
Actions tab or GHCR package pages for the newest one on `main`), then set it into
`docker-compose.yml` in place. The compose file pins **literal** tags on purpose, not `${...}`
interpolation — some host dashboards (ZimaOS among them) refuse a compose file that interpolates,
and a deploy through Shipyard itself always resolves to a literal digest, so the install should
start the same way:

```bash
sed -i.bak "s/sha-<40hex>/sha-<the-40-hex-sha-you-picked>/g" docker-compose.yml && rm docker-compose.yml.bak
```

That one command rewrites the `server` and `agent` image lines (and the explanatory comments
above them, harmlessly). Then bring it up:

```bash
docker compose -p shipyard pull
docker compose -p shipyard up -d --wait postgres
docker compose -p shipyard \
  run --rm --no-deps server node node_modules/prisma/build/index.js migrate deploy
docker compose -p shipyard up -d
curl -s http://localhost:3466/api/health   # {"status":"ok","schemaRevision":"…","version":"<sha>"}
```

Now open `http://localhost:3466` and create the first account in the browser. While Shipyard has
no account at all, the console shows a Setup screen instead of sign-in: your email, a display name
and a password (12+ characters), then an authenticator to add (a link that opens your authenticator
app, and the setup key to type) and one six-digit code to confirm it. That creates an admin, signs
you in, and closes setup for good — once any account exists the server refuses that path, and
everyone after you is invited from the Users screen.

> **Claim it right after the first start.** There is no setup code: until the first account
> exists, whoever reaches this URL can create it. Do it before the address is reachable by anyone
> else (before you point a tunnel at it, for example).

On a headless host with no browser to hand, the CLI does the same thing instead (it refuses once
any account exists, too):

```bash
docker compose -p shipyard exec server node dist/cli/bootstrap-admin.js \
  --email you@example.com --name "Your Name"
```

It prompts for a password (12+ characters, never as an argument) and prints an `otpauth://` URI
once — add it to an authenticator app now, it is never shown again.

The agent generates its own Ed25519 identity on first start and logs its fingerprint until a
person confirms it — the second thing only a person does:

```bash
docker compose -p shipyard logs agent | grep -m1 'NOT YET CONFIRMED'
docker compose -p shipyard exec server node dist/cli/host-admin.js confirm-agent --fingerprint 'SHA256:…'
```

Later sign-ins at `http://localhost:3466` take the email, password and the six-digit code from
your authenticator. See `docs/install/README.md` for the full example files and what each variable
means; see `docs/runbooks/install.md` for the same install with a tunnel and a real data root, and
the parts specific to the D3 Cloud host at its end (skip those — they are not needed here).

## Onboarding an app

Once signed in, follow `docs/runbooks/onboard-app.md`: a manifest under `apps/<name>.yml`, the
app's stack directory mounted into the agent at its identical host path, then a dry run and
adopt-live before any real deploy.

## MCP for Claude Code

Shipyard's MCP server is how a coding session deploys, checks status and rolls back, without SSH
or hand-run `docker compose`. See `docs/claude/deploy-snippet.md` (paste into a managed repo's
`CLAUDE.md`) and `docs/claude/skill/SKILL.md` (the deploy skill itself) for what it looks like from
the other side.

## Layout

```
packages/schema     shared Zod: manifests, API, MCP tools, agent protocol
packages/sequence   the deploy engine (gates, state machine, rollback)
apps/server         internet-facing API, console, MCP — never touches Docker
apps/agent          Docker-facing, no listening port, polls the server
apps/cli            host CLI over the same engine
apps/web            phone-first console
e2e/                Docker-in-Docker harness, fake GitHub, toy app
docs/               runbooks, example manifests, the Claude deploy snippet
```

## Development

```bash
pnpm install            # workspace install (supply-chain policy in pnpm-workspace.yaml)
pnpm lint               # eslint, strict type-checked, every package
pnpm typecheck           # tsc --noEmit, every package
pnpm test                # unit tests, every package except e2e — no database, safe in parallel
pnpm test:integration    # server integration tests — needs DATABASE_URL to a PG16 *_test database
pnpm e2e                 # Docker-in-Docker harness — needs Docker
```

Node 22, pnpm 10. Workspace packages: `@shipyard/schema`, `@shipyard/sequence`, `shipyard-server`,
`shipyard-agent`, `shipyard-cli`, `shipyard-web`, `e2e`.

## Security

No telemetry is sent anywhere (`scripts/no-telemetry.sh` checks this in CI). See `SECURITY.md` to
report a vulnerability.

## License

Apache-2.0. See `LICENSE`.
