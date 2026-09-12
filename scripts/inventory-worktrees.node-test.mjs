import assert from "node:assert/strict";
import test from "node:test";

import { parseWorktreePorcelain } from "./inventory-worktrees.mjs";

test("parses owned, detached, and prunable worktrees without implying deletion", () => {
  const result = parseWorktreePorcelain(`worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /old\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n`);
  assert.deepEqual(result, [
    { prunable: false, path: "/repo", head: "abc", branch: "main" },
    { prunable: true, path: "/old", head: "def", detached: true, prunableReason: "gitdir file points to non-existent location" },
  ]);
});
