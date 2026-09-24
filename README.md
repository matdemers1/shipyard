# Shipyard

One deploy button for a Docker Compose host — for you, from your phone, and for Claude Code
sessions, over MCP.

Name an app and a commit. A **portless agent** on the host checks, on its own, that the commit
passed CI, is on `main`, is newer than what's live, and has images in GHCR. Then it backs up,
migrates, swaps to the exact verified image digests, checks that the right code and schema are
running, soaks, and rolls the images back if anything fails. Per-app locks mean two sessions can't
overwrite each other's deploys.

> **Status:** planned, not built. This repository is a skeleton. The plan lives in
> [Foreman](https://github.com/matdemers1/foreman) under project `SHP`.

## Why not Coolify, Dokploy, Komodo, Kamal…

None of them verify a SHA against CI, the default branch and the live version before deploying.
None check that the landed schema matches, and none offer an MCP surface for coding agents.
Shipyard does only those things. See SHP-ADR-001.

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

## License

Apache-2.0.
