#!/usr/bin/env bash
# Review-only PRs for the CodeRabbit coverage gaps of PR #564 (Linear OVD-643).
# Prepared by the cloud coordinator 2026-10-08; run by the owner locally because the
# cloud session's permission classifier refused the commits.
#
# Usage:  bash review-only-prs-564.sh /Users/blainewilson/Documents/GitHub/Overdrafter <dir-with-slices-1..6.txt>
# Needs: git, gh (authenticated for optomachina/Overdrafter). Creates ONLY refs named review/564-*.
# Never touches main, the integration branch, #564, #565 or any existing branch. Opens 8 PRs between
# frozen review branches so nothing can be merged into a real branch by accident.
set -euo pipefail
ROOT="${1:?repo root}"; SLICES="${2:?slices dir}"
cd "$ROOT"
git fetch origin main codex/recovered-release-free-safety-20261003 \
  refs/pull/572/head:refs/remotes/origin/pr-572-head refs/pull/568/head:refs/remotes/origin/pr-568-head
for sha in 8d8d243513b928a59bd9d63858732dad50498f09 084b48c 7fd1b9a 6df8b8b d7899b7 5d419e4; do
  git cat-file -e "$sha^{commit}" || { echo "missing commit $sha (fetch more history: git fetch --unshallow origin)"; exit 1; }
done
[ "$(git rev-parse origin/pr-572-head)" = "$(git rev-parse 6df8b8b)" ] || { echo "refs/pull/572/head is not 6df8b8b"; exit 1; }
[ "$(git rev-parse origin/pr-568-head)" = "$(git rev-parse 5d419e4)" ] || { echo "refs/pull/568/head is not 5d419e4"; exit 1; }

# Refuse to clobber anything that already exists.
for b in 572-base 572-head 568-base 568-head src-base src-1 src-2 src-3 src-4 src-5 src-6; do
  if git ls-remote --exit-code --heads origin "review/564-$b" >/dev/null 2>&1; then echo "origin already has review/564-$b; stop and tell the coordinator"; exit 1; fi
done

BODY_COMMON='Review-only pull request. Never merge. Base and head are frozen review branches created so CodeRabbit can review content that reached the release integration branch (PR #564) without a review. The owner decided on 2026-10-08 to split the uncovered content into bounded review slices rather than waive coverage. Findings are triaged by the coordinator; real defects are fixed through separate PRs into the integration branch. This PR will be closed after the review is recorded.

Tracking: OVD-643

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GqaoSqia9BNetUBaGnMQSM'

mkpr() { # base head title covers
  gh pr create --repo optomachina/Overdrafter --base "$1" --head "$2" --title "$3" \
    --body "$(printf '%s\n\n%s' "Covers: $4" "$BODY_COMMON")"
}

# 1. #572 delta: existing commits only.
git push origin 7fd1b9a:refs/heads/review/564-572-base 6df8b8b:refs/heads/review/564-572-head
mkpr review/564-572-base review/564-572-head \
  "[review-only] #572 delta 7fd1b9a..6df8b8b (worker runtime hardening follow-ups)" \
  "the 10 files (+438/-65) pushed to PR #572 after CodeRabbit's last review (commits 8a839a3, cac279f, c448192, 6df8b8b)."

# 2. #568 delta: existing commit only.
git push origin d7899b7:refs/heads/review/564-568-base 5d419e4:refs/heads/review/564-568-head
mkpr review/564-568-base review/564-568-head \
  "[review-only] #568 delta d7899b7..5d419e4 (ARCHITECTURE.md)" \
  "ARCHITECTURE.md (+25/-15) pushed to PR #568 after CodeRabbit's last review."

# 3. Recovered source: one shared base at 8d8d243, six slice branches copying files from 084b48c.
git push origin 8d8d243513b928a59bd9d63858732dad50498f09:refs/heads/review/564-src-base
AREAS=("supabase migrations, tests and fixtures" "scripts, workflows and build config" \
       "worker provider-capability services" "worker adapters, jev, quote intelligence, recovery and tools" \
       "client src, server and api" "e2e specs and docs")
WT="$(mktemp -d)/review564"
git worktree add --detach "$WT" 8d8d243513b928a59bd9d63858732dad50498f09
trap 'cd "$ROOT"; git worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
for k in 1 2 3 4 5 6; do
  (
    cd "$WT"
    git checkout -q --detach 8d8d243513b928a59bd9d63858732dad50498f09
    xargs -a "$SLICES/$k.txt" git checkout 084b48c --
    n=$(git diff --cached --name-only | wc -l | tr -d ' ')
    [ "$n" = "$(wc -l < "$SLICES/$k.txt" | tr -d ' ')" ] || { echo "slice $k: staged $n files, expected $(wc -l < "$SLICES/$k.txt")"; exit 1; }
    git commit -q -m "[skip ci] [review-only] recovered source slice $k/6: ${AREAS[$((k-1))]}" \
      -m "Files copied verbatim from checkpoint 084b48c onto 8d8d243 for CodeRabbit review only. Tracking: OVD-643."
    git push origin "HEAD:refs/heads/review/564-src-$k"
    echo "slice $k: $(git rev-parse --short HEAD) $(git diff --stat 8d8d243513b928a59bd9d63858732dad50498f09 | tail -1)"
  )
  mkpr review/564-src-base "review/564-src-$k" \
    "[review-only] recovered source slice $k/6: ${AREAS[$((k-1))]}" \
    "recovered release source (9d387c0 and checkpoints 30192b7..084b48c, never reviewed) slice $k of 6: ${AREAS[$((k-1))]} ($(wc -l < "$SLICES/$k.txt" | tr -d ' ') files)."
done

echo; echo "Done. Paste this to the coordinator:"
gh pr list --repo optomachina/Overdrafter --search "[review-only] in:title" --state open --json number,title,headRefName,baseRefName,headRefOid --limit 20
