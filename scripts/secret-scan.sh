#!/usr/bin/env bash
# Scans the full git history and working tree for secrets, with no new project dependency: it
# runs gitleaks (SHP-T-6.6) from its official image, pinned to an exact tag. `.gitleaks.toml`
# names the known-fixture allowlist, each entry with a comment saying why it is safe.
#
# Usage: scripts/secret-scan.sh
# Requires Docker. Exits non-zero (gitleaks' own exit code) when an un-allowlisted finding
# remains; prints gitleaks' own report either way.
#
# Pinned image: zricethezav/gitleaks:v8.21.2
# Digest (from `docker pull` on 2026-09-25, offline-unverifiable beyond that pull):
#   sha256:0e99e8821643ea5b235718642b93bb32486af9c8162c8b8731f7cbdc951a7f46
# CI should additionally pin by digest once that digest is reproduced on a runner; this script
# pins by tag, which is what `docker pull` resolves without a registry login.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="zricethezav/gitleaks:v8.21.2"

if ! command -v docker >/dev/null 2>&1; then
  echo "secret-scan.sh needs Docker (to run gitleaks) and none was found on PATH" >&2
  exit 1
fi

# A worktree's `.git` is a file pointing at `<main checkout>/.git/worktrees/<name>` by absolute
# path (see `git worktree`); gitleaks needs that path to resolve, so this mounts the *main*
# checkout — not just this worktree — at its identical absolute path inside the container. A
# plain (non-worktree) checkout has `--git-common-dir` equal to its own `.git`, so this is a no-op
# there.
git_common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
mount_root="$(cd "$(dirname "$git_common_dir")" && pwd)"

report="$repo_root/.gitleaks-report.json"
trap 'rm -f "$report"' EXIT

set +e
docker run --rm \
  -v "$mount_root:$mount_root" \
  -w "$repo_root" \
  "$image" \
  git "$repo_root" \
  --config "$repo_root/.gitleaks.toml" \
  --report-format json \
  --report-path "$report" \
  -v
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "secret-scan.sh: gitleaks found something not in .gitleaks.toml's allowlist:" >&2
  cat "$report" >&2 2>/dev/null || true
  exit "$status"
fi

echo "secret-scan.sh: clean (gitleaks $image, .gitleaks.toml applied)."
