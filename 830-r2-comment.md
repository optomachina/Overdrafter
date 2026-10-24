## QA verdict: FAIL — `326f0452974dd91d7dfee65de66acb4a57c39944`

Supersedes my PASS_NOTES on 135089be (issuecomment-6229645959).

**Gate:** Opus APPROVED 326f0452 (issuecomment-6229741836). The head is a fast-forward of one commit from 135089be. The diff is only `scripts/validate-pr-body.mjs` (+10/−4: the regex, a `line` field on parsed boxes, and the auto-branch lookup) and `scripts/validate-pr-body.test.mjs` (+31: 2 new tests). No other files changed.

**Proof re-run:** in a worktree at 326f0452:
- `npx vitest run --maxWorkers=2 scripts/validate-pr-body.test.mjs scripts/render-pr-body.test.mjs`: Test Files 2 passed, Tests 76/76.
- `bash scripts/preflight.sh lint`: PASS.
- `bash scripts/preflight.sh typecheck`: PASS.
- I re-ran my scratch-body probe, extended for this round (`/workspace/qa-batch/830-probe-r2.mjs`). Each case uses a body with all manual items and no real auto line, plus the variant.

**CI @ exact head:** all 22 non-Vercel checks are green, including `provider-go-live`, and SonarCloud passed. Vercel failed; per policy it's ignored.

### What passes
- **The six-item behaviour is unchanged.**
  - The six items are no longer required: envelope-reviewer (now automatic), rollback, kill-switch, same-day-off, rate-limit and no-evasion.
  - Omitting any one of them passes on head and fails on main.
  - Main's validator still rejects the new checklist.
- **supplier-switch is unchanged.** It fails closed when missing, N/A, unchecked or without an evidence link.
- **no-passwords and provider-check:** N/A or missing is rejected.
- **export-control:** N/A for a US-only provider is still allowed.
- **Lookalike checkboxes are no longer taken as the envelope item; each one fails as an extra line:**
  - `- [ ] not envelope reviewed`
  - `- [ ] envelope reviewed? NO`
  - `- [x] not envelope reviewed` (no evidence link)
  - The same holds when the lookalike sits before the real line.
- **Ticked lines satisfy the item:**
  - The real line.
  - `- [x] envelope reviewed (automatic)`.
  - `- [x] **Envelope reviewed (automatic).** Signed: …` (bold).
  - `* [X] Envelope reviewed (automatic)`.
- **Text that isn't a checkbox line is not matched:** prose, a blockquote (`> - [x] envelope reviewed (automatic)`) and mid-line text (`Note: - [x] envelope reviewed (automatic)`). Note that these pass only because the auto item is never required.
- **The supplier-switch theft case from round 1 is fixed.** A supplier-switch line that contains "envelope reviewed (automatic)" is no longer taken by the envelope item.

### What fails (2 of the round's required checks)
1. **An unticked real line passes the section.**
   - The required behaviour: the line `- [ ] Envelope reviewed (automatic). Signed: Grok Bot under Blaine Wilson standing authority.` is excluded from the manual count, does not satisfy the auto requirement, and the section fails.
   - Actual: the fallback `/^envelope reviewed \(automatic\)/i` at validate-pr-body.mjs:536 swallows the line. The auto branch never records an error, so the result is `ok: true` with no errors.
   - The PR's own test asserts this at validate-pr-body.test.mjs:524–533 ("signed, unsigned, or absent, it never fails"). This matches the earlier "never fails on it" design, but not this round's acceptance check.
   - The unticked bold form fails, but only as an extra line, and Opus noted that inconsistency.
   - Fix: an unticked real line should produce an error such as `check "envelope reviewed (automatic)"`. Then decide explicitly whether a missing auto line should also fail.
2. **A line inside a code fence is treated as the auto item.**
   - `parseCheckboxLines` doesn't track code fences. Both `- [x] envelope reviewed (automatic)` and `- [ ] envelope reviewed (automatic)` inside a fenced block are taken as the envelope item.
   - With no real line in the body, the section passes.
   - With a real ticked line also present:
     - A fenced ticked line is taken first. The real line is then left over and fails for having no evidence link (noisy, fails closed).
     - A fenced unticked line is left over and fails with `check "envelope reviewed (automatic)"`.
   - Fix: skip lines inside code fences, at least for the auto lookup. Ideally do this for every parsed checkbox.

Other observations: a missing auto line still never fails the gate, by design. Two ticked real lines fail the section, because the second is treated as an extra with no evidence link (fails closed).

**SENSITIVE:** gate loosening. This changes the required `provider-go-live` gate (validator, PR template and checklist doc). The merge is card-only: it needs Blaine's countersign via Release, with Grok Bot. #743 merges after this PR.

Draft. No labels changed; not merged.
