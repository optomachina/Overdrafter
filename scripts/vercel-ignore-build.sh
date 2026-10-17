#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json ignoreCommand). OVD-890.
# Vercel semantics: exit 0 = SKIP the build, exit 1 = BUILD.
# Skips only when every changed file is docs/tooling-only; any error builds.
set -u

build() {
  echo "vercel-ignore-build: BUILD - $1"
  exit 1
}

skip() {
  echo "vercel-ignore-build: SKIP - $1"
  exit 0
}

if [ "${VERCEL_ENV:-}" = "production" ]; then
  build "production deployment"
fi
if [ "${VERCEL_GIT_COMMIT_REF:-}" = "main" ]; then
  build "main branch"
fi

export GIT_TERMINAL_PROMPT=0

resolve_commit() {
  git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null
}

base=""
base_source=""
previous_sha="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -n "$previous_sha" ]; then
  base="$(resolve_commit "$previous_sha")"
  if [ -z "$base" ] && [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    # Vercel clones shallowly; try to fetch the previous deployment's commit.
    git fetch --quiet --depth=100 origin "$previous_sha" >/dev/null 2>&1
    base="$(resolve_commit "$previous_sha")"
  fi
  [ -n "$base" ] && base_source="previous deployment"
fi

if [ -z "$base" ]; then
  for ref in origin/main main; do
    if resolve_commit "$ref" >/dev/null; then
      base="$(git merge-base "$ref" HEAD 2>/dev/null)"
      if [ -n "$base" ]; then
        base_source="merge-base with $ref"
        break
      fi
    fi
  done
fi

if [ -z "$base" ]; then
  build "no comparable base commit"
fi

if ! changed="$(git -c core.quotePath=false diff --no-renames --name-only "$base" HEAD 2>/dev/null)"; then
  build "git diff failed against $base_source"
fi
if [ -z "$changed" ]; then
  build "empty diff against $base_source"
fi

count=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  count=$((count + 1))
  # Build inputs that the skip patterns below would otherwise match: scripts run
  # by package.json "build", vite plugins imported by vite.config.ts, and
  # markdown under public/ (copied into dist). scripts/jarvis-demo/ stays
  # skippable: no api/ function reaches server/design-graph/cad-agent.ts.
  case "$file" in
    scripts/verify-public-assets.mjs | scripts/verify-mobile-auth-build.mjs | scripts/vite-* | public/*)
      build "build-input change vs $base_source: $file" ;;
  esac
  case "$file" in
    docs/* | scripts/* | .github/* | supabase/tests/* | *.md) ;;
    *) build "app-affecting change vs $base_source: $file" ;;
  esac
done <<EOF
$changed
EOF

skip "$count docs/tooling-only file(s) changed vs $base_source"
