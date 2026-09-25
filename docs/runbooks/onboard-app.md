# Onboard an app onto Shipyard

Followed once per app, in order (SHP-REQ-069): **d3auth-demo, foreman-board, foreman, bindery,
d3auth**. d3auth-demo is done (2026-09-25) — see `docs/manifests/README.md` and the per-app notes
below rather than repeating its steps here.

The rule for every app (SHP-REQ-070): **the first Shipyard action on it is a dry run, then
adopt-live, before any real deploy.** Do not skip to a deploy because the dry run looked clean —
there is no recorded release yet, so a deploy would refuse nothing it should and record a release
nobody reviewed.

## 1. App-side prerequisites

Before touching Shipyard, the app's own CI must already produce what Shipyard will verify:

- Images published as `ghcr.io/<owner>/<name>:sha-<40hex>` — the tag Shipyard resolves from the
  commit SHA it is asked to deploy (`ImageTag` in `packages/schema/src/primitives.ts`).
- The `org.opencontainers.image.revision` OCI label set to that same commit SHA on every image
  Shipyard maps in the manifest — success requires the running digest **and** this label to match
  (SHP-D-022; CLAUDE.md non-negotiable 5).
- Ideally, `dev.d3cloud.shipyard.migration` (`none` | `expand` | `contract`) and
  `dev.d3cloud.shipyard.schema` labels on the image that carries the migration, written from the
  `Shipyard-Migration:` commit trailer convention in the app's own CI. A release labelled
  `dev.d3cloud.shipyard.migration=contract` is never auto-rolled back (CLAUDE.md non-negotiable 6);
  without the label the health check only requires that a schema revision is reported at all.
