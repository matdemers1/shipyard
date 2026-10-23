# Volumes and disk: backups, restores, orphan deletes and prunes

Shipyard backs up the named volumes of Deployed apps and Operated stacks, restores them, deletes
orphaned volumes and prunes unused images and old build cache (SHP-ADR-012, SHP-P-17). Backups
and prunes are routine. Restoring or deleting a volume replaces or destroys data, so each is a
person's act: an admin, a fresh step-up code and the volume's name typed out. No API token or MCP
tool can do either (SHP-REQ-204).

| Act | Who | Where |
|---|---|---|
| Back up a volume | deployer or admin; a token scoped to the volume's app or stack | Host › Volumes › Back up, `shipyard_volume_backup` |
| Restore a volume | admin, step-up within ten minutes, name typed | Host › Volumes › Restore… (console or D3 Constellation) |
| Delete an orphaned volume | admin, step-up within ten minutes, name typed | Host › Volumes › Delete… |
| Prune images and build cache | deployer or admin; any token | Host › Disk › Prune…, `shipyard_prune` |

## The backup root

The agent writes archives to `<backup root>/volumes/<volume>/<UTC timestamp>.tar.zst`, files
`0600` in directories `0700` it creates. The backup root is `SHIPYARD_BACKUP_ROOT` in the agent's
environment, and defaults to `<data root>/agent/backups`.

The agent runs the copy in a helper container started from **its own image** (no third-party image
touches data), so it bind-mounts the backup root into that helper by path. The backup root must
therefore be **writable and mounted into the agent at the identical host path** (SHP-D-053). On
the Zima the default `/DATA/shipyard/agent/backups` sits inside `/DATA/shipyard`, which is
already mounted read-write at the same path, so nothing needs adding. If you point
`SHIPYARD_BACKUP_ROOT` elsewhere, add the mount to the `agent` service:

```yaml
      - /mnt/backups/shipyard:/mnt/backups/shipyard
```

then restart only the agent: `docker compose -p shipyard up -d --no-deps agent`.

Archives are where the host's own off-site backup should look: Shipyard does not copy them off
the machine.

## Backup settings in a manifest

An app manifest (`apps/<name>.yml`) or a stack manifest (`stacks/<name>.yml`) may carry:

```yaml
volumeBackups:
  volumes: [forgejo_data]   # omit to back up every named volume the stack's containers mount
  retain: 7                 # keep the newest 7 archives per volume (default 7)
  quiesce: false            # true: stop the stack for the copy, start it again after
  nightly: true             # queue a backup every night
  beforeUpdate: false       # digest stacks: back up these volumes before each update's pull
```

- **Retention** (SHP-REQ-206): after each successful backup the agent deletes that volume's oldest
  archives beyond `retain`. A restore never trims archives.
- **Quiesce**: a live copy of a database's files can be inconsistent. Prefer a `steps.backup` dump
  (as D3 apps do) for databases. Use `quiesce: true` when the app can afford a short stop; the
  agent starts the stack again even when the copy fails.
- **Nightly**: the server queues one backup per volume per night at `NIGHTLY_BACKUP_HOUR` (server
  local time, default 3). They run one at a time.
- **Shipyard's own stack** cannot be quiesced or restored through Shipyard: stopping it would stop
  the agent doing the work. Back Shipyard's volumes up without quiesce, and restore them by hand.

## Backing up

Host › Volumes lists orphans first, then owned volumes (Deployed and Operated), then Observed ones.
**Back up** on an owned volume queues a job; the row shows "Archiving · <volume>" and then the new
archive. **Archives · N** lists them newest first with time, size, quiesced or live copy, and who
took it. A failed backup shows its message and fix in the row and in Needs you.

From a Claude Code session: `shipyard_volume_backup { volume, requester }` with a token scoped to
the volume's app or stack, then `shipyard_maintenance_status` if it is still running.

## Restoring a volume

Restore… opens a sheet: pick an archive, type the volume's name exactly, enter a code from your
authenticator. The agent then:

1. checks the archive against its own ledger (sha256 and size) — a missing or changed file is
   refused before anything stops;
2. stops the owning stack, and refuses if any other running container still mounts the volume;
3. takes a **safety archive** of the current contents;
4. empties the volume and unpacks the archive into it;
5. starts the stack.

If unpacking fails, the agent puts the safety archive back and starts the stack. If that fails
too, it leaves the stack **stopped** and says so: start it only once the volume holds what you
want. The safety archive is listed with the others, so a wrong restore can itself be undone.

Restores are refused while a deploy, stack update or lifecycle action runs on the same app or
stack, and those are refused while a restore runs.

## Deleting an orphaned volume

Only a volume that no container — running or stopped — mounts is offered Delete…, and never one
whose compose project is a Deployed app or an Operated stack (a stack brought down with
`compose down` leaves its volumes unmounted, not orphaned). Type the name, enter a code. The agent
lists every container again just before `docker volume rm` (never `-f`) and refuses
`volume_in_use` naming any that mounts it. A delete cannot be undone.

## Pruning

Prune… runs a **dry run** first and lists what would go, with sizes and the total that comes back:

- dangling images (no tag);
- unused images (no container, running or stopped, uses them) older than seven days;
- build cache records older than seven days that are not in use.

**Volumes are never pruned**, nor are networks or containers. "Prune these" removes exactly that
list — each item re-checked first, so an image that came into use since is kept — and reports
the space freed. A dry run authorizes one prune within the hour; after that, run a new one.

From a Claude Code session: `shipyard_prune {}` (a dry run), then
`shipyard_prune { dryRun: false, fromDryRunId: <its id> }`.

## What each act needs on the host

| Act | Needs |
|---|---|
| Backup, restore | the backup root writable at the same path in the agent; the owner's compose files mounted at the same path (as for actions, `adopt-stack.md`); `zstd` in the agent image (shipped) |
| Delete, prune | nothing beyond the Docker socket the agent already has |
| All | an agent that advertises `maintenance` (upgrade it after the server, `upgrade-agent.md`) |
