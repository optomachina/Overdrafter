#!/usr/bin/env bash
# Drive the real Overdrafter app with Playwright and capture evidence.
# Usage: verify.sh [--mode fixture|local] [--features auth,quote,provider]
#                  [--prepare] [--doctor] [--dry-run] [--out DIR] [-- <extra playwright args>]
# VERIFY_APP_ROOT drives a different checkout with this harness (CI uses the
# base harness against the PR head, see ../run).
# Exit: 0 PASS, 1 FAIL, 2 usage error, 3 INCOMPLETE (skips, zero passes or no counts).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${VERIFY_APP_ROOT:-$HERE/../../../..}" && pwd)"
cd "$ROOT"

MODE=fixture FEATURES=auth,quote,provider PREPARE=0 DOCTOR=0 DRY=0 OUT=
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2-}"; shift 2 || { echo "--mode needs a value" >&2; exit 2; } ;;
    --features) FEATURES="${2-}"; shift 2 || { echo "--features needs a value" >&2; exit 2; } ;;
    --prepare) PREPARE=1; shift ;;
    --doctor) DOCTOR=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --out) OUT="${2-}"; shift 2 || { echo "--out needs a value" >&2; exit 2; } ;;
    --) shift; break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODE" in fixture|local) ;; *) echo "mode must be fixture or local" >&2; exit 2 ;; esac
if [ "$MODE" = fixture ] && [ "$PREPARE" = 1 ]; then echo "--prepare only applies to --mode local" >&2; exit 2; fi

# One "SKIPPED\t<feature>" line per feature with no specs in this mode, then one
# "<config>\t<spec>" line per spec; non-zero for unknown or empty features, a
# single feature with no specs in this mode, or a selection that leaves no specs.
SPECS_OUT="$(node "$HERE/feature-specs.mjs" "$FEATURES" "$MODE")" || exit 2
CONFIGS=() SPECS=() SKIPPED=()
SKIP_NOTE="SKIPPED: no $MODE specs"
while IFS=$'\t' read -r cfg spec; do
  [ -n "$spec" ] || continue
  if [ "$cfg" = SKIPPED ]; then
    SKIPPED+=("$spec")
    echo "feature $spec: $SKIP_NOTE (not run, not counted as a pass)"
    continue
  fi
  SPECS+=("$spec")
  case " ${CONFIGS[*]-} " in *" $cfg "*) ;; *) CONFIGS+=("$cfg") ;; esac
done <<< "$SPECS_OUT"
[ "${#SPECS[@]}" -gt 0 ] || { echo "no specs selected for features=$FEATURES mode=$MODE" >&2; exit 2; }

specs_for_config() {
  while IFS=$'\t' read -r cfg spec; do [ "$cfg" = "$1" ] && printf '%s\n' "$spec"; done <<< "$SPECS_OUT"
}

port_for_config() {
  # argv[1] is a placeholder so feature-specs.mjs does not see itself as the entry point.
  node --input-type=module -e 'const { CONFIG_PORTS } = await import(process.argv[2]); console.log(CONFIG_PORTS[process.argv[3]] ?? "")' \
    port "$HERE/feature-specs.mjs" "$1"
}

# True when anything (HTTP or not) accepts TCP connections on the port.
port_in_use() {
  timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null
}

isolation() {
  node "$HERE/isolation.mjs"
}

