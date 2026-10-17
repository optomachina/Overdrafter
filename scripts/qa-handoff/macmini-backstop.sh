#!/usr/bin/env bash
# Hourly QA handoff backstop for the Mac mini (OVD-865). Catches PRs whose
# workflow_run event was missed: scans every open PR against main at its
# current head and applies the same gate and marker check as the workflow.
#
# Usage: scripts/qa-handoff/macmini-backstop.sh [report|apply]   (default report)
# Needs node 20+ and an authenticated gh CLI (or GH_TOKEN in the environment).
# Run it from a checkout of main that is kept current, never a PR branch.
set -euo pipefail

cd "$(dirname "$0")/../.."

mode="${1:-${QA_HANDOFF_MODE:-report}}"
repo="${QA_HANDOFF_REPO:-optomachina/Overdrafter}"

if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  GH_TOKEN="$(gh auth token)"
  export GH_TOKEN
fi

# Markers the backstop writes are authored by this gh user, so trust them
# alongside github-actions[bot] (DEFAULT_TRUSTED_MARKER_AUTHORS in gate.mjs,
# which run.mjs always adds); markers from anyone else are ignored. The
# workflow's QA_HANDOFF_TRUSTED_MARKER_AUTHORS repo variable must list this
# same login, or the workflow will not honor the backstop's markers.
login="$(gh api user --jq .login)"
QA_HANDOFF_TRUSTED_MARKER_AUTHORS="${QA_HANDOFF_TRUSTED_MARKER_AUTHORS:+${QA_HANDOFF_TRUSTED_MARKER_AUTHORS},}${login}"
export QA_HANDOFF_TRUSTED_MARKER_AUTHORS

exec node scripts/qa-handoff/run.mjs --repo "$repo" --mode "$mode"
