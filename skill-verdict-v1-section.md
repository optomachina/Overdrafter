## Verdict format (overdrafter.verdict/v1, OVD-851; groundwork for the OVD-845 gate)
Every QA verdict is one fresh PR comment holding a human header plus one machine block in the repo's `overdrafter.verdict/v1` format (spec: `docs/verdict-format.md`; parser: `scripts/verdict-schema.mjs`; emitter: `scripts/emit-verdict.mjs`, all on origin/main since #807). Never write the block by hand. Build it with `/workspace/qa-batch/verdict-v1.mjs`, which loads the repo's own `buildVerdict`/`formatComment`/`parseVerdictComments`.

Layout (the generator produces it; template: `/workspace/qa-batch/verdict-v1-template.md`):
1. Line 1, exactly: `QA: PASS on <40-char sha>` or `QA: FAIL on <40-char sha>`. Use the full SHA, never a short one. Handoff and loop filters match on this line.
2. 1-3 short lines saying what decided it. For FAIL, name the failing criterion or check.
3. `Findings:`, one bullet per note, written the same way as in the block.
4. `Local evidence (QA box): ...` with box log paths. These go in the human part only, because block evidence must be https.
5. `Proof re-run: <commands or run id> at <40-char sha>` (required; must contain the full SHA).
6. `families: builder=<codex|claude|grok|jev|unknown> reviewers=<none|family:model:VERDICT@sha,...> cross_family=<true|false> qa_catch_after_review=<true|false>` (OVD-912).
7. A blank line, the repo summary line `**OverDrafter verdict: …**`, the ```` ```overdrafter-verdict ```` JSON block and the do-not-edit footer.
The parser reads only the fenced block and ignores all other text. The Proof and families lines must stay outside the JSON, because the schema rejects unknown fields (`additionalProperties: false`).

Field mapping (QA is always `role: "verifier"`):
- `verdict`: QA FAIL gives `FAIL`. QA PASS with no notes gives `PASS`. QA PASS with only medium/low/info notes gives `PASS_NOTES` (the header still says `QA: PASS`). A blocking (high) finding always means FAIL.
- `sha`: the full 40-hex PR head (`gh pr view <PR> --json headRefOid`).
- `--base`: the PR `baseRefOid` (or `git rev-parse origin/main`). Both ids use the merge-base, `base...head`. Both commits must be in `/workspace/qa-batch/repo-fresh`: `git -C /workspace/qa-batch/repo-fresh fetch origin main pull/<PR>/head`.
- `patch_id` / `diff_id`: computed by the repo's `computePatchId` / `computeDiffId`. Don't compute them yourself. `diff_id` = sha256 of `git diff --raw -z --no-abbrev --no-renames --full-index --no-relative --ignore-submodules=none -O/dev/null --no-color --end-of-options base...head --`. An empty diff, or a diff with a NUL byte or a split patch-id, makes it exit 1. Report that and don't hand-craft ids.
- `verifier`: `id` = `68639ff6-bbc0-436d-86d5-f6de3ddb9054`, `model_family` = `grok`, `github_login` = the login that will post the comment (`gh api user --jq .login`, currently `optomachina`). The login must match the comment author, or the block is rejected.
- `evidence`: at least one https URL, as `kind` ∈ `verify-run|test|log|artifact`. Use the Actions run URL as `test` (or as `verify-run` for the verify workflow), and the SonarCloud PR dashboard as `log`. Don't use http, URLs with credentials, or local paths.
- `notes` (the QA findings): `"<high|medium|low|info>: [<blocking|follow-up>, <kind>] <message> (<file>:<line>)"`. Blocking = `high`. Follow-ups = `low` (or `medium`). Do not use a `findings` array: the schema allows it only for `role: reviewer` and rejects it for verifiers.
- `readiness`: `conflicts` (0 if `mergeable` is MERGEABLE, else count conflicting files), `open_threads` (unresolved review threads from GraphQL `reviewThreads.isResolved`), `checks` ∈ `green|pending|red` (red if any required check or the Sonar gate fails, else pending if any are pending, else green).
- `timestamp`: emit time, UTC, to the second (`2026-10-17T08:01:24Z`). The generator sets it. It must not be more than 5 minutes after the comment's `created_at`, so generate right before posting.

Build and validate (box, never posts):
```
git -C /workspace/qa-batch/repo-fresh fetch origin main pull/<PR>/head
node /workspace/qa-batch/verdict-v1.mjs --pr <PR> --sha <head40> --base <baseRefOid40> --verdict <PASS|FAIL> \
  --findings /workspace/qa-batch/<PR>-findings.json \
  --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/<id> [--evidence log=https://sonarcloud.io/...] \
  --local-evidence /workspace/qa-batch/<PR>.log \
  --summary '<why>' --proof 'Proof re-run: <cmds/run id> at <head40>' \
  --families 'families: builder=… reviewers=… cross_family=… qa_catch_after_review=…' \
  --checks <green|pending|red> --conflicts <n> --open-threads <n> \
  --out /workspace/qa-batch/<PR>-verdict-v1.md --check
```
`<PR>-findings.json` holds `[{ "blocking": true|false (or "severity"), "kind": "real|tracking|…", "file": "…", "line": 41 | "lines": [41,102], "message": "…" }]`. `--check` runs the body through `parseVerdictComments` as a fresh, unedited comment by `optomachina` and must print `ACCEPTED verdict=<…> conflict=false rejected=[]`. Do not post anything that isn't accepted. Defaults: `--schema-repo /workspace/qa-batch/wt-verdict` (an origin/main worktree; refresh it when `scripts/verdict-schema.mjs` changes on main) and `--git-dir /workspace/qa-batch/repo-fresh`.

Posting rules:
- Re-check that the head SHA is current right before posting. If it moved, re-run QA. Never post a stale SHA.
- Post the file as a **new** comment (`gh pr comment <PR> -R optomachina/Overdrafter --body-file <PR>-verdict-v1.md`), and only with the user's go-ahead. **Never edit a verdict comment**: an edited comment (`updated_at != created_at`) is rejected. To correct a verdict, post a new comment.
- Post one QA verdict per SHA. A second verifier verdict on the same SHA with a different `verdict` (or ids) makes the parser report `conflict: true` and null the verdict, so the gate fails closed. If the outcome at a SHA genuinely changes (for example after an infra re-run), flag it to Lead and don't silently post the opposite verdict at that SHA.
- Infra flakes still mean no verdict (see above).
