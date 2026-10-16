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

SPECS_OUT="$(node "$HERE/feature-specs.mjs" "$FEATURES" "$MODE")" || exit 2
SPECS=()
while IFS= read -r line; do [ -n "$line" ] && SPECS+=("$line"); done <<< "$SPECS_OUT"
[ "${#SPECS[@]}" -gt 0 ] || { echo "no specs selected for features=$FEATURES mode=$MODE" >&2; exit 2; }
if [ "$MODE" = fixture ] && [ "$PREPARE" = 1 ]; then echo "--prepare only applies to --mode local" >&2; exit 2; fi

doctor() {
  local bad=0
  node -e "require.resolve('@playwright/test')" 2>/dev/null || { echo "FAIL @playwright/test missing (npm ci)"; bad=1; }
  for s in "${SPECS[@]}"; do [ -f "$s" ] || { echo "FAIL missing spec $s"; bad=1; }; done
  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:4173; then
    echo "FAIL port 4173 already serves something this run did not start; stop it first"; bad=1
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
  unset PLAYWRIGHT_SKIP_AUTH_SETUP
  GREP=(--grep-invert @fixture)
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="artifacts/verify-overdrafter/$STAMP"
CMD=(npx playwright test "${SPECS[@]}" "${GREP[@]}" --reporter=list,json --output "$OUT/test-results" "$@")
echo "command: PLAYWRIGHT_JSON_OUTPUT_NAME=$OUT/playwright-report.json ${CMD[*]}"
[ "$DRY" = 1 ] && exit 0

if [ "$MODE" = local ] && [ "$PREPARE" = 1 ]; then
  curl -s -o /dev/null --max-time 3 http://127.0.0.1:54321/auth/v1/health || { echo "FAIL local Supabase not answering on 54321 (npm run db:start)"; exit 1; }
  npm run e2e:prepare
fi
doctor
mkdir -p "$OUT"
export PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/playwright-report.json"
set +e
"${CMD[@]}" 2>&1 | tee "$OUT/run.log"
CODE=${PIPESTATUS[0]}
set -e
COUNTS="$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const c = { passed: 0, failed: 0, skipped: 0, expectedFail: 0, flaky: 0 };
const walk = (s) => { for (const t of s.specs || []) for (const x of t.tests || []) {
  if (x.status === "skipped") c.skipped++;
  else if (x.status === "expected") { if (x.expectedStatus === "failed") c.expectedFail++; else c.passed++; }
  else if (x.status === "flaky") c.flaky++;
  else c.failed++; }
  (s.suites || []).forEach(walk); };
(r.suites || []).forEach(walk);
console.log(Object.entries(c).map(([k, v]) => k + "=" + v).join(" "));
' "$OUT/playwright-report.json" 2>/dev/null || echo "unavailable")"
DIRTY=clean; [ -z "$(git status --porcelain)" ] || DIRTY=dirty
{
  echo "mode: $MODE"
  echo "features: $FEATURES"
  echo "specs: ${SPECS[*]}"
  echo "command: ${CMD[*]}"
  echo "git head: $(git rev-parse HEAD) ($DIRTY tree)"
  echo "tests: $COUNTS"
  echo "exit code: $CODE"
  [ "$CODE" = 0 ] && echo "verdict: PASS" || echo "verdict: FAIL"
} > "$OUT/manifest.txt"
echo "evidence: $OUT"
exit "$CODE"
