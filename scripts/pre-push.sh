#!/usr/bin/env bash
# Run from any directory; never bypass a required check.
set -uo pipefail
body='' verdict=''
while (($#)); do
  case "$1" in
    --body|--verdict)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || { echo 'Usage: bash scripts/pre-push.sh --body <file> [--verdict <file>]' >&2; exit 2; }
      if [[ "$1" == --body ]]; then body="$2"; else verdict="$2"; fi
      shift 2 ;;
    *) echo 'Usage: bash scripts/pre-push.sh --body <file> [--verdict <file>]' >&2; exit 2 ;;
  esac
done
[[ -n "$body" ]] || { echo 'Usage: bash scripts/pre-push.sh --body <file> [--verdict <file>]' >&2; exit 2; }
# Preserve caller-relative input paths before moving to the checkout root.
[[ "$body" == /* ]] || body="$PWD/$body"
[[ -z "$verdict" || "$verdict" == /* ]] || verdict="$PWD/$verdict"
cd "$(dirname "$0")/.." || exit 1
status=0
if bash scripts/preflight.sh; then
  echo 'pre-push: preflight PASS'
else
  echo 'pre-push: preflight FAIL (preflight failed)'
  status=1
fi
gate=''
trap '[[ -z "$gate" ]] || rm -rf -- "$gate"' EXIT
# Base-ref files the gate runs. A copied script may import only other copied files; the
# optional helper is absent from a base that predates it, and a base script that does
# import it fails closed in node when the copy is missing. scripts/pre-push.test.mjs
# walks the relative imports of these files and fails if one is not listed.
gate_files=(scripts/validate-pr-body.mjs scripts/provider-enablement-detect.mjs)
gate_optional_files=(scripts/lib/entry-point.mjs)
reason=''
if [[ ! -f "$body" ]]; then reason='body file missing'
elif ! git rev-parse --verify origin/main^{commit} >/dev/null 2>&1; then reason='origin/main missing'
elif ! base=$(git merge-base origin/main HEAD); then reason='merge-base unreachable'
elif ! gate=$(mktemp -d); then reason='temporary directory unavailable'
elif ! canonical_gate=$(cd "$gate" && pwd -P); then reason='temporary directory unavailable'
else
  gate="$canonical_gate"
  mkdir -p "$gate/scripts"
  for file in "${gate_files[@]}"; do
    if ! git show "$base:$file" > "$gate/$file" 2>/dev/null; then reason='base copy missing'; fi
  done
  for file in "${gate_optional_files[@]}"; do
    git cat-file -e "$base:$file" 2>/dev/null || continue
    mkdir -p "$gate/$(dirname "$file")"
    if ! git show "$base:$file" > "$gate/$file" 2>/dev/null; then reason='base copy missing'; fi
  done
  if ! ln -s "$PWD/node_modules" "$gate/node_modules"; then reason='dependency setup failed'; fi
  if ! git diff --name-status --no-renames "$base" HEAD > "$gate/changed-files.txt" ||
     ! git diff --no-renames -U0 "$base" HEAD > "$gate/pr.diff"; then reason='diff unavailable'; fi
fi
if [[ -n "$reason" ]]; then
  echo "pre-push: pr-body-gate FAIL ($reason)"
  echo "pre-push: pr-body-full WARN ($reason)"
  status=1
else
  args=("$gate/scripts/validate-pr-body.mjs" "$body" --changed-files-from "$gate/changed-files.txt" --diff-from "$gate/pr.diff" --base-ref "$base" --head-ref HEAD --verify-links)
  if node "${args[@]}" --skip-unless-enabling > "$gate/gate-output.txt"; then gate_status=0; else gate_status=$?; fi
  cat "$gate/gate-output.txt"
  if [[ "$gate_status" == 0 ]] && grep -Eq '^(PR body validation passed|No provider enablement or gate edit in this diff)' "$gate/gate-output.txt"; then echo 'pre-push: pr-body-gate PASS'
  else echo 'pre-push: pr-body-gate FAIL (validation failed)'; status=1; fi
  if node "${args[@]}" > "$gate/full-output.txt"; then full_status=0; else full_status=$?; fi
  cat "$gate/full-output.txt"
  if [[ "$full_status" == 0 ]] && grep -q '^PR body validation passed' "$gate/full-output.txt"; then echo 'pre-push: pr-body-full PASS'
  else echo 'pre-push: pr-body-full WARN (validation failed)'; fi
fi
if [[ -n "$verdict" ]]; then
  if node --input-type=module - "$verdict" <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractVerdictBlocks, validateVerdict } from './scripts/verdict-schema.mjs';
try {
  const blocks = extractVerdictBlocks(readFileSync(process.argv[2], 'utf8'));
  if (!blocks.length) throw new Error('verdict block missing');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const block of blocks) {
    const value = JSON.parse(block);
    if (!validateVerdict(value).ok || value.sha !== head) throw new Error('invalid or stale verdict');
  }
} catch { process.exitCode = 1; }
NODE
  then echo 'pre-push: verdict PASS'
  else echo 'pre-push: verdict FAIL (invalid, missing or stale verdict)'; status=1; fi
fi
exit "$status"
