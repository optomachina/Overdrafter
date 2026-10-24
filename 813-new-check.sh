#!/usr/bin/env bash
# Usage: 813-new-check.sh <newhead40>. Verifies the new #813 head vs bcb559cc and re-runs affected tests in a fresh worktree.
set -u
N=$1; OLD=bcb559ccb838d8cca876a3484f2e728a4d6e956e; R=/workspace/qa-batch/repo-fresh; W=/workspace/qa-batch/wt813-new
git -C $R fetch -q origin main pull/813/head
echo "fetched head=$(git -C $R rev-parse FETCH_HEAD) main=$(git -C $R rev-parse origin/main)"
echo "parents: $(git -C $R rev-list --parents -n1 $N)"
echo "commits OLD..N: $(git -C $R rev-list --count $OLD..$N)"; git -C $R log --oneline $OLD..$N
B=$(gh pr view 813 -R optomachina/Overdrafter --json baseRefOid --jq .baseRefOid); echo "baseRefOid=$B mergebase=$(git -C $R merge-base origin/main $N)"
git -C $R diff d88d5df8aded2394fa10e2fafbefbaa65809ab42...$OLD > /tmp/813-old-pr.diff
git -C $R diff origin/main...$N > /tmp/813-new-pr.diff
wc -l /tmp/813-old-pr.diff /tmp/813-new-pr.diff
cmp -s /tmp/813-old-pr.diff /tmp/813-new-pr.diff && echo "PR DIFF BYTE-IDENTICAL" || echo "PR DIFF DIFFERS"
echo "patch-id old=$(git -C $R patch-id --stable </tmp/813-old-pr.diff | awk '{print $1}' | sort | sha256sum | cut -c1-16) new=$(git -C $R patch-id --stable </tmp/813-new-pr.diff | awk '{print $1}' | sort | sha256sum | cut -c1-16)"
echo "merge delta (first parent -> N):"; git -C $R diff --stat $N^1 $N
echo "auto-merge tree check: $(git -C $R merge-tree --write-tree $N^1 $N^2 2>/dev/null | head -1) vs $(git -C $R rev-parse $N^{tree})"
git -C $R worktree add --detach $W $N >/dev/null 2>&1; echo "worktree HEAD=$(git -C $W rev-parse HEAD)"
cmp -s $W/package-lock.json /workspace/qa-batch/wt828/package-lock.json && ln -sfn /workspace/qa-batch/wt828/node_modules $W/node_modules && echo LOCK-SAME-LINKED
