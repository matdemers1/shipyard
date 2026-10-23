# Adopt a stack

Shipyard sees every container on its host (the **Observed** tier, SHP-ADR-009) but acts only on what
a host-local file names. A third-party compose stack — FreshRSS, Uptime Kuma, an app ZimaOS's app
store installed — becomes **Operated** (SHP-ADR-008, SHP-ADR-010) when you write a stack manifest for
it on the host. Adopting is a deliberate host act, like onboarding an app (SHP-D-059): nothing in
the console or MCP can adopt a stack.

What an Operated stack gets today (`updates: none`): **start, stop, restart, recreate** of the
whole stack or one service, from the console's Host view (and start, restart and recreate from a
Claude session's `shipyard_action`), plus its logs. Updating its images by digest arrives with
SHP-P-16; until then whatever installed the stack keeps updating it.

## 1. Find the stack's compose file and project

On the host:

```bash
docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.config_files"}}' <a container of the stack>
```

The first word is the compose **project**; the rest is its compose file. ZimaOS app-store apps live
at `/var/lib/casaos/apps/<name>/docker-compose.yml`, with the project named after the app.

## 2. Write the stack manifest

`<data root>/stacks/<name>.yml` (on the Zima: `/DATA/shipyard/stacks/`), owned by root, mode 0644.
`docs/manifests/stacks/freshrss.yml` is a worked example:

```yaml
kind: stack
name: freshrss            # lowercase, digits, hyphens — the name the console and MCP use
compose:
  files:
    - /var/lib/casaos/apps/freshrss/docker-compose.yml
  project: freshrss       # must equal the running containers' compose project
envFiles: []              # any env files whose values must be redacted from logs and action output
updates: none             # until SHP-P-16; something else keeps the images current
```

The agent reads every file in `stacks/` together: one invalid file and **no stack loads**. The apps
are unaffected — the agent reports them as usual, leaves stacks out of its report (the server keeps
what it had) and logs `stack manifests failed to load` naming the file and field. Check before you
save:

```bash
cd /DATA/shipyard && docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent check-manifests
```

It lists every app and stack and exits 1 on an invalid file or a clash. Two clashes matter, because
otherwise they are settled silently: a stack with the **same name as an app** is never adopted (the
server ignores it with a warning), and a **compose project already named** by an app or an earlier
stack stays with that one.

## 3. Let the agent see the compose file

The agent runs `docker compose -f <file> -p <project> …` from inside its own container, so the
stack's directory must be bind-mounted into the agent **at the identical path** (SHP-D-053). In
`/DATA/shipyard/docker-compose.yml`, under the `agent` service's `volumes`:

```yaml
      - /var/lib/casaos/apps/freshrss:/var/lib/casaos/apps/freshrss:ro
```

Read-only is enough for `updates: none`: start, stop, restart and recreate never write the compose
file. (Digest updates in SHP-P-16 will need it writable.)

## 4. Restart only the agent

```bash
cd /DATA/shipyard && docker compose -p shipyard up -d --no-deps agent
```

`--no-deps` matters: without it Compose also recreates `postgres` if its moving `postgres:16` tag has
advanced, and the server restarts with it (`upgrade-agent.md` §4).

## 5. Check it

Within one report interval (60 s) the console's **Host** view shows the stack's containers as
**Operated** under the stack's name. Then try a harmless verb from the container sheet — Restart on
a single service — and watch it go queued → running → succeeded, with compose's output on the
action.

## Removing a stack

Delete its file from `stacks/` (and the mount, if nothing else needs it) and restart the agent with
`--no-deps`. Its containers drop back to Observed; Shipyard never stops or removes them.
