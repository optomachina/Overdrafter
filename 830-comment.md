## QA verdict: PASS_NOTES — `135089be88c90d3d9840b46189ea1c93ab50088b`

**Gate:** Opus APPROVED 55df0c5e (issuecomment-6229275877), with no blocking findings. The review carries forward:
- `git diff 55df0c5e 135089be -- <7 PR files>` is empty.
- The head is 55df0c5e plus a merge of main (#825). That merge is clean: `git merge-tree --write-tree` gives b53d6885, which equals the head tree.
- No earlier QA verdicts on this PR.

**Proof re-run:** in a fresh worktree at 135089be:
- `npx vitest run --maxWorkers=2 scripts/validate-pr-body.test.mjs scripts/render-pr-body.test.mjs`: Test Files 2 passed, Tests 74/74.
- `bash scripts/preflight.sh lint`: PASS.
- `bash scripts/preflight.sh typecheck`: PASS.

**The body's declarations match the code:**
- The body declares `gate_loosening: true`.
- I diffed `PROVIDER_GO_LIVE_REQUIRED_ITEMS` against origin/main programmatically:
  - No longer required: `envelope-reviewer` (now `auto`), `rollback`, `kill-switch`, `same-day-off`, `rate-limit` and `no-evasion`. These are exactly the six items the body lists.
  - Added: `supplier-switch`, which is `na:false` and in the Admit group. It replaces rollback, kill-switch and same-day-off.
  - `no-passwords` is still required; only its text changed.
  - `export-control` is unchanged.
- `scripts/provider-enablement-detect.mjs` is unchanged versus main.
- No workflow files or migrations are touched.

**Scratch-body probes.** I ran `validateProviderGoLive` on the head and on main's copy (scratch script `/workspace/qa-batch/830-probe.mjs`):
- Head with the full new checklist: ok. Main's validator rejects the same body: 6 items missing, and the auto line has no evidence link. This confirms the change is a loosening plus a replacement.
- Omitting any one of the six removed items: ok on head, and each fails on main.
- `supplier-switch` fails closed on head in every bad case:
  - Missing: error.
  - N/A: "N/A is not allowed".
  - Unchecked: error.
  - No evidence link: error.
- An old main-style checklist fails on head, because `supplier-switch` is missing.
- `no-passwords` N/A or missing: error. `provider-check` N/A: error. `export-control` N/A for a US-only provider is still accepted.

**Note: the auto-envelope pattern `/envelope reviewed/i` can be satisfied by unrelated text.** I confirmed this with probes. Opus flagged it from reading the code but couldn't run it. With no real auto line in the body, each of these unticked lines is absorbed silently and the section passes:
- `- [ ] not envelope reviewed`
- `- [ ] Envelope reviewed by a named reviewer. Evidence:` (no link)
- `- [ ] envelope reviewed? NO - reviewer refused`
- `- [ ] not envelope reviewed` placed under Legal stance

Cases that fail closed:
- `- [ ] Envelope NOT reviewed` doesn't match the pattern, so it's checked as an extra line and fails.
- With the auto line present, a second unticked "not envelope reviewed" line fails as an extra.
- An unticked match placed before the auto line is absorbed first. The auto line is then left over and fails for having no evidence link. That's noisy, but fails closed.
- A `supplier-switch` line whose text contains "envelope reviewed" gets taken, so supplier-switch reports as missing.

None of these can satisfy another required item. The only loosening beyond Blaine's auto-envelope decision is that a contradictory unticked envelope line passes. Suggestion: tighten the pattern to `/envelope reviewed \(automatic\)/i`, or require the auto line to be ticked.

**Acceptance criteria (OVD-677 split):** all met for this split PR:
- The gate items match the Oct 16 decisions.
- The renderer rejects an `envelope-reviewer` input (tested).
- The template, the checklist doc and the `add-quote-provider` skill are all consistent: the removed attestations are gone, they state there is no default daily quote cap, and the supplier-switch line references OVD-829. OVD-829 merged as #792 (confirmed).
- No provider is enabled.

**CI @ exact head:** all 22 non-Vercel checks are green, including `provider-go-live` (run 39000446950) and SonarCloud (Quality Gate passed). An earlier pair of `proof-check` and `provider-go-live` runs (03:52 UTC) was cancelled and superseded by green reruns. Vercel failed; per policy it's ignored.

**SENSITIVE: gate loosening.** This changes the required `provider-go-live` gate (`scripts/validate-pr-body.mjs`, `scripts/render-pr-body.mjs`, the PR template and the governance checklist doc). The merge is **card-only**: it needs Blaine's countersign via Release (with Grok Bot). #743 merges after this PR. The "Gate change review" reviewer is still "pending (Blaine card via Release)".

Draft. No labels changed; not merged.
