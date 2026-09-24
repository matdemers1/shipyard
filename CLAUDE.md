# CLAUDE.md — Shipyard

One deploy button for a Docker Compose host — for Matthew on his phone and for Claude Code sessions
over MCP. Replaces the hand-typed SSH + `sed` + `pull` + `up` ritual.

**Foreman code: `SHP`.** Foreman is the source of truth — start every session with
`/start-development shipyard` (one `foreman_brief SHP`). Documents: Overview, Architecture, Data
Model, API Contract, UX Flows & Screen Inventory, Test Strategy, Research Notes, Discovery &
Requirements, Discovery Roadmap, Feature Ideas & Future Development. ADRs SHP-ADR-001…003,
decisions SHP-D-001…087, risks SHP-R-001…010.

## The shape (SHP-ADR-002)

- **`apps/server`** — internet-facing. Express + Prisma/PostgreSQL 16, dual login (app-native
  password + TOTP **and** Sign in with D3 Auth), REST under `/api`, MCP at `/mcp`, SSE, outbox to
  Foreman. **Never touches Docker.**
- **`apps/agent`** — touches Docker, faces nothing. **No listening port.** Signed (Ed25519)
  long-poll to the server. Re-verifies every request with GitHub and GHCR itself.
- **`packages/sequence`** — the deploy engine (gates, state machine, image-line rewrite, steps,
  journal, ledger, rollback). Used by the agent **and** by `apps/cli`; no deploy logic anywhere else.
- **`packages/schema`** — Zod: manifest, API, MCP tools, agent protocol, error catalogue. One
  source for validation, types and OpenAPI.
- **`apps/web`** — React 19 on `@d3cloud/ui`, **phone-first** (375 px).
- **`e2e/`** — Docker-in-Docker + `registry:2` + fake GitHub + a toy app with failure modes.

## Non-negotiables — a change that breaks one is wrong

1. **No endpoint, tool or manifest field accepts a command string.** Steps are argv arrays in a
   named compose service (SHP-D-055, SHP-D-044).
2. The only request data that reaches the host is an **app name and a 40-hex SHA**.
3. The agent opens no port; the server never calls the agent.
4. A step is **journaled locally before it runs** (SHP-D-029, SHP-D-081).
5. Success = running digest **and** `org.opencontainers.image.revision` **and** `/health` schema
   match, then soak (SHP-D-022).
6. Auto-rollback is **image-only**. A release labelled `dev.d3cloud.shipyard.migration=contract`
   is never auto-rolled back; data restore is always a confirmed human act.
7. Rollback/restore targets come only from the **agent's own ledger** (SHP-D-080).
8. **Nothing in core knows about ZimaOS** (SHP-D-037). The host is "Docker Engine + Compose v5 +
   a data root".
9. Forward gates **fail closed** when GitHub/GHCR is unreachable; there is no override.
10. No telemetry; no stored app secrets; step output redacted, backup/restore output never stored.

## Conventions

- Node 22, pnpm 10 (supply-chain policy in `pnpm-workspace.yaml`), TypeScript, Vitest, Playwright.
- CI on **GitHub-hosted runners only** — this repo is public; never the Zima's self-hosted runner.
- Images `ghcr.io/matdemers1/shipyard/{server,agent}:sha-<40hex>` from `main` only, with OCI labels.
- Compose operations go through the pinned `docker compose` v5 CLI with explicit `-f` and `-p`;
  dockerode is for inspect/network/events only.
- Every refusal is `{ code, gate, message, fix }`.
- PostgreSQL client tools pinned to 16 (a newer `pg_dump` writes dumps 16 cannot restore).
- Audit every mutation. pino JSON logs with the deploy ID on every deploy line.
- No time estimates anywhere. No Co-Authored-By lines in commits.

## Dev commands

```bash
pnpm install            # workspace install (supply-chain policy in pnpm-workspace.yaml)
pnpm lint               # eslint, strict type-checked, every package
pnpm typecheck          # tsc --noEmit, every package
pnpm test               # unit tests, every package except e2e — no database, safe in parallel
pnpm test:integration   # server integration tests — needs DATABASE_URL to a PG16 *_test database
pnpm e2e                # Docker-in-Docker harness — needs Docker
```

Workspace packages: `@shipyard/schema`, `@shipyard/sequence`, `shipyard-server`, `shipyard-agent`,
`shipyard-cli`, `shipyard-web`, `e2e`.
