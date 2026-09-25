#!/usr/bin/env bash
# The doneWhen of SHP-T-6.6 as a script: "clean-machine install signs in app-natively; network
# capture clean." Meant to run on a fresh runner (or locally, against Docker) with no state from
# any earlier run.
#
# This exercises the documented path, not a lookalike: it copies docs/install/compose.example.yml
# and the three *.env.example templates verbatim, sets the image tag the exact same way the
# README's Quick start tells a reader to (the same `sed` one-liner, against a literal
# `sha-<40hex>` tag — the compose file is never `${...}`-interpolated, see the README and
# docs/runbooks/install.md for why), and only then layers one small `-f` override on top.
#
# That override does three things, and nothing else:
#   - adds `internal: true` to the default network, so the Docker daemon refuses it a default
#     route. Any code path in the server that tried to dial an external host (GitHub, GHCR,
#     Foreman, D3 Auth, a mail relay — all left unconfigured below) at boot, at migrate time, or
#     during sign-in would fail outright with a connect/DNS error, not just "not be observed"; the
#     network itself is the proof.
#   - resets the server's `ports:` to empty (`!reset []`), so nothing is published to the host —
#     everything, sign-in included, happens container-to-container on that same internal network,
#     exactly as a real install behind a tunnel (docs/runbooks/install.md) would run. This is the
#     one place this script structurally cannot use the tunnel-free example's own port mapping,
#     since the whole point is to prove nothing needed a route out, not to open a route in.
#   - adds a `healthcheck` to the documented `server` service (the example file has none — a real
#     install just polls `/api/health` by hand) and a throwaway `curl` client service, so `--wait`
#     and every request below can run container-to-container with no host-side polling loop. A
#     `platform: linux/amd64` pin is added too, since only that architecture is published.
#
# What this does NOT check: the agent (Docker socket, host stack directories) is not started here
# — bringing it up would touch the calling machine's real Docker daemon and stacks, which the
# doneWhen ("signs in app-natively") does not need. See NOTES at the bottom.
#
# Usage: IMAGE_TAG=sha-<40hex> scripts/clean-install-check.sh
# Requires Docker. Always tears down (`down -v`) on exit, success or failure.

set -euo pipefail

image_tag="${IMAGE_TAG:-sha-457eb0b392c2c18175ec235ba3841157c9544aa3}"
fallback_tag="sha-457eb0b392c2c18175ec235ba3841157c9544aa3"
project="shipyard-cic-$$"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[clean-install-check] %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "clean-install-check.sh needs Docker and none was found on PATH" >&2
  exit 1
fi

server_image="ghcr.io/matdemers1/shipyard/server:${image_tag}"

if ! docker manifest inspect "$server_image" >/dev/null 2>&1; then
  if [ "$image_tag" != "$fallback_tag" ]; then
    log "image tag '$image_tag' not found on GHCR; falling back to '$fallback_tag'"
    image_tag="$fallback_tag"
    server_image="ghcr.io/matdemers1/shipyard/server:${image_tag}"
  fi
  if ! docker manifest inspect "$server_image" >/dev/null 2>&1; then
    echo "clean-install-check.sh: neither the requested tag nor the fallback ($fallback_tag) exists on GHCR" >&2
    exit 1
  fi
fi
log "using image tag $image_tag"

