# Manifests

The manifests Shipyard runs on the host, kept here as a record. The copy that counts is the one on
the host under `<data root>/apps/` (SHP-D-017): changing what a root-capable agent runs must need
host access, so a change here does nothing until someone puts it there by hand.

## d3auth-demo — first real deploy (SHP-T-1.13, 2026-09-25)

Onboarding (a deliberate host act, SHP-D-059): the demo's compose file stopped building from source
and names `ghcr.io/matdemers1/d3-auth/demo`, published by d3-auth's CI from main (AUTH-T-001). The
original file is kept beside it as `docker-compose.yml.pre-shipyard`.

Run from the published agent image, `ghcr.io/matdemers1/shipyard/agent:sha-d7ecdba9433e748f43b5a9dc0e6cb2dd997e41c4`:

| Request | Result |
|---|---|
| `deploy d3auth-demo 9df50ff…` (dry run) | every gate passed; digest resolved |
| `deploy d3auth-demo 9df50ff…` | **succeeded** — `demo@sha256:55a25919…f4db52`, schema `none`; compose rewritten to `sha-9df50ff…@sha256:55a25919…` |
| `deploy d3auth-demo 324ab5d…` (older) | **refused** `not_ahead_of_live (G7)`: "live is 9df50ff; request a descendant, or use rollback" |

A forced health failure rolling back is proven on the toy app in `e2e/tests/sequence.test.ts`.

## Env preflight: `dev.d3cloud.shipyard.env` (SHP-T-5.5, SHP-REQ-082)

An image can declare the environment variable names it needs at runtime by carrying an OCI label
`dev.d3cloud.shipyard.env` — a comma-separated list of names, whitespace around each entry
tolerated (e.g. `dev.d3cloud.shipyard.env=DATABASE_URL, SMTP_HOST`). Only names ever leave the
engine; a value is never read into memory beyond parsing the manifest's env files for their keys,
and never logged.

G9 refuses the deploy before locking or pulling anything if any name is absent from the stack's
env files — the union of the manifest's `requiredEnv` and every mapped service's image-declared
names, naming every missing variable and which image or manifest field required it (e.g. "missing
required env DATABASE_URL (manifest requiredEnv), SMTP_HOST (declared by server image)"). If names
are required but the manifest names no `envFiles` at all, the refusal's fix says so. A malformed
entry in the label (not a valid identifier) refuses fail-closed, naming the bad entry, rather than
being silently dropped.

G9 is only ever evaluated when env names were actually gathered for the request; an image-only
rollback does not re-derive this from the target release's image and so is never blocked by it —
current behaviour, preserved.

## Guided restore: `steps.restore` (SHP-T-5.6, SHP-REQ-083..085)

A manifest that wants the console's **Restore** names the app's own restore command beside its
backup step. Like every step it is an argv array in a named compose service, exec'd in the running
container with `docker compose exec -T` — never a shell — and its output is never stored
(SHP-D-082):

```yaml
steps:
  backup:
    service: db
    artifactsDir: /DATA/apps/foreman/backups        # host path; the backup lands here
    argv: [pg_dump, --format=custom, --file=/backups/foreman.dump, foreman]
  restore:
    service: db
    argv: [pg_restore, --clean, --if-exists, --dbname=foreman, "/backups/{artifact}"]
```

- `{artifact}` is replaced by the chosen backup's **file name** only. The backup step's artifact is
  a host path under `artifactsDir`; the container sees its own mount of that directory, so the argv
  names its own path to it (`/backups/…` above). The name must match `[A-Za-z0-9._-]+` or the
  restore is refused. At least one argv entry must contain `{artifact}`.
- `steps.restore` without `steps.backup` is invalid: a restore only ever uses an artifact the backup
  step took, and it takes a fresh safety backup first.
- The agent restores only backups recorded in **its own ledger** (every backup is recorded the moment
  it is taken, so the backup a failed contract release took before migrating is restorable), at
  most once per app per 24 hours, and then runs the release whose images were running when that
  backup was taken — swapping them back, image-only, if something else runs now. Order: verify →
  safety backup → restore → pull → swap → check → soak. A failure after the restore command ran
  stops `failed`; Shipyard never restores or rolls back a second time on its own.
- Requested from the console only (Restore on the app, the app's name typed to confirm). Tokens and
  MCP cannot start one.
