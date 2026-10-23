#!/usr/bin/env bash
# Shared preflight: the same lint, typecheck and unit tests locally and in CI.
# Locally, when Docker is unavailable, test skips three Docker-dependent cases; CI never skips
# (a non-empty CI or GITHUB_ACTIONS disables the skip).
# Usage: scripts/preflight.sh [lint|typecheck|test ...]   (no args runs all three)
#        scripts/preflight.sh <stage> -- <args>   (passes args to that one stage,
#        e.g. test -- --shard=1/3 as the CI unit shards do)
# Exit codes: 0 pass, 1 code failure, 2 usage error. Each stage prints a
# "preflight: <stage> PASS|FAIL" line so logs separate code failures from
# infra failures (install, network, runner), which fail before any stage starts.
set -uo pipefail
unset OVD_PREFLIGHT_DOCKER_UNAVAILABLE

cd "$(dirname "$0")/.."

# Only "<stage> -- <args>" passes arguments: "$@" then holds "-- <args>" for that
# stage's npm run, and note names the arguments in the stage lines, so a
# filtered or sharded run never reads as a plain full-suite PASS. Keep this
# parsing free of new conditional assignments: the proposed guard-migrations
# hook reads this file and fails closed past 32 variable combinations.
[ $# -gt 0 ] || set -- lint typecheck test
if [ $# -ge 2 ] && [ "$2" = "--" ]; then
  stages=("$1")
  shift
else
  stages=("$@")
  set --
fi
note="${2:+ (args: ${*:2})}"

for stage in "${stages[@]}"; do
  case "$stage" in
    lint | typecheck | test) ;;
    --)
      echo "preflight: arguments after -- need exactly one stage" >&2
      exit 2
      ;;
    *)
      echo "preflight: unknown stage '$stage' (expected lint, typecheck, test)" >&2
      exit 2
      ;;
  esac
done

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
  echo "preflight: $stage start$note"
  summary="$note"
  if [ "$stage" = test ] && [ -z "${CI:-}" ] && [ -z "${GITHUB_ACTIONS:-}" ] && docker_unavailable; then
    for test_name in "${docker_only_tests[@]}"; do
      echo "preflight: SKIPPED scripts/qualify-ovd417-four-migration-suffix.test.mjs > OVD-417 local qualification harness > $test_name (docker unavailable)"
    done
    summary="$note (${#docker_only_tests[@]} docker tests SKIPPED: docker unavailable)"
    OVD_PREFLIGHT_DOCKER_UNAVAILABLE=1 npm run --silent "$stage" "$@"
    result=$?
  else
    npm run --silent "$stage" "$@"
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
