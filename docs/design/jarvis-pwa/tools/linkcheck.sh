#!/usr/bin/env bash
# Check every repo path referenced outside "History" sections in SPEC.md and recheck-v4.md exists.
cd "$(git rev-parse --show-toplevel)/docs/design/jarvis-pwa" || exit 2
fail=0; n=0
for f in SPEC.md recheck-v4.md; do
  # drop History sections (from a heading containing "History" to next same-or-higher heading)
  body=$(awk '/^#+ .*History/{h=1;lvl=index($0," ");next} h&&/^#+ /{if(index($0," ")<=lvl)h=0} !h' "$f")
  paths=$(grep -oE '[A-Za-z0-9_./*-]+\.(md|html|js|py|png|json|properties)|screenshots/v4/?|council/[^ `)]*' <<<"$body" | sort -u)
  for p in $paths; do
    case "$p" in http*|*://*) continue;; esac
    n=$((n+1))
    if compgen -G "$p" >/dev/null || compgen -G "../../../$p" >/dev/null || compgen -G "../../$p" >/dev/null || git ls-files --error-unmatch "$p" >/dev/null 2>&1; then echo "OK      $f: $p"; else echo "MISSING $f: $p"; fail=1; fi
  done
done
echo "checked=$n result=$([ $fail = 0 ] && echo PASS || echo FAIL)"; exit $fail
