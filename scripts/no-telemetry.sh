#!/usr/bin/env bash
# Static check that runtime code sends no telemetry (SHP-REQ-097, SHP-T-6.6): no literal host
# other than the allowed set appears in a `http://`/`https://`/`ws://`/`wss://` literal under
# runtime source or the built console bundle (apps/web/dist), and every `WebSocket(`,
# `sendBeacon(` and `EventSource(` call site in runtime source is listed for a human reviewer,
# flagged if its argument is a non-relative URL literal outside the allowlist.
#
# Usage: scripts/no-telemetry.sh
# Exits non-zero and lists every offending literal (file:line, host) when something outside the
# allowlist is found.
#
# Known limits (static, best-effort — not a network sandbox):
#   - catches a literal host string (http/https/ws/wss) in source or the built bundle; a host
#     built only from runtime string concatenation, template interpolation of a variable, or
#     decoded from base64/hex at runtime would not be caught by either the URL scan or the
#     call-site check below.
#   - the WebSocket/sendBeacon/EventSource call-site check only flags an argument that is *itself*
#     a string literal; a call site whose URL comes from a variable, a config read, or any
#     computed expression is listed (for a human to eyeball) but not auto-flagged, the same
#     limitation the existing fetch/axios/http(s).request listing below has always had.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Every host runtime code is allowed to reach:
#   - api.github.com                 GitHub API (commit/CI/check status)
#   - github.com                     a "search this SHA" link the console renders (browser-clicked,
#                                     not fetched by our own code)
#   - ghcr.io                        the container registry
#   - pkg-containers.githubusercontent.com   GHCR's anonymous-token realm (from its own
#                                     WWW-Authenticate header, never hardcoded, listed here so a
#                                     reviewer knows it is expected if it ever does appear literally)
#   - localhost / 127.0.0.1          local dev only
# Anything else — FOREMAN_URL, D3AUTH_ISSUER, MAIL_RELAY_URL, the agent's own SHIPYARD_SERVER_URL —
# is read from configuration (apps/*/src/config.ts) and never appears as a literal host in source.
#   - *.example.com                  RFC 2606 placeholder used only in doc comments (e.g.
#                                     apps/agent/src/config.ts's `https://shipyard.example.com`)
# The bundle-only allowlist below adds hosts that appear in the built console but are never
# fetched: react.dev and reactrouter.com are doc links inside React/React Router's own error
# messages (shown as text, never requested), and www.w3.org is the XML namespace URI React uses
# to create SVG/MathML elements (`createElementNS`) — a namespace string, not a network address.
bundle_only_hosts_regex='^(react\.dev|reactrouter\.com|www\.w3\.org)$'
allowed_hosts_regex='^(api\.github\.com|github\.com|ghcr\.io|pkg-containers\.githubusercontent\.com|localhost|127\.0\.0\.1|[A-Za-z0-9-]+\.example\.com)$'

# Runtime source only: excludes tests, node_modules, and the Prisma-generated client (which quotes
# its own docs URLs in comments, not code that runs at request time).
runtime_dirs=(apps/server/src apps/agent/src apps/cli/src packages/schema/src packages/sequence/src apps/web/src)

found_bad=0
findings_file="$(mktemp)"
trap 'rm -f "$findings_file"' EXIT

