# Security policy

Shipyard runs against a Docker socket and re-verifies deploys against GitHub and GHCR before it
acts — a hole here can mean arbitrary command execution on a host. Please report privately.

## Reporting a vulnerability

Use [GitHub Security Advisories](https://github.com/matdemers1/shipyard/security/advisories/new)
to report a vulnerability privately. Do not open a public issue for a suspected security problem.

Include:

- What you found and why it matters (which non-negotiable in `CLAUDE.md` it breaks, if any).
- Steps to reproduce, or a minimal repro if practical.
- The affected version — the image tag (`sha-<40hex>`) or commit SHA.

There is no bug bounty. A fix is credited to the report once it lands, unless you ask not to be.

## Supported versions

This project ships as `sha-<40hex>` images from `main` only; there are no maintained release
branches. Report against the newest `main`.
