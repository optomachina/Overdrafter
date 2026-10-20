#!/usr/bin/env bash
# Shared preflight: the same lint, typecheck and unit tests locally and in CI.
# Locally, when Docker is unavailable, test skips three Docker-dependent cases; CI never skips
# (a non-empty CI or GITHUB_ACTIONS disables the skip).
# Usage: scripts/preflight.sh [lint|typecheck|test ...]   (no args runs all three)
# Exit codes: 0 pass, 1 code failure, 2 usage error. Each stage prints a
# "preflight: <stage> PASS|FAIL" line so logs separate code failures from
# infra failures (install, network, runner), which fail before any stage starts.
set -uo pipefail
unset OVD_PREFLIGHT_DOCKER_UNAVAILABLE

cd "$(dirname "$0")/.."

stages=("$@")
if [ ${#stages[@]} -eq 0 ]; then
  stages=(lint typecheck test)
fi

docker_only_tests=(
  "rejects 'a routing override' before qualification"
  "rejects 'duplicate databases' before qualification"
  "rejects 'non-empty evidence' before qualification"
)

docker_unavailable() {
  ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1
}

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
  summary=""
  if [ "$stage" = test ] && [ -z "${CI:-}" ] && [ -z "${GITHUB_ACTIONS:-}" ] && docker_unavailable; then
    for test_name in "${docker_only_tests[@]}"; do
      echo "preflight: SKIPPED scripts/qualify-ovd417-four-migration-suffix.test.mjs > OVD-417 local qualification harness > $test_name (docker unavailable)"
    done
    summary=" (${#docker_only_tests[@]} docker tests SKIPPED: docker unavailable)"
    OVD_PREFLIGHT_DOCKER_UNAVAILABLE=1 npm run --silent "$stage"
    result=$?
  else
    npm run --silent "$stage"
    result=$?
  fi
  if [ "$result" -eq 0 ]; then
    echo "preflight: $stage PASS$summary"
  else
    echo "preflight: $stage FAIL$summary"
    status=1
  fi
done

exit "$status"