work_dir="$(mktemp -d -t shipyard-cic-XXXXXX)"
compose_files=(-f "$work_dir/docker-compose.yml" -f "$work_dir/docker-compose.check-override.yml")
cleanup() {
  log "tearing down (project $project)"
  docker compose -p "$project" "${compose_files[@]}" --env-file "$work_dir/postgres.env" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

random_secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# --- Steps 1–3 of "A stranger's quick start" (docs/install/README.md): copy the four documented
# files verbatim (renamed the same way the README tells a reader to), and fill in the two
# generated secrets the same way it tells a reader to. -----------------------------------------
log "copying docs/install's documented files (not a rewritten lookalike)"
cp "$repo_root/docs/install/compose.example.yml" "$work_dir/docker-compose.yml"
cp "$repo_root/docs/install/postgres.env.example" "$work_dir/postgres.env"
cp "$repo_root/docs/install/server.env.example" "$work_dir/server.env"
cp "$repo_root/docs/install/agent.env.example" "$work_dir/agent.env"
mkdir -p "$work_dir/data/apps" "$work_dir/data/agent" "$work_dir/data/backups"

pg_password="$(random_secret)"
session_secret="$(random_secret)"

sed -i.bak "s/<random>/${pg_password}/" "$work_dir/postgres.env"
sed -i.bak "s/<random>/${pg_password}/" "$work_dir/server.env"
sed -i.bak "s/<random 32 bytes hex>/${session_secret}/" "$work_dir/server.env"
rm -f "$work_dir"/*.bak

# The exact command the README's Quick start gives the reader, against the exact placeholder the
# example file ships with — proves the documented tag step actually resolves both image lines.
log "setting the image tag the same way the README's Quick start does"
sed -i.bak "s/sha-<40hex>/${image_tag}/g" "$work_dir/docker-compose.yml" && rm -f "$work_dir/docker-compose.yml.bak"
if grep -q 'sha-<40hex>' "$work_dir/docker-compose.yml"; then
  echo "clean-install-check.sh: the README's sed step left an unresolved sha-<40hex> in docker-compose.yml" >&2
  exit 1
fi

# The one override this check adds on top of the documented files — see the header comment.
cat >"$work_dir/docker-compose.check-override.yml" <<EOF
services:
  postgres:
    platform: linux/amd64
  server:
    platform: linux/amd64
    ports: !reset []
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 2s
      retries: 30
  agent:
    platform: linux/amd64
  client:
    image: curlimages/curl:8.11.1
    platform: linux/amd64
    entrypoint: ["sleep", "infinity"]
    depends_on:
      server:
        condition: service_healthy
networks:
  default:
    internal: true
EOF

compose() {
  docker compose -p "$project" "${compose_files[@]}" \
    --env-file "$work_dir/postgres.env" "$@"
}
client_curl() { compose exec -T client curl -sS "$@"; }

log "resolved config (documented files + the one internal-network/no-port override)"
compose config >/dev/null

log "pulling images (host-side; the internal network only governs container egress)"
compose pull postgres server client

log "starting postgres (internal network: no default route out of the containers)"
compose up -d --wait postgres

log "running the Prisma migration"
compose run --rm --no-deps server node node_modules/prisma/build/index.js migrate deploy

log "starting the server and the curl client (both --wait healthy; agent is not started, see NOTES)"
compose up -d --wait server client

log "GET /api/health, from the client container over the internal network"
health="$(client_curl "http://server:3300/api/health")"
echo "$health"
echo "$health" | grep -q '"status":"ok"'

# --- bootstrap-admin, non-interactively -------------------------------------------------------
# apps/server/src/cli/bootstrap-admin.ts already supports this with no code change:
# resolvePassword() reads BOOTSTRAP_PASSWORD from the environment before it ever checks for a
# TTY, so this needs no `script`/expect trick and no new flag on the CLI.
admin_email="admin@example.com"
admin_password="a-clean-install-check-password"
log "bootstrap-admin (BOOTSTRAP_PASSWORD, no TTY)"
bootstrap_out="$(compose exec -T -e BOOTSTRAP_PASSWORD="$admin_password" server \
  node dist/cli/bootstrap-admin.js --email "$admin_email" --name "Clean Install Check")"
echo "$bootstrap_out"
totp_secret="$(printf '%s\n' "$bootstrap_out" | sed -n 's/^TOTP secret (base32, enrol it now — this is the only time it is shown): //p')"
if [ -z "$totp_secret" ]; then
  echo "clean-install-check.sh: could not read the TOTP secret out of bootstrap-admin's output" >&2
  exit 1
fi

# --- sign in through the real API, exactly as the console does -------------------------------
cookie_jar="/tmp/shipyard-cic-cookies"  # inside the client container; not the host's /tmp
log "POST /api/auth/login"
login_status="$(client_curl -o /tmp/login.json -w '%{http_code}' -c "$cookie_jar" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${admin_email}\",\"password\":\"${admin_password}\"}" \
  "http://server:3300/api/auth/login")"
[ "$login_status" = "200" ] || {
  echo "login step failed ($login_status):" >&2
  client_curl -s "http://server:3300/api/auth/login" >/dev/null 2>&1 || true
  compose exec -T client cat /tmp/login.json >&2 || true
  exit 1
}

log "computing the current TOTP code with the server image's own node_modules/otpauth"
totp_code="$(compose exec -T server node -e "
const { TOTP, Secret } = require('otpauth');
const t = new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(process.argv[1]) });
process.stdout.write(t.generate());
" "$totp_secret")"

log "POST /api/auth/totp"
totp_status="$(client_curl -o /tmp/totp.json -w '%{http_code}' -b "$cookie_jar" -c "$cookie_jar" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"${totp_code}\"}" \
  "http://server:3300/api/auth/totp")"
if [ "$totp_status" != "200" ]; then
  echo "totp step failed ($totp_status):" >&2
  compose exec -T client cat /tmp/totp.json >&2 || true
  exit 1
fi
compose exec -T client cat /tmp/totp.json

log "GET /api/auth/me with the session cookie"
me="$(client_curl -b "$cookie_jar" "http://server:3300/api/auth/me")"
echo "$me"
echo "$me" | grep -q "\"email\":\"${admin_email}\""

log "server logs: looking for any outbound-connection error since boot"
if compose logs server 2>&1 | grep -iE 'ENOTFOUND|ECONNREFUSED.*(github|ghcr|foreman)|getaddrinfo'; then
  echo "clean-install-check.sh: the server's own logs show an attempted (and, on this internal network, failed) outbound connection — unexpected with FOREMAN_URL/GITHUB_TOKEN_SERVER/D3AUTH_* all unset" >&2
  exit 1
fi

log "PASS: signed in app-natively, from docs/install's own compose file and env templates plus" \
  "one internal-network/no-published-port override, with nothing configured beyond" \
  "DATABASE_URL/SESSION_SECRET/PUBLIC_URL, and with no port published to the host."

# NOTES
# - The agent is not started by this script. Its own boot (Ed25519 key generation, enrolment
#   long-poll to the server) needs no external network either, but exercising it here would mount
#   the calling machine's real Docker socket into a throwaway container, which is not something
#   this task should do to whatever machine runs it. A separate check could start the agent
#   against this same server (still on an --internal network, since it only ever talks to the
#   server) without a socket mount other than a scratch one, if that is wanted later.
# - The client container (curlimages/curl) exists only so every HTTP call — health, login, totp,
#   me — happens container-to-container on the same --internal network as the server; nothing is
#   published to the host, matching a real install (docs/runbooks/install.md: "publishes no
#   ports"). That is what makes the internal network a meaningful proof rather than a formality.
# - The override file resets the server's `ports:` and adds `internal: true` — the two things a
#   tunnel-free *local* quick start cannot itself demonstrate are unnecessary, since it deliberately
#   publishes the port for a browser to reach. Everything else in this run — the compose file, the
#   three env templates, and the image-tag step — is the README's documented path, unmodified.
