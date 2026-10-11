#!/usr/bin/env bash
# Shared preflight: the same lint, typecheck and unit tests locally and in CI.
# Usage: scripts/preflight.sh [lint|typecheck|test ...]   (no args runs all three)
# Exit codes: 0 pass, 1 code failure, 2 usage error. Each stage prints a
# "preflight: <stage> PASS|FAIL" line so logs separate code failures from
# infra failures (install, network, runner), which fail before any stage starts.
set -uo pipefail

cd "$(dirname "$0")/.."

stages=("$@")
if [ ${#stages[@]} -eq 0 ]; then
  stages=(lint typecheck test)
fi

status=0
for stage in "${stages[@]}"; do
  case "$stage" in
    lint | typecheck | test) ;;
    *)
      echo "preflight: unknown stage '$stage' (expected lint, typecheck, test)" >&2
      exit 2
      ;;
  esac
  echo "preflight: $stage start"
  if npm run --silent "$stage"; then
    echo "preflight: $stage PASS"
  else
    echo "preflight: $stage FAIL"
    status=1
  fi
done

exit "$status"
