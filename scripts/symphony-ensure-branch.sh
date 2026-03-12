#!/bin/sh
set -eu

target_branch=${1:-}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ -n "$target_branch" ] || fail "Usage: ./scripts/symphony-ensure-branch.sh <branch-name>"
[ "$target_branch" != "main" ] || fail "Refusing to use main as an issue branch."

normalized_branch=$(printf '%s' "$target_branch" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._/-' '-')
[ -n "$normalized_branch" ] || fail "Derived branch name is empty."
[ "$normalized_branch" != "main" ] || fail "Refusing to use main as an issue branch."

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root_dir"

./scripts/symphony-preflight.sh >/dev/null

git diff --quiet || fail "Working tree is dirty; clean or commit changes before switching branches."
git diff --cached --quiet || fail "Index is dirty; clean or commit changes before switching branches."

git fetch origin

current_branch=$(git branch --show-current 2>/dev/null || true)
if [ "$current_branch" = "$normalized_branch" ]; then
  printf '%s\n' "$normalized_branch"
  exit 0
fi

if git show-ref --verify --quiet "refs/heads/$normalized_branch"; then
  git switch "$normalized_branch" >/dev/null
  printf '%s\n' "$normalized_branch"
  exit 0
fi

if git show-ref --verify --quiet "refs/remotes/origin/$normalized_branch"; then
  git switch -c "$normalized_branch" --track "origin/$normalized_branch" >/dev/null
  printf '%s\n' "$normalized_branch"
  exit 0
fi

if git show-ref --verify --quiet "refs/heads/main"; then
  git switch main >/dev/null
else
  git switch -c main --track origin/main >/dev/null
fi

git pull --ff-only origin main >/dev/null
git switch -c "$normalized_branch" >/dev/null
printf '%s\n' "$normalized_branch"
