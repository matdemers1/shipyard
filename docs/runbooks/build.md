# Build an app with Shipyard (`build: shipyard`)

Only needed when an app's own CI is not what produces its images — Shipyard fetches the exact
commit, builds a Dockerfile with rootless BuildKit, optionally runs an integration-test service,
and pushes each release target to GHCR itself (SHP-REQ-117). Every other app stays on
`build: { source: github }` (the default, and permanent for Shipyard's own manifest — SHP-REQ-136):
its images already come from GitHub Actions, and nothing in this runbook applies to it.

## 1. Install order

Builds need the build network and BuildKit installed before anything is onboarded — see
`../install/README.md`, "Builds: the build network and rootless BuildKit":

1. `sudo sh build-network.sh` on the Docker host, as the operator (never the agent) — creates the
   `shipyard-build` network and the iptables rules that firewall it, and the per-build integration
   networks in the `172.30.0.0/16` pool.
2. `docker compose -f buildkit.compose.yml -p shipyard-buildkit up -d` — rootless `buildkitd`,
   attached only to `shipyard-build`, listening on a unix socket in the `shipyard-buildkit-socket`
   volume.
3. Mount that socket into the agent (`shipyard-buildkit-socket:/run/buildkit`, `group_add: ["1000"]`)
   and set `BUILDKIT_ADDR=unix:///run/buildkit/buildkitd.sock` in `agent.env`
   (`docs/install/agent.env.example`) — unset, the agent never advertises the capability and never
   builds. Also set `BUILD_DOCKER_CONFIG` (below) before onboarding the first `build: shipyard` app.

> [!warning] Re-run `build-network.sh` after every host reboot
> The network survives a reboot; the iptables rules do not. Run it from whatever starts things
> after Docker on your host (a systemd unit with `After=docker.service`, for example).

## 2. Onboarding an app for `build: shipyard`

Follows `onboard-app.md`'s steps in order, with these additions.

**Dockerfile.** The image needs a `test` target (run for every build; default `test`) and one
release target per compose service the manifest maps (`releaseTargets`), a `dockerfile` path
repo-relative to the repo root (default `Dockerfile`), and, optionally, a compose
`docker-compose.integration.yml` naming an `integration.service` and `argv` run before the release
targets. See `docs/manifests/README.md`, "`build` and `autoDeploy`", for the exact manifest shape:

```yaml
build:
  source: shipyard
  dockerfile: Dockerfile
  testTarget: test
  releaseTargets:
    server: release-server
    web: release-web
  integration:
    compose: docker-compose.integration.yml
    service: integration
    argv: [pnpm, test:integration]
  secrets:
    - npm_token
autoDeploy: true
```

`dockerfile`, `integration.compose` and every target/service/secret name are validated the same way
as every other host-local path in a manifest — relative, no `..`, no shell string
(`packages/schema/src/build.ts`'s `BuildName`). `releaseTargets` must name every key in `services`
and no extras. `autoDeploy: true` requests one deploy per green Shipyard build automatically; it is
only valid when `build.source` is `shipyard`, and an auto-deploy is an ordinary deploy request —
every gate, freeze, lock and approval still applies (SHP-REQ-138, SHP-REQ-139).

**GHCR push credential.** `BUILD_DOCKER_CONFIG` in `agent.env` names a docker config directory
(mounted read-only) whose `config.json` holds the credential `buildctl` uses to push. Scope it to
`write:packages` and nothing else — a classic PAT with only that scope, or a fine-grained token
limited to the app image packages Shipyard builds. Keep it separate from `DOCKER_CONFIG`, which
only needs `read:packages` for pulling and digest verification.

**Build secrets.** A Dockerfile `RUN --mount=type=secret` name is declared in the manifest's
`build.secrets` (names only — values never appear in a manifest) and set on the host, value on
stdin only:

```bash
printf %s "$NPM_TOKEN" | docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent build-secret set <app> npm_token
docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent build-secret list <app>
docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent build-secret delete <app> npm_token
```

`build-secret set` refuses a value passed as an argument (`apps/cli/src/args.ts`'s
`SECRET_ON_ARGV`) — an argument is kept in shell history and visible to every process on the host.
Secrets are sealed at `<dataRoot>/agent/build-secrets.json` with a key derived from the agent's own
Ed25519 key (`apps/agent/src/build.ts`); build output is redacted against them and against the
app's `envFiles` before any of it reaches the server.

**The GitHub webhook.** On the app's repo: **Settings → Webhooks → Add webhook**.

| Field | Value |
|---|---|
| Payload URL | `<PUBLIC_URL>/api/webhooks/github` |
| Content type | `application/json` |
| Secret | `GITHUB_WEBHOOK_SECRET` (`server.env`; a random 20+ character secret, e.g. `head -c 32 /dev/urandom \| od -An -tx1 \| tr -d ' \n'`) |
| Events | "Just the push event" |

A push to the manifest's `defaultBranch` (default `main`) is what queues a build
(`POST /api/webhooks/github` — HMAC `X-Hub-Signature-256` over the raw body, verified against
`GITHUB_WEBHOOK_SECRET`; `apps/server/src/webhooks/github.ts`). Without `GITHUB_WEBHOOK_SECRET` set,
the webhook always answers `503` (`not_configured`) and only the reconcile loop below queues
anything.

**Commit statuses.** Set a *separate* `GITHUB_TOKEN_STATUS` (`server.env`) — scoped to "Commit
statuses: Read and write" and nothing else, on only the repos Shipyard builds — to have Shipyard
post `shipyard/test` and `shipyard/build` commit statuses as each stage ends (SHP-REQ-146,
`apps/server/src/builds/status.ts`). Never reuse `GITHUB_TOKEN_SERVER`, which stays read-only on
purpose. Left blank, statuses are simply never posted (logged once at startup).

**The reconcile loop.** `BUILD_RECONCILE_INTERVAL_SECONDS` (`server.env`, default 300, minimum 30)
checks the default-branch head of every `build: shipyard` app and queues a build if none exists for
it yet, so a dropped webhook delivery still gets built (`apps/server/src/jobs/build-reconcile.ts`).
Uses `GITHUB_TOKEN_SERVER` when set; public repos work without one, at GitHub's unauthenticated
rate limit.

## 3. Watching a build

Console: **Builds** (list, live log per stage, rebuild, cancel) or the app detail screen. Over MCP:

```
shipyard_build(app: "<app>", sha: "<40-hex SHA>")            # queues one; idempotent for the same app+sha in flight
shipyard_build_status(buildId: "<id>")                       # { state, stages, deployable, … }
```

Or the API directly: `GET /api/builds` (list), `POST /api/builds` (queue), `GET /api/builds/:id`
(detail), `GET /api/builds/:id/logs`, the SSE build-events stream, `POST /api/builds/:id/rebuild`,
`POST /api/builds/:id/cancel` (`apps/server/src/builds/routes.ts`).

A build runs five stages in order — `fetch`, `test`, `integration` (only when the manifest sets
one), `build`, `push` (`packages/schema/src/build.ts`'s `BuildStage`) — and ends `succeeded`,
`failed`, `cancelled` or `refused` (`BuildState`). The agent runs one build at a time, and a deploy
in flight always holds a queued build's next stage rather than the other way — builds never delay a
deploy.

## 4. What a refusal or failure means, and the fix

**Before the build starts (source refusals, `apps/server/src/builds/service.ts`,
`packages/sequence/src/build/source.ts`):**

| Code | Meaning | Fix |
|---|---|---|
| `unknown_app` | No manifest on this host names this app (agent has not reported it). | Onboard the app first (`onboard-app.md`), and confirm the agent picked up the manifest. |
| `not_on_default_branch` | The commit is not on the manifest's `defaultBranch`. | Merge to the default branch, or fix `defaultBranch` in the manifest if it's wrong. |
| `github_unreachable` | GitHub could not be reached, or has no tarball for that SHA (fails closed — no override). | Retry once GitHub is reachable; confirm the SHA exists on that repo. |

**A stage failing** (`test`, `integration`, `build` or `push`) fails the whole build; the stage's
log (in the console, or `GET /api/builds/:id/logs`) is where to look — a failing `test` or
`integration` stage is the app's own test failure, a failing `build`/`push` stage is usually a
Dockerfile, target name, or `BUILD_DOCKER_CONFIG` credential problem. A `build` or `push` stage
failing also posts `shipyard/build` failure early on the commit, ahead of the build's terminal
state (`apps/server/src/builds/status.ts`).

**`interrupted`** — the agent stopped reporting on the build for over `BUILD_STALE_MINUTES` (30)
minutes; the server's stale-build sweep fails it, naming the stage it was in
(`apps/server/src/agent/dispatch.ts`). Fix: check the agent is running and can reach the server,
then rebuild (console **Rebuild**, or `shipyard_build` again for the same app and SHA).

**At deploy time**, a `build: shipyard` app's deploy is gated on the agent-local build record (G5,
`packages/sequence/src/gates.ts`):

| Code | Meaning | Fix |
|---|---|---|
| `build_not_green` | No succeeded Shipyard build exists for this SHA. | Wait for the build to succeed, or rebuild it from the console. |
| `build_digest_mismatch` | The pushed image's digest no longer matches what the build recorded (something else pushed over it). | Rebuild from the console — the build record is never trusted once GHCR disagrees with it. |

## 5. Rotating the webhook secret

Generate a new secret the same way as before
(`head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'`), then change it in both places together:
on GitHub (**Settings → Webhooks → the webhook → Secret**) and in `server.env`'s
`GITHUB_WEBHOOK_SECRET`, then `docker compose -p shipyard up -d server`. Any push delivered in the
gap between the two changes is simply refused with `unauthenticated` (bad signature) — nothing is
silently accepted — and the reconcile loop (§2) picks up anything that was missed on its next pass.

## 6. Recovering a stuck build

- **Cancel and retry:** console **Builds → (the build) → Cancel**, or
  `POST /api/builds/:id/cancel`, then queue a fresh one (**Rebuild**, or `shipyard_build`).
- **Agent restarted mid-build:** the in-flight build is left `running` until the stale sweep marks
  it `interrupted` (up to `BUILD_STALE_MINUTES`) — cancel it directly rather than waiting, if the
  agent is confirmed down and back up already.
- **After a host reboot:** re-run `build-network.sh` (§1) before queuing anything — the agent
  checks the build network's subnet, bridge name and IPv6 setting before every build and refuses,
  naming this script as the fix, when they don't match.

## Related

`docs/manifests/README.md` (`build` and `autoDeploy` field reference), `docs/install/README.md`
("Builds: the build network and rootless BuildKit"), `docs/install/agent.env.example`,
`docs/install/server.env.example`, `onboard-app.md`, `CLAUDE.md` (non-negotiable 1: no endpoint,
tool or manifest field accepts a command string — build secrets and argv are no exception).