- A health endpoint that returns 200 with a JSON body naming a schema revision (`/health` by
  convention, but the manifest's `health.path` can be anything). If the manifest sets
  `health.expectSchema`, the endpoint's reported revision must equal it exactly; otherwise the
  image's `dev.d3cloud.shipyard.schema` label supplies the expectation, or, absent both, any
  non-empty revision is accepted.
- If the app has data worth backing up: a backup command that runs inside the app's own container
  and an artifacts directory on the host. Success is exit 0 **and** a new non-empty file appearing
  under that directory after the step runs — pick a command and directory that actually produce one
  per invocation.

## 2. The manifest

Write `/DATA/shipyard/apps/<app>.yml` on the host (not in this repo — SHP-D-017: the copy that
counts is the one on the host, so a manifest under `docs/manifests/` here is a record only, kept in
step by hand). Field-by-field, against `packages/schema/src/manifest.ts`:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must equal the filename stem (`<app>.yml` → `name: <app>`), or the load fails naming the mismatch. |
| `repo` | yes | `owner/name`, the GitHub repo Shipyard re-verifies CI and compares against. |
| `defaultBranch` | no | Defaults to `main`. |
| `workflow` | yes | The CI workflow file name (e.g. `ci.yml`) whose runs gate a deploy. |
| `compose.files` | yes | Absolute path(s) to the stack's compose file(s) on the host. |
| `compose.project` | yes | The `-p` project name Shipyard passes to `docker compose`. |
| `services.<name>.image` | yes, one per mapped service | The **untagged** image (no `:tag`, no `@digest` — both are chosen at deploy time; a tag or digest here is rejected). |
| `health.service` | yes | Which compose service the health check reaches. |
| `health.port` | yes | The container port, reached over the app's own Docker network. |
| `health.path` | yes | Must start with `/`. |
| `health.expectSchema` | no | Usually omitted — see prerequisites above. |
| `soakSeconds` | no | Defaults to 60; 0–3600. |
| `approval` | no | `none` (default) or `required` — a human must approve before the swap. |
| `steps.backup` | no | `{ service, argv, artifactsDir }` — argv only, never a shell string (non-negotiable 1). |
| `steps.migrate` | no | `{ service, argv }` — run as a one-shot `compose run --rm` with the new image, before the swap. |
| `requiredEnv` | no | Names of env vars the manifest's env files must supply; missing ones refuse before locking. |
| `foreman.project` | no | The Foreman project code deploys of this app are recorded against. |
| `foreman.environment` | no | Defaults to `production`. |
| `group` / `canary` | no | Apps sharing a `group` are treated as one migration unit; `canary: true` marks the member deployed first (SHP-D-047). |
| `envFiles` | no | Absolute paths; their values are redacted from stored step output. |
| `diskFloorGb` | no | Defaults to 5 — refuses before locking when the Docker root has less free space. |
| `retainImages` | no | Defaults to 3 — old Shipyard-deployed images kept per service after a success. |

Validate before trusting it, with `shipyard-run` (`apps/cli`, `packages/sequence` directly — it is
not one of the four compose services, so run it from a checkout on the host, built once with
`pnpm --filter shipyard-cli build`):

```bash
SHIPYARD_DATA_ROOT=/DATA/shipyard node <repo checkout>/apps/cli/dist/index.js check-manifests
```

It prints `<app> <file>` for every manifest that loaded, or refuses — naming the file and the exact
field path — if any manifest in `/DATA/shipyard/apps` fails to parse. It reads every manifest, not
just the one just added, so a mistake in another app's file also blocks this.

## 3. Hand-edit the stack's compose file

On the host, before mounting the stack into the agent:

1. Keep the original as `docker-compose.yml.pre-shipyard` beside the new one (SHP-D-059) — the
   record of what ran before Shipyard, never edited again.
2. For every service the manifest maps in `services`, replace `build:` (if any) and any `${…}`
   image interpolation with a literal `image: <repo>:sha-<40hex>` line — the exact SHA of what is
   already running, so the compose file on disk matches reality before Shipyard ever touches it.
   No `build:` and no `${…}` remain on a mapped service; Shipyard rewrites this line at deploy time
   and refuses to reason about a build context or an interpolated value it did not put there.
3. Services the manifest does not map are left alone.

## 4. Mount the stack into the agent, restart it

The agent only sees a stack directory it has mounted at its identical host path (SHP-D-053) — add a
bind mount for `<app>`'s directory (e.g. `/DATA/<app>:/DATA/<app>`) to the `agent` service in
`/DATA/shipyard/docker-compose.yml`, then:

```bash
docker compose -p shipyard up -d agent
```

Confirm the agent picked up the manifest and reports the app:

```bash
SHIPYARD_DATA_ROOT=/DATA/shipyard node <repo checkout>/apps/cli/dist/index.js status <app>
```

(or via the console's Agent screen / app detail — it should show the app reported, not `unknown_app`.)

## 5. Dry run first (SHP-REQ-070)

Before any real deploy, always: console app detail (or Home) → the dry-run sheet, choosing the
commit SHA already running, or over MCP:

```
shipyard_dry_run(app: "<app>", sha: "<the 40-hex SHA already running>")
```

A dry run runs every gate (CI, ahead-of-live, digest resolution, health, schema) without swapping
anything, and reports what it found. On a never-deployed app there is nothing to compare "ahead of
live" against, so this mainly proves the manifest, image and health check line up before anything
is recorded.

## 6. Adopt-live (SHP-REQ-070)

Still on the app detail screen: **"Shipyard has no recorded release for this app yet"** with an
**"Adopt what's running"** button (no drift banner — there is no drift yet, because nothing is
recorded to drift from). Click it, give a one-line reason (up to 200 characters — this is what
`adopt-live by <you>: <reason>` is labelled with), and submit. This is the human act named in
SHP-D-059/SHP-D-079: it establishes the running images as the recorded release, so a later deploy
has something to compare against and drift can be detected from here on. Nothing on the host
changes.

Equivalently, from a host shell if the console is out of reach: there is no `host-admin` adopt
command; adopt-live is a console/API action only (`POST /api/apps/<app>/drift/adopt`), reachable
over the console or, for a Claude Code session with a token issued in `install.md` step 6, by
asking it to adopt with a reason.

## 7. The first real deploy

Once adopted, deploy a newer commit SHA that CI has passed on `defaultBranch` and that is a
descendant of the SHA just adopted:

```
shipyard_deploy(app: "<app>", sha: "<newer 40-hex SHA>")
```

or the console's deploy button, or `shipyard-run deploy <app> <sha>` (`node apps/cli/dist/index.js
deploy <app> <sha>`, as above) from the host. Verify:

- The deploy record (console `/deploys/:id`, or `shipyard_deploy_status`) shows `succeeded` with
  the digest, `org.opencontainers.image.revision` and schema all matching, past its soak.
- `shipyard-run status <app>` shows the new SHA as the last deploy.
- Foreman shows a deployment row for this app's project (`foreman.project` in the manifest), once
  the outbox has posted it.

## 8. Rollback drill (non-production apps only)

For any app that is not production-critical (do this on d3auth-demo, foreman-board and bindery
before relying on Shipyard for them; skip it on d3auth and, once foreman itself depends on
Shipyard's own recording, on foreman): deploy a SHA, then roll it back (console app detail's
rollback action, or `shipyard_deploy` with `kind: rollback` — see the dry-run sheet's `SheetAction`
union) to the prior recorded release, and confirm the running digest and revision return to what
they were and the deploy record shows `rolled_back` or `succeeded` for the rollback target as
appropriate. This proves the rollback path works for this app's images and health check before a
real forward deploy ever needs it. Do not drill a rollback against d3auth or against an app mid a
migration step — see the per-app notes.

## Per-app notes

### d3auth-demo — done (2026-09-25)

Already onboarded; see `docs/manifests/README.md` for the exact sequence run (dry run, real
deploy, a refused older-SHA deploy) and `docs/manifests/d3auth-demo.yml` for its manifest. No data,
no migrate step, `approval: none`.

### foreman-board

A canary member of a `group` shared with `foreman` (SHP-D-047): set `group: foreman` and
`canary: true` on its manifest, so it deploys first within the group when both are deployed
together. It migrates on boot (its own container runs its migration when it starts, not a Shipyard
`steps.migrate`), so its manifest has no `steps.migrate` — the swap alone is enough; the migration
happens inside the new container as it comes up, before it reports healthy.

### foreman

Shares images with foreman-board and is the other `group: foreman` member (not the canary). Also
migrates on boot — no `steps.migrate` here either. A pre-migration dump happens at boot (inside
foreman's own startup, not a Shipyard `steps.backup`), so a Shipyard-level backup step is not
required, though one can still be added if a host-triggered backup before the swap is wanted in
addition.

### bindery

Has real data and an explicit migration step: set `steps.migrate` to run `alembic upgrade head` as
argv in the service that has the app's code and DB access, e.g.:

```yaml
steps:
  migrate:
    service: web
    argv: ['alembic', 'upgrade', 'head']
```

Set `steps.backup` to its existing backup command and the host directory its dump lands in. The
host compose file moves from tracking `:main` to literal `sha-<40hex>` tags as part of step 3 above
— this is the one app in the onboarding order that was previously tracking a moving tag rather than
a pinned SHA, so double-check nothing else on the host still refers to `:main` after the edit.

### d3auth

Onboarded last (SHP-D-076). Set `approval: required` in its manifest — every deploy needs a human
approval before the swap, regardless of who or what requested it. Set `steps.backup` to its backup
command and artifacts directory (it holds real user credentials — see d3-auth's own CLAUDE.md for
what "backup" means there). No rollback drill on this one; if a rollback is ever needed it is a
real incident, not a drill.
