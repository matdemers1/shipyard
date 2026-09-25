# A stranger's quick start

The files in this directory are a complete, tunnel-free, D3-Auth-free example install — meant to
work on any clean Linux machine with Docker Engine and Compose v2.2x or v5, nothing else. For the
full walkthrough (a tunnel, a real data root, backups, onboarding apps, issuing an MCP token) see
`../runbooks/install.md`; the parts specific to the D3 Cloud host are only at its very end.

| File | Copy to | Contents |
|---|---|---|
| `compose.example.yml` | `docker-compose.yml` | `postgres` + `server` + `agent`, no tunnel service, server's port published locally for a browser to reach |
| `postgres.env.example` | `postgres.env` | The database's own credentials |
| `server.env.example` | `server.env` | Everything the server reads — `D3AUTH_*` left blank on purpose |
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
