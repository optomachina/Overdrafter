#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json ignoreCommand). OVD-890.
# Vercel semantics: exit 0 = SKIP the build, exit 1 = BUILD.
# Skips draft/no-PR previews, then docs/tooling-only changes; uncertainty builds.
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

if [ "${VERCEL_ENV:-}" != "preview" ]; then
  build "not a preview deployment"
fi
if [ "${VERCEL_GIT_PROVIDER:-github}" != "github" ]; then
  build "not a GitHub deployment"
fi
owner="${VERCEL_GIT_REPO_OWNER:-}"
repo="${VERCEL_GIT_REPO_SLUG:-}"
branch="${VERCEL_GIT_COMMIT_REF:-}"
if [ -z "$owner" ] || [ -z "$repo" ] || [ -z "$branch" ]; then
  build "missing GitHub branch metadata"
fi
case "$owner/$repo" in
  *[!a-zA-Z0-9_./-]*) build "invalid GitHub repository metadata" ;;
esac
# Keep the destination fixed: credentials must only go to GitHub.
case "$owner$repo" in
  */*) build "invalid GitHub repository metadata" ;;
esac
if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  build "GitHub lookup tools unavailable"
fi

# The ignore step runs before npm install. Use only curl and the Node runtime.
# Tokens are optional for public repos; private repos need pull requests:read.
headers=(-H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN:-}}")
fi
if ! response="$(curl --disable --silent --fail --connect-timeout 3 --max-time 10 \
  "${headers[@]}" --get --data-urlencode 'state=open' \
  --data-urlencode "head=$owner:$branch" --data-urlencode 'per_page=100' \
  "https://api.github.com/repos/$owner/$repo/pulls" 2>/dev/null)"; then
  build "GitHub lookup failed"
fi
if ! pr_state="$(printf '%s' "$response" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try {
      const prs = JSON.parse(input);
      const [repository, branch] = process.argv.slice(1);
      // A full page may omit a ready PR. Any incomplete/foreign row is uncertain.
      if (!Array.isArray(prs) || prs.length >= 100 || prs.some(pr =>
        pr?.state !== "open" || typeof pr.draft !== "boolean" ||
        pr.head?.ref !== branch ||
        pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()
      )) process.exit(1);
      console.log(prs.length === 0 ? "none" : prs.every(pr => pr.draft) ? "draft" : "ready");
    } catch { process.exit(1); }
  });
' "$owner/$repo" "$branch" 2>/dev/null)"; then
  build "GitHub response uncertain"
fi
case "$pr_state" in
  none) skip "no open pull request" ;;
  draft) skip "draft pull request" ;;
  ready) ;; # Preserve the existing docs/tooling-only optimization below.
  *) build "GitHub response uncertain" ;;
esac

export GIT_TERMINAL_PROMPT=0

resolve_commit() {
  git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null
}

base=""
base_source=""
previous_sha="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -n "$previous_sha" ]; then
  # Accept only a full lowercase hex SHA: refs like "main" or option-shaped
  # values ("--upload-pack=...") never reach git.
  # Whole-string check (grep would match per line and let a multi-line value
  # through): exactly 40 characters, none outside 0-9a-f.
  case "$previous_sha" in
    *[!0-9a-f]*) build "VERCEL_GIT_PREVIOUS_SHA is not a 40-character hex SHA" ;;
  esac
  if [ "${#previous_sha}" -ne 40 ]; then
    build "VERCEL_GIT_PREVIOUS_SHA is not a 40-character hex SHA"
  fi
  base="$(resolve_commit "$previous_sha")"
  if [ -z "$base" ] && [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    # Vercel clones shallowly; try to fetch the previous deployment's commit.
    git fetch --quiet --depth=100 -- origin "$previous_sha" >/dev/null 2>&1
    base="$(resolve_commit "$previous_sha")"
  fi
  if [ -z "$base" ]; then
    # A set but unresolvable previous SHA is an error, not a first deploy.
    build "VERCEL_GIT_PREVIOUS_SHA does not resolve to a commit"
  fi
  base_source="previous deployment"
fi

# Only a branch's first deployment (no VERCEL_GIT_PREVIOUS_SHA) falls back to
# the merge-base with main.

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
