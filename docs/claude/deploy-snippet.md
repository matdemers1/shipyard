<!-- Shipyard deploy snippet (SHP-REQ-089). Paste into a managed repo's CLAUDE.md, unchanged. -->
## Deploying — through Shipyard, never by hand

This app is deployed by **Shipyard** (`https://shipyard.d3cloud.io`). Deploy through its MCP server,
never over SSH: no `sed` on a compose file, no `docker compose pull/up` on the host. A deploy done by
hand is drift, and Shipyard refuses the next one until someone resolves it.

- **Connect once:** remote MCP server `https://shipyard.d3cloud.io/mcp`, header
  `Authorization: Bearer <token>`. A token is scoped to the apps it names; ask the operator for one
  (`host-admin issue-token --apps <app>` on the host). Never paste it into a file in this repo.
- **What exists:** `shipyard_status` (live release, commits waiting, CI) · `shipyard_dry_run` ·
  `shipyard_deploy` (an `app`, or a `group`, and a 40-hex `sha`) · `shipyard_deploy_status` ·
  `shipyard_rollback` (to an earlier successful deploy, from the agent's own ledger).
- **What you can deploy:** only a SHA on the default branch whose image workflow is green and that
  is ahead of what is live. Shipyard re-checks all of it on the host; a refusal names the gate and
  the fix — read it, don't retry the same call.
- **Every deploy request names you:** `requester: { label: "claude: <repo> <what>", repo, branch }`.
  The label is what someone locked out will see.
- **Shipyard never queues.** `locked` means someone else is deploying: wait for their deploy to
  finish (`shipyard_deploy_status`), then ask again.
- **Approval-required apps** (d3auth) wait for a deployer to approve in the console; say so and stop
  there rather than polling for an hour.
- **Migrations:** put a `Shipyard-Migration: expand|contract|none` trailer on the commit that
  changes the schema (default `none`). A `contract` release is never auto-rolled back — if it fails,
  Shipyard stops it on the new image, and a restore is a person's decision in the console.
- **When it finishes, report** the deploy ID, the final state, the commit SHA **per image**, and the
  schema revision `/health` reports — `shipyard_deploy_status` returns all of them. On a
  `rolled_back` or `failed`, report the refusal's message and fix verbatim.
