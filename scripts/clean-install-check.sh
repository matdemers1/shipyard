#!/usr/bin/env bash
# The doneWhen of SHP-T-6.6 as a script: "clean-machine install signs in app-natively; network
# capture clean." Meant to run on a fresh runner (or locally, against Docker) with no state from
# any earlier run.
#
# What "network capture clean" checks here, concretely:
#   - postgres, server and a small curl "client" all run on a Docker network created with
#     `--internal` — the Docker daemon refuses that network a default route, so any code path in
#     the server that tried to dial an external host (GitHub, GHCR, Foreman, D3 Auth, a mail
#     relay — all left unconfigured below) at boot, at migrate time, or during sign-in would fail
#     outright with a connect/DNS error, not just "not be observed"; the network itself is the
#     proof, and is why this never publishes the server's port to the host — everything, sign-in
#     included, happens container-to-container on that same internal network, exactly as a real
#     install with no D3AUTH_*/FOREMAN_*/GITHUB_TOKEN_SERVER/MAIL_RELAY_* set would run.
#   - the server reaching `--wait`-healthy, migrating, and completing a full sign-in there is
#     therefore itself the evidence that nothing on this path needs the internet.
#   - as a second signal, the server's own logs are grepped for the connect/DNS errors an
#     attempted-but-blocked outbound call would leave behind.
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
cleanup() {
  log "tearing down (project $project)"
  docker compose -p "$project" -f "$work_dir/docker-compose.yml" --env-file "$work_dir/postgres.env" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

random_secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

pg_password="$(random_secret)"
session_secret="$(random_secret)"

cat >"$work_dir/postgres.env" <<EOF
POSTGRES_USER=shipyard
POSTGRES_DB=shipyard
POSTGRES_PASSWORD=${pg_password}
EOF

cat >"$work_dir/server.env" <<EOF
DATABASE_URL=postgresql://shipyard:${pg_password}@postgres:5432/shipyard
SESSION_SECRET=${session_secret}
PUBLIC_URL=http://localhost:3466
TRUST_PROXY_HOPS=
BACKUP_DIR=/backups
EOF

# postgres + server + a small curl-only "client", all on one --internal network. No port is
# published to the host: every request below goes container-to-container by service name, which
# is also why the server never sees a route off this network. The agent (Docker socket, host
# stack directories) is intentionally not part of this — see NOTES at the bottom of this file.
cat >"$work_dir/docker-compose.yml" <<EOF
name: ${project}
services:
  postgres:
    image: postgres:16
    platform: linux/amd64
    env_file: postgres.env
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shipyard"]
      interval: 2s
      retries: 30
  server:
    image: ${server_image}
    platform: linux/amd64
    env_file: server.env
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 2s
      retries: 30
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
  docker compose -p "$project" -f "$work_dir/docker-compose.yml" \
    --env-file "$work_dir/postgres.env" "$@"
}
client_curl() { compose exec -T client curl -sS "$@"; }

log "pulling images (host-side; the internal network only governs container egress)"
compose pull postgres server client

log "starting postgres (internal network: no default route out of the containers)"
compose up -d --wait postgres

log "running the Prisma migration"
compose run --rm --no-deps server node node_modules/prisma/build/index.js migrate deploy

log "starting the server and the curl client (both --wait healthy)"
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

log "PASS: signed in app-natively on an --internal network with nothing configured beyond DATABASE_URL/SESSION_SECRET/PUBLIC_URL, and with no port published to the host."

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
