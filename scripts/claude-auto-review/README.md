# Claude auto-review (OVD-845)

Posts one Claude review comment per head SHA on open, non-draft, same-repo PRs
from `cursor/*` or `grok/*` branches, or labelled `grok-built`. Risky tier uses
Opus; everything else uses Sonnet. Risky means the classifier reports door
`one-way`, any sensitive-path file (`sensitive_count` above 0, so a
`revertable` sensitive PR still gets Opus), gate loosening, or an error. A PR
whose files match no sensitive class gets `door: null` and is not risky. Comments start with
`Claude auto-review (<model>, <tier> tier) @ <sha>` and the first body line is
`VERDICT: PASS` or `VERDICT: CHANGES_REQUIRED`.

**These comments are advisory.** They are posted from the owner's `gh` login
but are not owner sign-off. They are not the sized review in AGENTS.md either,
and they are not a gate. Reviewer routing stays with `model-routing.v2.yaml`
and `built-by.mjs`.

The owner's login (`optomachina`) is in the merge gate's trusted approver and
verifier lists, and no separate untrusted login exists on the mini. So the
script never posts a block the gate could read: before posting, every line
that opens a ```` ``` ```` or `~~~` fence with an `overdrafter*` info string
(any case, any indent, after LF, lone CR, U+2028 or U+2029) is rewritten to
`neutralized-overdrafter-…`. `run.test.mjs` runs the real sanitizer and the
real `extractApprovalBlocks` / `extractVerdictBlocks` on the result. If a
dedicated review login is added later, post from it instead.

Claude is told to judge the PR against `AGENTS.md` from `origin/main`, copied
into the per-PR dir, not the PR head's copy.

Claude runs with `--restricted --safe-mode` and no MCP servers. Its only
working directories are the PR checkout and a per-PR dir holding the body,
diff and prompt. It gets path-scoped Read/Grep/Glob for those two dirs and a
deny list for home credential paths. The PR head is checked out with
`core.symlinks=false`, so symlinks land as plain text files. See the header of `run.sh`.

Runs on the Mac mini through launchd every 10 minutes:

    install -m 755 scripts/claude-auto-review/run.sh ~/.local/bin/ovd-claude-review
    cp scripts/claude-auto-review/com.optomachina.ovd-claude-review.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.optomachina.ovd-claude-review.plist

Dry run (reviews but never posts): `OVD_REVIEW_DRY=1 OVD_REVIEW_ONLY=<pr> ovd-claude-review`.
Print the claude argv and settings without network or git: `run.sh --print-argv <checkout> <files-dir>`.

Log: `/tmp/ovd-claude-review.log`. State and worktrees: `~/.cache/ovd-claude-review`.
The state dir must not be under `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Library`,
`~/.config`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube` or `~/.docker`, because those are denied. Worktrees, refs and files of closed PRs are pruned each run, and a PR's try/post budgets and saved reviews for older heads are dropped when it is next processed.
Needs `gh` and Claude Code signed in on the mini, plus `node`. No repository-level credentials.
A finished review is kept until it posts. A failed post or head re-check retries only the post, up to 3 times per head SHA, and never reruns Claude.
After 3 failed posts the SHA is skipped. To retry once the outage is over, delete only
`~/.cache/ovd-claude-review/posts-<pr>-<sha>` and keep `ready-<pr>-<sha>.md`; the next run posts the saved review.
Uninstall: `launchctl bootout gui/$(id -u)/com.optomachina.ovd-claude-review`
and `rm ~/Library/LaunchAgents/com.optomachina.ovd-claude-review.plist ~/.local/bin/ovd-claude-review`. Nothing else depends on it.

After changing run.sh on main, reinstall it with the `install` line above.
