# e2e harness

Docker-in-Docker, `registry:2`, a fake GitHub and a configurable toy app — the world Shipyard's
agent will be tested in. Needs Docker Engine + Compose v5 on the machine running the tests.

```bash
pnpm e2e                          # everything, Docker included (from the repo root)
pnpm --filter e2e test:unit       # the fake GitHub's logic only, no Docker
```

## The pieces

| Piece | What it is for |
|-------|----------------|
| `harness/compose.yml` | Three services on one network: `dind` (`docker:29-dind`, privileged, plain TCP 2375, `--insecure-registry=registry:5000`), `registry` (`registry:2`) and `fake-github` (`fake-github/server.mjs` bind-mounted into `node:22-alpine`). Every host port is ephemeral and bound to `127.0.0.1`. |
| `harness/harness.ts` | `startHarness()` brings the stack up under a fresh project `shp-e2e-<id>`, polls `docker info` against dind, the registry's `/v2/` and the fake GitHub until they answer, and returns `{ project, registryHostPort, dockerHost, fakeGithubUrl, … , stop() }`. `stop()` runs `down -v` and removes the host tags it made; a failed start tears itself down too. |
| `buildToyImage({ mode, schema, revision, contract? })` | Builds `toy-app/` on the host daemon as `registry:5000/toy/app:sha-<revision>`, loads it into dind (`docker save \| docker load`), pushes it from dind, then deletes dind's copy so a deploy genuinely pulls. Returns the digest the push reported, confirmed against the registry. |
| `deployFromManifest(manifestPath, sha)` | Reads the manifest, resolves `sha-<sha>` to its digest, renders the compose files with the image line pinned to `tag@digest`, then against dind: `pull`, the `migrate` step (`compose run --rm --no-deps <service> <argv…>`), `up -d --wait`. Reports the running container's image ID, RepoDigests, labels and `/health`. |
| `toy-app/` | `server.mjs`, `migrate.mjs` and a `Dockerfile`. Build args pick the behaviour: `TOY_MODE` = `pass \| fail-health \| wrong-schema \| fail-migrate \| exit-mid \| print-secret`, `TOY_SCHEMA` (what `/health` reports), `TOY_REVISION` (also the `org.opencontainers.image.revision` label), `TOY_CONTRACT=1` (adds `dev.d3cloud.shipyard.migration=contract`). `manifest.yml` and `compose.yml` are the stack as a host would hold it. |
| `fake-github/` | The slice of the GitHub REST API the agent uses: `GET /repos/:o/:r/actions/runs?head_sha=` and `GET /repos/:o/:r/compare/:base...:head`, in GitHub's shape. Tests drive it with `POST /_control/state` and read `GET /_control/requests` (`DELETE` clears them). All logic is in `logic.mjs` (types in `logic.d.mts`), so it is unit-tested without Docker. |

## Two routing facts worth knowing

- **Images reach the registry through dind, not the host daemon.** On Docker Desktop the daemon runs
  in a VM that cannot reach an ephemeral published port, loopback or not, so a host `docker push`
  to `127.0.0.1:<port>` is refused. dind reaches `registry:5000` over the harness network.
  `registryHostPort` is still used from the host for plain HTTP (resolving a tag's digest).
- **`/health` is fetched from inside dind.** The toy stack publishes `127.0.0.1::3000` inside dind's
  network namespace; the harness asks `docker compose port` for the port and runs busybox `wget`
  in the dind container with `docker exec`.

From inside the harness network the registry is `registry:5000` and the fake GitHub is
`http://fake-github:8080`. A later phase runs the real agent as a container in dind, pointed at
both.
