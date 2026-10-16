#!/usr/bin/env bash
# Runs the proof check command given as arguments and applies the mode policy
# to its exit code: in report mode any non-zero exit (bad arguments, an
# uncaught exception) becomes a warning annotation, an ERROR line in the job
# summary and exit 0; PROOF_CHECK_MODE=enforce passes the exit code through.
# Usage: PROOF_CHECK_MODE=report scripts/proof-check-run.sh node scripts/proof-check.mjs --changed-files <file>
set -uo pipefail
"$@"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "::warning title=Proof check::proof-check exited $rc (report mode, not failing the job)"
  printf '### Proof check: ERROR\n\nproof-check exited %s.\n' "$rc" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  [ "${PROOF_CHECK_MODE:-report}" = enforce ] && exit "$rc"
fi
exit 0