for dir in "${runtime_dirs[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' file; do
    case "$file" in
      */test/*|*.test.ts|*.test.tsx|*/src/generated/*) continue ;;
    esac
    while IFS= read -r line; do
      lineno="${line%%:*}"
      rest="${line#*:}"
      # Pull every http(s)://  or ws(s):// literal out of this line (there can be more than one).
      while [[ "$rest" =~ (https?|wss?)://([A-Za-z0-9._-]+) ]]; do
        host="${BASH_REMATCH[2]}"
        rest="${rest#*"${BASH_REMATCH[0]}"}"
        if [[ ! "$host" =~ $allowed_hosts_regex ]]; then
          echo "$file:$lineno: disallowed host literal '$host'" >>"$findings_file"
          found_bad=1
        fi
      done
    done < <(grep -n -E 'https?://|wss?://' "$file" || true)
  done < <(find "$dir" -type f \( -name '*.ts' -o -name '*.tsx' \) -print0)
done

# WebSocket(...) / sendBeacon(...) / EventSource(...) call sites: listed for a human reviewer, and
# auto-flagged when the argument is itself a non-relative URL string literal (a scheme, or `//`)
# outside the allowed hosts — the same literal-only limit the URL scan above has.
echo "--- WebSocket / sendBeacon / EventSource call sites in runtime source ---"
for dir in "${runtime_dirs[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r line; do
    echo "$line"
    file="${line%%:*}"
    rest="${line#*:}"
    lineno="${rest%%:*}"
    body="${rest#*:}"
    if [[ "$body" =~ (WebSocket|sendBeacon|EventSource)\(\s*[\'\"\`]([^\'\"\`]+)[\'\"\`] ]]; then
      call_name="${BASH_REMATCH[1]}"
      arg="${BASH_REMATCH[2]}"
      if [[ "$arg" =~ ^([a-zA-Z][a-zA-Z0-9+.-]*)://([A-Za-z0-9._-]+) ]]; then
        host="${BASH_REMATCH[2]}"
        if [[ ! "$host" =~ $allowed_hosts_regex ]]; then
          echo "$file:$lineno: disallowed host literal '$host' in ${call_name}(...)" >>"$findings_file"
          found_bad=1
        fi
      elif [[ "$arg" == //* ]]; then
        echo "$file:$lineno: disallowed protocol-relative URL literal '$arg'" >>"$findings_file"
        found_bad=1
      fi
    fi
  done < <(grep -rn -E '\bWebSocket\(|\bsendBeacon\(|\bEventSource\(' "$dir" --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v '/test/' | grep -v '\.test\.ts' | grep -v '/src/generated/' || true)
done

# Also list every fetch/axios/http(s).request call site under runtime source, for a human reviewer
# to eyeball — a call built from a fully dynamic URL would not show up in the host scan above.
echo "--- fetch / axios / http(s).request call sites in runtime source ---"
for dir in "${runtime_dirs[@]}"; do
  [ -d "$dir" ] || continue
  grep -rn -E '\bfetch\(|axios\.|\bhttps?\.request\(' "$dir" --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v '/test/' | grep -v '\.test\.ts' | grep -v '/src/generated/' || true
done

if [ "$found_bad" -ne 0 ]; then
  echo "--- disallowed host literals ---" >&2
  cat "$findings_file" >&2
  exit 1
fi
echo "no-telemetry.sh: no disallowed host literal found under ${runtime_dirs[*]}."

# The built console must be fully self-hosted: no third-party origin (fonts, analytics, CDNs) in
# the built bundle. Only checked when a build exists — callers that want this enforced should
# build apps/web first (`pnpm --filter shipyard-web build`), which CI's console job already does.
web_dist="apps/web/dist"
if [ -d "$web_dist" ]; then
  third_party="$(grep -rohE '(https?|wss?)://[A-Za-z0-9._-]+' "$web_dist" 2>/dev/null \
    | sed -E 's#(https?|wss?)://##' \
    | sort -u \
    | grep -vE "$allowed_hosts_regex" \
    | grep -vE "$bundle_only_hosts_regex" || true)"
  if [ -n "$third_party" ]; then
    echo "no-telemetry.sh: apps/web/dist references third-party origins:" >&2
    echo "$third_party" >&2
    exit 1
  fi
  echo "no-telemetry.sh: apps/web/dist is self-hosted (no third-party origin found)."
else
  echo "no-telemetry.sh: apps/web/dist not built; skipping the bundle-origin check (build it with 'pnpm --filter shipyard-web build' to include it)."
fi
