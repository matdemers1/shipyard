---
name: deploy
description: Deploy this repo's app through Shipyard's MCP server — check, dry run, deploy a green SHA from the default branch, follow it to the end, and report the SHA per image and the schema revision. Use when asked to deploy, ship, release, or roll back.
---

# Deploy through Shipyard

Shipyard (`https://shipyard.d3cloud.io/mcp`) is the only way this app reaches production. Never SSH
to the host, edit a compose file, or run `docker compose` there — that is drift, and Shipyard will
refuse the next deploy until it is resolved.

## 1. Know what you are shipping

Call `shipyard_status` for the app (or with no `app` for every app the token covers). It returns
the live SHA, the commits waiting on the default branch with their CI state and Foreman task IDs,
and the newest green commit. Pick the SHA you mean to ship: normally the newest green one, or the
exact commit the user named. It must be on the default branch, green, and ahead of live.

## 2. Dry run

`shipyard_dry_run { app, sha }`. Every gate runs on the host and nothing changes. If a
gate fails, stop and tell the user the refusal's `message` and `fix` verbatim — do not work around
it. Common ones: `ci_not_green` (wait for the workflow), `not_ahead_of_live` (that SHA or a newer
one is already live), `env_missing` (a variable the image declares is absent on the host — only the
operator can add it), `app_frozen` (someone froze it, with a reason), `drift_unresolved`.

## 3. Deploy and follow it

`shipyard_deploy { app, sha, requester: { label: "claude: <repo> <what>", repo, branch } }` (or
`group` instead of `app` for a group: the canary deploys and soaks first, the rest get the same
digests, any failure stops the group). It returns a deploy ID at once. Follow it with
`shipyard_deploy_status { deployId, wait: 25 }` until the state is terminal.

- `locked` — someone else holds the app. Shipyard does not queue: wait for their deploy, then ask again.
- `awaiting_approval` — the app requires a deployer's approval in the console. Tell the user and stop.

## 4. Report

On `succeeded`, report the deploy ID, then for **each image** its service, commit SHA and digest,
and the **schema revision** `/health` reported. On `rolled_back` or `failed`, report the refusal's
message and fix verbatim, and whether the previous release is serving again.

## Rolling back

`shipyard_rollback { app, toDeployId, requester }` returns to an earlier successful deploy, by the
digests the agent recorded. It is refused (`later_contract_release`) past a release that carried a
contract migration — that needs a restore, which is a person's decision in the console, never yours.
