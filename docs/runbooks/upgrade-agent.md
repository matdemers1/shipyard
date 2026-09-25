# Upgrade the agent

By hand, always (SHP-D-011): the server deploys itself through its own Shipyard manifest once
onboarded (`install.md`), but the agent never deploys itself — a root-capable process that could
swap its own image is exactly the escalation Shipyard's non-negotiables rule out for every other
app, and doubly so for the one process with the Docker socket. So the agent is upgraded from this
runbook, on the host, every time.

## 1. Pre-checks

Do not upgrade the agent mid-deploy. Confirm nothing is in flight, for every app it manages, with
`shipyard-run` (`apps/cli`; it drives `packages/sequence` directly against the host's Docker socket
and is not one of the four compose services — run it from a checkout on the host, built once with
`pnpm --filter shipyard-cli build`):

```bash
SHIPYARD_DATA_ROOT=/DATA/shipyard node <repo checkout>/apps/cli/dist/index.js status <app>   # for each managed app
```

or check the console (Home, or each app's detail screen — no deploy showing `running`/`starting`
state). Also check the journal is clean — no unfinished entries waiting on a crash recovery that
hasn't run yet:

```bash
tail -5 /DATA/shipyard/agent/journal.jsonl
```

If the last line is not an `end` for its `start`, something is mid-flight or was interrupted and
not yet recovered — run `SHIPYARD_DATA_ROOT=/DATA/shipyard node <repo checkout>/apps/cli/dist/index.js recover`
(or restart the agent, which recovers on start, see §5) before upgrading, not during.

## 2. Pull the new agent image

On the host:

```bash
docker pull ghcr.io/matdemers1/shipyard/agent:sha-<new 40hex>
```

Confirm it is the SHA you intend — check the release notes or the commit you want, and that CI
passed for it, the same way any other deploy would be gated, since nothing gates this one for you.

## 3. Edit the tag

In `/DATA/shipyard/docker-compose.yml`, change the agent service's literal image line:

```yaml
services:
  agent:
    image: ghcr.io/matdemers1/shipyard/agent:sha-<new 40hex>
```

No `${…}` and no `:latest` — literal tags only (install.md §2). Do not touch `server`'s image line
in the same edit; upgrade one service at a time so a problem is easy to attribute.

## 4. Bring it up

```bash
docker compose -p shipyard up -d agent
```

Compose recreates only the `agent` container; `server` and `postgres` are untouched.

## 5. Confirm it reconnects

The agent's identity is its Ed25519 key at `/DATA/shipyard/agent/agent.key` (PKCS8 PEM, mode 0600),
which lives on the host bind mount, not inside the container — the new image reuses the same key
and therefore the same fingerprint, so **no re-enrolment and no re-confirmation** is needed:

```bash
docker compose -p shipyard logs -f agent
```

Expect, within a poll interval:

- `agent starting` with the same fingerprint as before (`SHA256:…`) and the new `version`.
- Any unfinished deploy recovered automatically on start (`recoverInterrupted` runs before the
  agent's first request) — logged per app if there was one; `nothing to recover` behavior if not.
- Reports resume (manifests re-read, app status posted) without a `NOT YET CONFIRMED` log line —
  that only appears for a fingerprint the server has never seen confirmed.

Also check from the server side that it still sees the agent reporting:

```bash
SHIPYARD_DATA_ROOT=/DATA/shipyard node <repo checkout>/apps/cli/dist/index.js status <any managed app>
```

or the console's Agent screen, which should show the new version and a recent report time.

## 6. Rollback the agent itself

If the new agent fails to reconnect, fails health in some way you can observe (crashes, cannot open
the Docker socket, refuses every request), or misbehaves once reconnected: edit the same image line
back to the previous known-good `sha-<40hex>` and repeat step 4. The key and fingerprint are
unaffected either way, since they live on the host, not in the image. There is no automated
rollback for the agent — this is the one image Shipyard cannot deploy or roll back for itself
(SHP-D-011), so reverting the tag by hand is the whole mechanism.

## What happens to an interrupted deploy

If the agent is upgraded (or crashes) while a deploy is journaled but not finished, the new agent
process runs `recoverInterrupted` on start, before it serves any other request: it never resumes a
deploy forward, only rolls the app back to its last verified-good compose file recorded in the
journal (non-negotiable 4 — a step is journaled locally before it runs, so recovery always has
something to roll back to). Watch the agent's startup log for the recovery result per app; if it
reports an error rather than a clean roll-back, check that app's `status` and resolve any drift
before deploying it again (`docs/runbooks/onboard-app.md` covers adopt-live / redeploy-recorded for
drift in general).
