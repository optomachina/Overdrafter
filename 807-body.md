## Linear issue ID

- Issue: OVD-851 (https://linear.app/overdrafter/issue/OVD-851)
- Satisfies the source acceptance criteria (emitter + shared validator + comment parser). Gate consumption is OVD-845 (not started).
- Main PR for this issue. Not a release-outcome parent.

## Summary

Adds `scripts/verdict-schema.mjs` (overdrafter.verdict/v1 JSON Schema + strict validator + `overdrafter-verdict` comment parser, node builtins only so OVD-845 can import it from the base checkout) and `scripts/emit-verdict.mjs` (library + CLI that builds/validates a verdict, computes `patch_id` with `git patch-id --verbatim` (which implies the order-independent `--stable` hashing; git rejects passing both) over pinned diff options and fails closed unless git prints exactly one id, fills sha/verifier/UTC timestamp, prints the comment body; posts only with `--post`).

## Problem

Verifiers and reviewers had no machine-readable verdict format for the automerge-eligible check (OVD-845) to consume.

## Acceptance criteria addressed

- [x] Emitter + shared validator, single schema source of truth
- [x] Fenced ```overdrafter-verdict comment; edited comments invalid; latest valid block per SHA; conflicts fail closed
- [x] Reviewer findings `{severity,file,line,model}`, `corroborated` across model families; only `role: verifier` verdicts count
- [x] Fail closed on schema errors (fields, version, non-https evidence, timestamps, zero evidence)

## Files changed

`scripts/verdict-schema.mjs`, `scripts/emit-verdict.mjs`, their tests, `docs/verdict-format.md`.

## Scope

Included: library, CLI, docs, tests. Not included: any workflow or merge gating (OVD-845), branch protection.

Note: patch-id uses `--verbatim` (not `--stable` alone) because `--stable` ignores whitespace-only changes, which would let a verdict carry over to different code; needs git >= 2.39.

The diff is hashed as raw bytes (never decoded as UTF-8), so two diffs that differ only in invalid UTF-8 bytes cannot share a `patch_id`. The CLI entry guard compares realpaths, so launching `emit-verdict.mjs` through a symlink runs `main()` instead of silently exiting 0.

NUL guard (new behaviour, documented in `docs/verdict-format.md`): `git patch-id` hashes each diff line with `strlen()` and stops at the first NUL, so two diffs that differ only after a NUL byte on a line of a text-classified file (git decides text vs binary from the first 8000 bytes, and `--binary` only encodes files it calls binary) would share a `patch_id`. `computePatchId` now fails closed: if the diff Buffer contains a NUL byte (`diff.includes(0)`) it throws `computePatchId: <base>...<head> diff contains a NUL byte, which git patch-id cannot hash ...` before calling `git patch-id`. The CLI reports it as `emit-verdict: <message>` on stderr, prints no verdict on stdout and exits 1 (same path as every other error, including an empty diff). `patch_id` stays git's own value; there is no custom hash. Real binary files are unaffected (their `--binary` encoding has no raw NUL). OVD-845 must treat a throw as "cannot carry this verdict over", never as a match.

Single-id guard (new behaviour, documented in `docs/verdict-format.md`): `git patch-id` takes any input line that starts with 40 hex characters for the next commit's id, ends the current patch there and prints one output line per patch. Text hunk lines start with `+`, `-` or a space, but a base85 data line of a `GIT binary patch` starts with a length character, and `c` to `f` are hex digits, so a real `git diff --binary` can contain such a line (no NUL byte needed). `computePatchId` used to keep only the first id, so every file sorted after the split went unhashed and two different heads could share a `patch_id`. It now passes the output through `parsePatchIdOutput`, which requires exactly one line of the form `<40-hex> <40-hex or zeros>` and throws `computePatchId: git patch-id returned N ids for <base>...<head>, which is one diff ...` otherwise (zero lines: `returned no id`). The CLI reports it as `emit-verdict: <message>` on stderr, prints no verdict and exits 1, like every other error. `patch_id` stays git's own value.

`patch_id` is not position-aware, by design: the verdict binds to `sha` (the head SHA), and `patch_id` is only a rebase-reuse aid. `git patch-id` drops hunk headers and `index` lines, which is what keeps the id stable across a rebase, and the graph's `rebase_reuse: patch-id-equal` rule relies on it, so the mechanism is unchanged. Consequence: the same edit at two different positions with identical context has the same id (for example inserting a line at line 4 versus line 7 of ten identical lines, `@@ -1,6 +1,7 @@` versus `@@ -4,6 +4,7 @@`), so equal ids do not prove an identical change. `docs/verdict-format.md` now says so and says OVD-845 must decide what reuse requires beyond an equal id (for example the same changed-file list and hunk positions, or tree equality when the base is unchanged). A test pins the behaviour.

## Verification

Head 32e7dc24, on top of eacfdb28 (a clean merge of origin/main 873ce540, #805, into e6dee6c9; no rebase, no force-push; a fast-forward push from e6dee6c9). Round history since the Opus-approved 2887d9dd:

- a2d7c363 (merge of origin/main 3bd6726a into 2887d9dd; no conflicts) was reviewed by Sonnet and Codex.
- 2e8faf82 fixed the half of the Sonnet blocker that was a UTF-8 collapse (the diff is now hashed as bytes) and the symlinked entry guard (found by Claude's spot-check of the Codex review, not by the Codex run itself).
- e6dee6c9 fixed the NUL-byte collision, found by both Sonnet and Codex at 2e8faf82.
- 32e7dc24 fixes the two blocking items of the Codex review at e6dee6c9: the split `git patch-id` output (found by Claude's spot-check; code fix plus regression tests) and the undocumented position independence (docs, code comment, PR body and a pinning test; no mechanism change).

The branch has no commits behind main 873ce540.

Commands run:

```bash
bash scripts/preflight.sh lint
bash scripts/preflight.sh typecheck
GH_BIN=/opt/homebrew/bin/gh npx vitest run scripts/emit-verdict.test.mjs scripts/verdict-schema.test.mjs scripts/test-lane-contract.test.mjs
npm run test:portable-node
```

Results:

- [x] lint and typecheck pass on the merged tree
- [x] emit-verdict, verdict-schema and test-lane-contract suites pass (124 tests; emit-verdict has 48, 11 more than at e6dee6c9: 5 split-output, 4 `parsePatchIdOutput`, 2 position)
- [x] `npm run test:portable-node` passes (1705 tests: 1703 pass, 0 fail, 2 skipped)
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: none on the merged head for the commands above. `GH_BIN` is set only because this Mac has gh solely in /opt/homebrew/bin; without it the "posts through a fixed argv" test fails locally on the fixed `/usr/bin:/bin:/usr/local/bin` lookup (GitHub-hosted Linux runners provide gh at /usr/bin/gh). The earlier full-suite run on 2887d9dd had failures only in worker suites (no `worker/node_modules` locally) and known OVD-417 Docker qualification tests; that run was not repeated on this head. The new tests were first run against the unfixed code: the invalid-UTF-8 patch-id test and the symlink entry tests failed there, and the three NUL tests that need the guard (library, buildVerdict/main, CLI exit 1) fail with the guard disabled. For this round, with `computePatchId` restored to keeping only the first id, exactly the three split-output tests that call it (library, buildVerdict/main, CLI exit 1) fail; all pass with the fix. The fixture test confirms that raw `git patch-id` prints two lines for each crafted head (it depends on git/zlib storing the 73-byte file as one stored deflate block, which holds for git 2.53 here; if a platform differs, that fixture test fails loudly instead of the guard going untested).

## Proof

Test: scripts/verdict-schema.test.mjs
Test: scripts/emit-verdict.test.mjs

## Review findings and coverage

- Final PR head SHA: 32e7dc24 (the Codex review at e6dee6c9 required a single-id guard and a documented position-independence caveat; both are in this head; delta re-review needed on this head)
- Sonar issue findings: the quality gate passed at 2e8faf82 (Quality Gate passed comment), and SonarCloud and SonarCloud Code Analysis completed successfully on e6dee6c9 per the Codex review; not yet re-run on 32e7dc24
- CodeRabbit: skipped because the PR is a draft
- Codex and other reviewers: Opus APPROVED at 424be392, 0ca6fa39, dcfd5360 and 2887d9dd. At a2d7c363, Sonnet and Codex found the patch-id UTF-8 collapse and the symlinked entry guard, fixed in 2e8faf82. At 2e8faf82, Sonnet and Codex both found the NUL-byte patch_id collision (CHANGES REQUIRED), fixed in e6dee6c9. At e6dee6c9, Codex (relayed and spot-checked by Claude) required a single-id guard for split `git patch-id` output and a documented position-independence caveat, both addressed in 32e7dc24
- [ ] Inspected findings and threads on the final head

## Tests

Round trip, one fixture per invalid field (incl. inherited-property names like `constructor`), patch-id stable across a no-op rebase / changes when the diff content changes / changes on whitespace-only edits / changes on invalid-UTF-8-only edits (and matches for identical ones) / throws instead of returning an id when two text-classified diffs differ only after a NUL byte (library, `buildVerdict`, `main()`, CLI exit 1; a NUL-free diff and a git-classified binary file still get distinct ids) / throws instead of returning the first id when git patch-id prints two lines for a commit pair that carries a crafted binary file (library, `buildVerdict`, `main()`, CLI exit 1; an ordinary diff and an ordinary binary file still get one id; `parsePatchIdOutput` unit cases) / gives the same id to the same edit at two positions with identical context, and a different id when the inserted text differs / independent of local `diff.context`, CLI entry guard (realpath compare, false for missing or unresolvable `argv[1]`, end-to-end runs through symlinks for success and a non-zero error exit), parser (non-fenced text, latest per SHA, conflicts, edited comments, author mismatch), corroboration, `--post` gating.

## Migration notes

- [x] No migration impact

## Rollback / risk notes

Library only, nothing calls it yet; revert to roll back.

## Documentation

- [x] Docs updated

## Follow-up items

- [ ] OVD-845 owns verifier independence checks and must use `computePatchId`; update issue text from `--stable` to `--verbatim`
- [ ] OVD-845 must decide what verdict carry-over requires beyond an equal `patch_id` (it ignores hunk positions and `index` lines), for example the same changed-file list and hunk positions, or tree equality when the base is unchanged
- [ ] OVD-887 owns the same `import.meta.url === process.argv[1]` entry-guard pattern elsewhere in the repo; this PR fixes only `scripts/emit-verdict.mjs`




