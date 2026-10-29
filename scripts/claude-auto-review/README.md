# Claude auto-review (OVD-845)

Posts one Claude review comment per head SHA on open PRs from `cursor/*` or
`grok/*` branches, or labelled `grok-built`. Risky tier (sensitive-class door
`one-way`, gate loosening, or classifier error) uses Opus; everything else
uses Sonnet. Comments start with `Claude auto-review (<model>, <tier> tier) @ <sha>`
and the first body line is `VERDICT: PASS` or `VERDICT: CHANGES_REQUIRED`.

Runs on the Mac mini through launchd every 10 minutes:

    install -m 755 scripts/claude-auto-review/run.sh ~/.local/bin/ovd-claude-review
    cp scripts/claude-auto-review/com.optomachina.ovd-claude-review.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.optomachina.ovd-claude-review.plist

Log: `/tmp/ovd-claude-review.log`. State and worktrees: `~/.cache/ovd-claude-review`.
Needs `gh` signed in and Claude Code signed in on the mini. No repo secrets.
Uninstall: `launchctl unload` the plist. Nothing else depends on it.

After changing run.sh on main, reinstall it with the `install` line above.
