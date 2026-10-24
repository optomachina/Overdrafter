QA: FAIL on 989892dc2193b97dc87865ba6e69d35dbba8b949

Both round-2 failures are fixed and every acceptance probe passes: 96/96 rows in 830-probe-r3, with no case going from FAIL to ok. The blocker is SonarCloud: its quality gate fails on this SHA with "D Security Rating on New Code" (required ≥ A).

**Blocker: SonarCloud gate red.** It reports two new CRITICAL `javascript:S5852` (exponential backtracking) vulnerabilities in `scripts/validate-pr-body.mjs`:
- **L372**, the auto item's `match` regex `/^(?:\s*(?:[-*+]|\d{1,9}[.)])\s+)+\[[xX]\].../im`.
  - The blow-up is real: testing `"-    ".repeat(20) + "!"` takes about 5 s, and 24 repeats takes over 55 s.
  - Today nothing calls `.match` on the auto item (the gate uses `AUTO_LINE_TEXT`), so it is exported but not hit at runtime.
- **L142**, `CONTAINER_PREFIX`. It runs on every body line, but I could not make it blow up in practice.
- **Fix:** rewrite both regexes so the whitespace quantifiers don't overlap, or drop the unused auto `match`. If you decide they are safe instead, mark them reviewed in SonarCloud; that is the owner's call. Then re-run Sonar.

**What passed, all checked in a fresh worktree at 989892dc:**
- **Unticked auto line:** the real line, plain, bold and `* [ ]` all FAIL with `"envelope reviewed (automatic)" must be ticked`.
- **Missing auto line:** FAILs with `missing Provider go-live item`. So does auto text that sits only on a continuation line.
- **Fences:** checkboxes inside ``` and ~~~ fences never count. That covers longer fences, 3-space indents, fences in lists and blockquotes, and unclosed fences. A fenced line alone FAILs; a fenced line plus a real ticked line is ok.
- **Ticked lines pass:** the real line, plain, bold, `__…__`, `* [X]`, `+`, `1.`, `1)` and nested forms.
- **Removed items:** dropping any of the six is ok on head; main FAILs each one.
- **Fail-closed items:**
  - supplier-switch FAILs when missing, N/A, unticked or without evidence.
  - no-passwords and provider-check FAIL when N/A.
  - export-control N/A for a US-only provider is still allowed.
- **Duplicate headings:** a second go-live heading (ATX, `###`, `<h2>`, setext, or in a blockquote) FAILs. A heading inside a fence does not count.
- **HTML comments:** checkboxes and evidence inside comments don't count.
- **Real bodies:**
  - PR #830's own body passes under both the head and main validators.
  - render-pr-body output and the filled template pass.
  - Of 116 recent PR bodies (98 merged, 18 open), all 116 give the same results under the head and main validators.

**Accepted safe-side rejections:** an ambiguous fence end, a 4-space-indented ``` line, and a multi-line commented-out heading.

**Minor, not blocking:**
- A 4-space indented code block holding `- [x] envelope reviewed (automatic)` still counts. It did on main and at 326f too.
- The PR body is stale. It still says "the gate never fails on it" and "can absorb one unchecked envelope line", and its Proof section says 74 tests, not 94.

**CI on this SHA:**
- Green: provider-go-live (run 39006480749), proof-check (39006480754), secret-scan (39006480761), security-definer-lint (39006480746), and verify plus run journeys at head (39006480857). In run 39006480852, lint, typecheck, rls-deny-coverage, free-quote-sql, capability-sql, retention-sql and ovd420 are green.
- Still running when I checked at 22:47 MST: test, verify-worker, build, browser-test, extraction-gate and migration-immutability.
- The diff since 326f0452 touches only the validator, its tests, the PR template and the checklist doc. No workflow or required-check changes.

**Gate loosening on the required `provider-go-live` gate.** Merging is card-only: Blaine countersigns, with Grok Bot. #743 merges after this PR.

Proof re-run: `npx vitest run --maxWorkers=2 scripts/validate-pr-body.test.mjs scripts/render-pr-body.test.mjs` (94/94), `bash scripts/preflight.sh lint` PASS, `bash scripts/preflight.sh typecheck` PASS, and `node 830-probe-r3.mjs` (96/96, 0 FAIL→ok), all at 989892dc in a fresh worktree; CI runs 39006480749 / 39006480852 / 39006480857; SonarCloud PR 830 gate red.
