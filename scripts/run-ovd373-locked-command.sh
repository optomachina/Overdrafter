#!/usr/bin/env bash

set -euo pipefail

admission_marker=""
if [[ "${1:-}" = "--admission-marker" ]]; then
  if [[ "$#" -lt 4 ]]; then
    echo "Usage: run-ovd373-locked-command.sh [--admission-marker <path>] <lock-container> <command> [args...]" >&2
    exit 64
  fi
  admission_marker="$2"
  shift 2
fi

if [[ "$#" -lt 2 ]]; then
  echo "Usage: run-ovd373-locked-command.sh [--admission-marker <path>] <lock-container> <command> [args...]" >&2
  exit 64
fi

readonly OVD373_LOCK_CONTAINER="$1"
shift

if [[ "$(docker inspect --format '{{.State.Running}}' "$OVD373_LOCK_CONTAINER" 2>/dev/null)" != "true" ]]; then
  echo "OVD-373 lock holder is not running; guarded command was not started." >&2
  exit 75
fi

if [[ -n "$admission_marker" ]]; then
  if [[ -e "$admission_marker" || -L "$admission_marker" ]]; then
    echo "OVD-373 admission marker already exists; guarded command was not started." >&2
    exit 73
  fi
  if ! mkdir -- "$admission_marker"; then
    echo "OVD-373 admission marker could not be created; guarded command was not started." >&2
    exit 73
  fi
fi

"$@" &
readonly OVD373_COMMAND_PID="$!"

docker wait "$OVD373_LOCK_CONTAINER" >/dev/null &
readonly OVD373_LOCK_WAIT_PID="$!"

(
  while kill -0 "$OVD373_LOCK_WAIT_PID" >/dev/null 2>&1; do
    sleep 0.1
  done
  pkill -TERM -P "$OVD373_COMMAND_PID" >/dev/null 2>&1 || true
  kill -TERM "$OVD373_COMMAND_PID" >/dev/null 2>&1 || true
  for _attempt in {1..20}; do
    if ! kill -0 "$OVD373_COMMAND_PID" >/dev/null 2>&1; then
      exit 0
    fi
    sleep 0.1
  done
  pkill -KILL -P "$OVD373_COMMAND_PID" >/dev/null 2>&1 || true
  kill -KILL "$OVD373_COMMAND_PID" >/dev/null 2>&1 || true
) &
readonly OVD373_WATCHDOG_PID="$!"

command_status=0
wait "$OVD373_COMMAND_PID" || command_status=$?

kill "$OVD373_WATCHDOG_PID" >/dev/null 2>&1 || true
wait "$OVD373_WATCHDOG_PID" >/dev/null 2>&1 || true
pkill -TERM -P "$OVD373_LOCK_WAIT_PID" >/dev/null 2>&1 || true
kill "$OVD373_LOCK_WAIT_PID" >/dev/null 2>&1 || true
wait "$OVD373_LOCK_WAIT_PID" >/dev/null 2>&1 || true

if [[ "$(docker inspect --format '{{.State.Running}}' "$OVD373_LOCK_CONTAINER")" != "true" ]]; then
  echo "OVD-373 lock holder exited while a guarded command was running." >&2
  exit 75
fi

exit "$command_status"
