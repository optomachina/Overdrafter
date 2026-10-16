#!/usr/bin/env bash
# Drive the real Overdrafter app with Playwright and capture evidence.
# Usage: verify.sh [--mode fixture|local] [--features auth,quote,provider]
#                  [--prepare] [--doctor] [--dry-run] [-- <extra playwright args>]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$ROOT"

MODE=fixture FEATURES=auth,quote,provider PREPARE=0 DOCTOR=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --features) FEATURES="$2"; shift 2 ;;
    --prepare) PREPARE=1; shift ;;
    --doctor) DOCTOR=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --) shift; break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODE" in fixture|local) ;; *) echo "mode must be fixture or local" >&2; exit 2 ;; esac

SPECS=()
while IFS= read -r line; do SPECS+=("$line"); done < <(node "$HERE/feature-specs.mjs" "$FEATURES" "$MODE")

doctor() {
  local bad=0
  node -e "require.resolve('@playwright/test')" 2>/dev/null || { echo "FAIL @playwright/test missing (npm ci)"; bad=1; }
  for s in "${SPECS[@]}"; do [ -f "$s" ] || { echo "FAIL missing spec $s"; bad=1; }; done
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:4173; then
    echo "WARN port 4173 already serves something; Playwright will reuse it outside CI. Confirm you started it."
  fi
  if [ "$MODE" = local ]; then
    curl -s -o /dev/null --max-time 3 http://127.0.0.1:54321/auth/v1/health || { echo "FAIL local Supabase not answering on 54321 (npm run db:start)"; bad=1; }
    for a in client internal; do
      [ -f "playwright/.auth/$a.json" ] || { echo "FAIL playwright/.auth/$a.json missing (use --prepare)"; bad=1; }
    done
  fi
  [ "$bad" = 0 ] && echo "doctor ok: mode=$MODE specs=${#SPECS[@]}"
  return "$bad"
}

if [ "$DOCTOR" = 1 ]; then doctor; exit $?; fi

if [ "$MODE" = fixture ]; then
  export PLAYWRIGHT_SKIP_AUTH_SETUP=1
  GREP=(--grep @fixture)
else
  GREP=(--grep-invert @fixture)
  if [ "$PREPARE" = 1 ] && [ "$DRY" = 0 ]; then npm run e2e:prepare; fi
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="artifacts/verify-overdrafter/$STAMP"
CMD=(npx playwright test "${SPECS[@]}" "${GREP[@]}" --reporter=list,json --output "$OUT/test-results" "$@")
echo "command: PLAYWRIGHT_JSON_OUTPUT_NAME=$OUT/playwright-report.json ${CMD[*]}"
[ "$DRY" = 1 ] && exit 0

doctor
mkdir -p "$OUT"
export PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/playwright-report.json"
set +e
"${CMD[@]}" 2>&1 | tee "$OUT/run.log"
CODE=${PIPESTATUS[0]}
set -e
{
  echo "mode: $MODE"
  echo "features: $FEATURES"
  echo "specs: ${SPECS[*]}"
  echo "command: ${CMD[*]}"
  echo "git head: $(git rev-parse HEAD)"
  echo "exit code: $CODE"
  [ "$CODE" = 0 ] && echo "verdict: PASS" || echo "verdict: FAIL"
} > "$OUT/manifest.txt"
echo "evidence: $OUT"
exit "$CODE"
