# A stranger's quick start

The files in this directory are a complete, tunnel-free, D3-Auth-free example install — meant to
work on any clean Linux machine with Docker Engine and Compose v2.2x or v5, nothing else. For the
full walkthrough (a tunnel, a real data root, backups, onboarding apps, issuing an MCP token) see
`../runbooks/install.md`; the parts specific to the D3 Cloud host are only at its very end.

| File | Copy to | Contents |
|---|---|---|
| `compose.example.yml` | `docker-compose.yml` | `postgres` + `server` + `agent`, no tunnel service, server's port published locally for a browser to reach |
| `postgres.env.example` | `postgres.env` | The database's own credentials |
| `server.env.example` | `server.env` | Everything the server reads — `D3AUTH_*` left blank on purpose (configure D3 Auth later in the console's Settings, if at all) |
| `agent.env.example` | `agent.env` | Everything the agent reads |

## What "clean-machine install" means here

1. Copy the four files above, generate secrets, fill in the two placeholder passwords.
2. `docker compose -p shipyard pull && docker compose -p shipyard up -d --wait postgres`
3. Run the Prisma migration once (see `../../README.md`'s Quick start for the exact command).
4. `docker compose -p shipyard up -d`
5. `docker compose -p shipyard exec server node dist/cli/bootstrap-admin.js --email … --name …`
   — a person answers the password prompt and keeps the printed `otpauth://` URI.
6. Confirm the agent's printed fingerprint (`host-admin.js confirm-agent`) — the other act only a
   person does.
7. Sign in at `http://localhost:3466` with the email, the password, and a six-digit code from an
   authenticator app enrolled from the `otpauth://` URI. No `D3AUTH_*` variable was ever set —
   this is app-native login alone.

`../../scripts/clean-install-check.sh` runs this sequence — using these same four files, with the
tag substituted the same way the Quick start's `sed` command does it, plus one small `-f` override
(an internal Docker network and no published server port, so the whole exchange happens
container-to-container and the network itself proves nothing dialed out) — minus the two human
acts (it drives `bootstrap-admin` non-interactively instead), against a published image tag, and
asserts sign-in works and no outbound network connection was attempted at boot. **It does not
start the agent** — bringing it up would mount the calling machine's real Docker socket, which the
check has no business touching; steps 5–7 above are exercised through `server` alone (the agent's
own confirm step, step 6, is out of scope for the check).

## Builds: the build network and rootless BuildKit (optional)

Only needed when an app's manifest says `build.source: shipyard` — Shipyard builds, tests and
pushes the image itself instead of reading CI's. Two more files, installed in this order:

| Order | File | Run by | What it does |
|---|---|---|---|
| 1 | `build-network.sh` | the operator, as root on the Docker host (`sudo sh build-network.sh`) — **never the agent** | Creates the Docker network `shipyard-build` (`172.31.254.0/24`, IPv6 off, bridge `br-shipyard-bld`) and installs two iptables chains: from that bridge, `DOCKER-USER` drops everything to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10` (tailnets), loopback, multicast, reserved, the network's gateway and the host's default gateway; `INPUT` drops everything addressed to the host itself. The public internet stays reachable, for package registries. Idempotent. |
| 2 | `buildkit.compose.yml` | the operator: `docker compose -f buildkit.compose.yml -p shipyard-buildkit up -d` | Rootless `buildkitd`, attached **only** to `shipyard-build`, no Docker socket, no published port, listening on a unix socket in the volume `shipyard-buildkit-socket`, cache in its own volume, public DNS resolvers (a LAN resolver would be dropped). `cpus` / `mem_limit` are placeholders. |

Then give the agent the socket: add `shipyard-buildkit-socket:/run/buildkit` to its `volumes:` (and
the volume as `external: true` at the bottom of `docker-compose.yml`), and set its BuildKit address to
`unix:///run/buildkit/buildkitd.sock`. buildkitd runs as uid 1000, so the agent must be able to open a
socket owned by uid 1000 (`group_add: ["1000"]` or running as that uid).

**Why this isolates build steps.** A Dockerfile `RUN` step runs in buildkitd's network namespace, so
the firewall on `shipyard-build` is the firewall on every build step. The agent checks the network
exists and has the expected subnet, bridge name and IPv6 setting before every build, and refuses
with this script as the fix when it does not. It cannot see the host's iptables, so:

> [!warning] Re-run `build-network.sh` after every host reboot
> The network survives a reboot; the iptables rules do not. Run the script from whatever starts
> things after Docker on your host (for example a systemd unit with `After=docker.service`).

**Integration tests** (`build.integration` in a manifest) do not use this network. Each run gets its
own compose project `shipyard-build-<buildId>` on a per-build network created `internal: true` — no
route anywhere but its own sidecars — and is removed with its volumes when the stage ends. Its
compose file is refused, not silently edited, if it publishes ports, is privileged, joins another
network, mounts host paths, adds capabilities or devices, or uses `${VAR}` interpolation.

**The trade-off in the BuildKit container.** Rootless BuildKit inside a container needs
`seccomp=unconfined`/`apparmor=unconfined` (for RootlessKit's user namespace) and
`--oci-worker-no-process-sandbox` (an unprivileged container cannot mount a fresh `/proc` per step),
so build steps share buildkitd's PID namespace. Shipyard builds one app at a time, and buildkitd
holds only its cache and the current build's secret mounts; the alternative, `--privileged`, is
worse.