doctor() {
  local bad=0 cfg port
  isolation || bad=1
  if node -e "require.resolve('@playwright/test')" 2>/dev/null; then
    # Launch Chromium the way playwright.config.ts does (sandboxed; installed Chrome in CI),
    # so a missing browser build or an unusable sandbox fails here, not in global setup.
    node -e "require('@playwright/test').chromium.launch({ chromiumSandbox: true, channel: process.env.CI === 'true' ? 'chrome' : undefined }).then((b) => b.close())" >/dev/null 2>&1 ||
      { echo "FAIL Playwright cannot launch sandboxed Chromium (browser build missing for this @playwright/test, or running as root)"; bad=1; }
  else echo "FAIL @playwright/test missing (npm ci)"; bad=1
  fi
  for s in "${SPECS[@]}"; do [ -f "$s" ] || { echo "FAIL missing spec $s"; bad=1; }; done
  for cfg in "${CONFIGS[@]}"; do
    [ -f "$cfg" ] || { echo "FAIL missing config $cfg"; bad=1; }
    port="$(port_for_config "$cfg")"
    if [ -z "$port" ]; then echo "FAIL no port recorded for $cfg in feature-specs.mjs"; bad=1
    elif port_in_use "$port"; then echo "FAIL port $port already has a listener this run did not start; stop it first"; bad=1
    fi
  done
  if [ "$MODE" = local ]; then
    curl -s -o /dev/null --max-time 3 http://127.0.0.1:54321/auth/v1/health || { echo "FAIL local Supabase not answering on 54321 (npm run db:start)"; bad=1; }
    for a in client internal; do
      [ -f "playwright/.auth/$a.json" ] || { echo "FAIL playwright/.auth/$a.json missing (use --prepare)"; bad=1; }
    done
  fi
  [ "$bad" = 0 ] && echo "doctor ok: mode=$MODE specs=${#SPECS[@]} configs=${#CONFIGS[@]}"
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

# Absolute: Playwright resolves relative report paths against each config's directory.
if [ -z "$OUT" ]; then OUT="$ROOT/artifacts/verify-overdrafter/$(date -u +%Y%m%dT%H%M%SZ)"
elif [ "${OUT#/}" = "$OUT" ]; then OUT="$ROOT/$OUT"
fi
EXTRA=("$@")
command_for() { # <index> <config>
  local i="$1" cfg="$2" specs=()
  while IFS= read -r s; do specs+=("$s"); done < <(specs_for_config "$cfg")
  CMD=(npx playwright test --config "$cfg" "${specs[@]}" "${GREP[@]}" --reporter=list,json --output "$OUT/test-results-$i" "${EXTRA[@]+"${EXTRA[@]}"}")
}
for i in "${!CONFIGS[@]}"; do
  command_for "$i" "${CONFIGS[$i]}"
  echo "command: PLAYWRIGHT_JSON_OUTPUT_NAME=$OUT/playwright-report-$i.json ${CMD[*]}"
done
[ "$DRY" = 1 ] && exit 0

if [ "$MODE" = local ] && [ "$PREPARE" = 1 ]; then
  isolation || exit 1
  curl -s -o /dev/null --max-time 3 http://127.0.0.1:54321/auth/v1/health || { echo "FAIL local Supabase not answering on 54321 (npm run db:start)"; exit 1; }
  npm run e2e:prepare
fi
doctor
mkdir -p "$OUT"
RUNS=() COMMANDS=()
for i in "${!CONFIGS[@]}"; do
  command_for "$i" "${CONFIGS[$i]}"
  COMMANDS+=("${CMD[*]}")
  set +e
  PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/playwright-report-$i.json" "${CMD[@]}" 2>&1 | tee -a "$OUT/run.log"
  CODE=${PIPESTATUS[0]}
  set -e
  RUNS+=("$CODE:$OUT/playwright-report-$i.json")
done
set +e
RESULT="$(node "$HERE/verdict.mjs" "${RUNS[@]}")"
VERDICT_CODE=$?
set -e
DIRTY=clean; [ -z "$(git status --porcelain)" ] || DIRTY=dirty
{
  echo "mode: $MODE"
  echo "features: $FEATURES"
  if [ "${#SKIPPED[@]}" -gt 0 ]; then echo "skipped features: ${SKIPPED[*]} ($SKIP_NOTE)"; else echo "skipped features: none"; fi
  echo "specs: ${SPECS[*]}"
  echo "configs: ${CONFIGS[*]}"
  for c in "${COMMANDS[@]}"; do echo "command: $c"; done
  echo "git head: $(git rev-parse HEAD) ($DIRTY tree)"
  echo "exit codes: ${RUNS[*]%%:*}"
  echo "$RESULT"
} > "$OUT/manifest.txt"
tail -n 2 "$OUT/manifest.txt"
echo "evidence: $OUT"
exit "$VERDICT_CODE"
