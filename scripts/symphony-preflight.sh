#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root_dir"

first_line=$(sed -n '1p' README.md 2>/dev/null || true)

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ "$first_line" = "# OverDrafter Curated CNC Quote Platform" ] || fail "Symphony preflight failed: README.md does not identify this repo as OverDrafter."
[ -f PRD.md ] || fail "Symphony preflight failed: PRD.md is missing."
[ -f PLAN.md ] || fail "Symphony preflight failed: PLAN.md is missing."
[ -f AGENTS.md ] || fail "Symphony preflight failed: AGENTS.md is missing."
[ -f package.json ] || fail "Symphony preflight failed: package.json is missing."
[ -d worker ] || fail "Symphony preflight failed: worker/ is missing."
[ -d supabase ] || fail "Symphony preflight failed: supabase/ is missing."

origin_url=$(git config --get remote.origin.url 2>/dev/null || true)
case "$origin_url" in
  *optomachina/Overdrafter.git|*optomachina/Overdrafter)
    ;;
  "")
    fail "Symphony preflight failed: origin remote is not configured."
    ;;
  *)
    fail "Symphony preflight failed: origin remote does not point to optomachina/Overdrafter."
    ;;
esac

printf '%s\n' "Symphony preflight passed for OverDrafter."
