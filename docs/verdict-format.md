# Review verdict format (OVD-851)

The independent verifier and the model reviewers (Opus, Grok, Codex) report a
typed verdict on a pull request in one shared envelope,
`overdrafter.verdict/v1`. This document describes the format and the tools that
emit and parse it. The merge gate that consumes it is `ovd-merge-gate`
(OVD-845, [below](#ovd-845-merge-gate-ovd-merge-gate)). This format doesn't
gate anything on its own.

- `scripts/verdict-schema.mjs` is the single source of truth. It exports the
  JSON Schema object, `validateVerdict`, `parseVerdictComments`,
  `tagCorroborated` and `hasHighNote`. It uses no imports at all, so OVD-845
  can load it from the base checkout without `node_modules`.
- `scripts/emit-verdict.mjs` builds, validates and prints the PR comment.

## Envelope

```json
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "PASS",
  "sha": "<40-hex head SHA verified>",
  "patch_id": "<git patch-id --verbatim of base...head>",
  "diff_id": "<sha256 of git diff --raw -z --no-abbrev --no-renames --full-index of base...head>",
  "verifier": { "id": "astra-verifier", "model_family": "opus", "github_login": "verifier-bot" },
  "evidence": [{ "kind": "verify-run", "url": "https://github.com/optomachina/Overdrafter/actions/runs/1" }],
  "notes": ["low: rename helper for clarity"],
  "readiness": { "conflicts": 0, "open_threads": 0, "checks": "green" },
  "timestamp": "2026-10-16T12:00:00Z"
}
```

Field names follow the OVD-845 §6 schema. This format adds the following:

| Field | Rule |
| --- | --- |
| `role` | `verifier` or `reviewer`. `parseVerdictComments` returns only the `verifier` verdict as `verdict`; `reviewer` verdicts come back in `reviews`. **Both roles are `ovd-merge-gate` input:** it needs a verifier PASS and at least one reviewer PASS (see below). |
| `findings` | Required for `reviewer` (use `[]` for none), forbidden for `verifier`. Items are `{ severity, file, line, model }` plus optional `message` and `corroborated`. `file` is repo-relative (no leading `/`, no drive letter, no `..` segment), like a gate finding. `line` is an integer ≥ 1 or `null` for a file-level finding. |
| `notes` | Strings prefixed with a severity: `high: `, `medium: `, `low: ` or `info: `. `PASS_NOTES` needs at least one note. Under OVD-845, a `PASS_NOTES` verdict with a `high:` note (`hasHighNote`) can't be merged. |
| `verifier.model_family` | Lower-case family token. The schema accepts any token; `ovd-merge-gate` accepts only ruling 4's `claude`, `codex`, `grok`, `jev` or `human` and the exact lowercase aliases `opus` and `sonnet`, both normalized to `claude`. Other values (including `claude-opus`, `gpt-6`, uppercase variants and empty strings) are rejected with `verdict_schema_error`. The emitter writes the canonical family. |
| `verifier.github_login` | GitHub login, with an optional `[bot]` suffix. It must match the author of the comment. |

The validator fails closed and reports one message per problem, each prefixed
with its JSON path. Examples:

- `verdict.evidence: must have at least 1 item (got 0)`
- `verdict.evidence[0].url: must use https (got http) (...)`
- `verdict.timestamp: is not a real calendar time (...)`
- `verdict.schema: must be "overdrafter.verdict/v1" (got "overdrafter.verdict/v2") - unknown schema version`
- `verdict.approved: is not an allowed field`

Unknown fields, wrong types, unknown schema versions, non-https or credentialed
evidence URLs, non-UTC or impossible timestamps, and empty evidence are all
rejected. Field names inherited from `Object.prototype` (`constructor`,
`__proto__`, `valueOf`, ...) are unknown fields like any other.

`validateVerdict(obj, { now })` also rejects a `timestamp` more than five
minutes (`MAX_FUTURE_SKEW_MS`) after `now`, which defaults to the current time.
`parseVerdictComments` passes the comment's `created_at` as `now`, so a verdict
can't claim a time after the comment that carries it was posted.

## Emitting

```bash
node scripts/emit-verdict.mjs --role verifier --verdict PASS \
  --base "$(git rev-parse origin/main)" --head "$(git rev-parse HEAD)" \
  --verifier-id astra-verifier --model-family opus --github-login verifier-bot \
  --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/1 \
  --checks green --conflicts 0 --open-threads 0 \
  --note "low: rename helper for clarity"
```

- Arguments are treated as untrusted (they may come from an LLM).
- `--base` and `--head` are required and accept only a full, lowercase
  40-character commit SHA (`^[0-9a-f]{40}$`). Branch names, tags, `HEAD`,
  `origin/main`, abbreviated or uppercase SHAs, and anything starting with `-`
  are refused before any git call; the script never resolves refs itself, so
  resolve them in the caller with `git rev-parse` as in the example above.
  Only the regex match, never the raw argument, reaches git's argv, and it
  always follows `--end-of-options`. Each SHA must name a commit in the
  repository (`git cat-file -e --end-of-options <sha>^{commit}`).
- `--pr` must match `^[1-9]\d{0,6}$`.
- `--findings` rules:
  - the file must be under the repository root (the git toplevel of the
    working directory, or the working directory outside a repository) or under
    `$RUNNER_TEMP` when that is set;
  - a relative path resolves from the repository root (not the current
    directory), then from `$RUNNER_TEMP`, with `path.resolve(base, file)`, and
    its realpath must sit strictly inside that base; the file is read from the
    validated realpath;
  - symlinks are rejected, including a link inside the repository whose
    target is also inside it;
  - the OS temp directory (`os.tmpdir()`, `/tmp`) is not accepted, so in CI
    write findings under `$RUNNER_TEMP`.
- `git` and `gh` are run with `shell: false` by absolute path from
  `/usr/bin`, `/bin` or `/usr/local/bin` with `PATH` pinned to those
  directories.
- `GH_BIN` optionally overrides the `gh` binary only (never `git`). Unset or
  empty means the strict lookup above. When set it must be an absolute path;
  the script resolves it with `realpath` and requires the result to be an
  existing regular file, owned by the current user or root, not group- or
  world-writable, and executable. Any failed check is a hard error naming
  `GH_BIN` and the reason; the script never falls back to the `PATH` lookup
  after a bad override. Setup note: on the Mac mini (Apple Silicon Homebrew,
  where `gh` lives outside the fixed directories) set
  `GH_BIN=/opt/homebrew/bin/gh`.
- `sha` is the `--head` SHA, and `patch_id` is computed from that same SHA, so
  the two always describe the same commit.
- `patch_id` is `git patch-id --verbatim` over `git diff <pinned options> --end-of-options
  base...head --`, so `--base`/`--head` can never be read as git options. `--verbatim` keeps whitespace, so an indentation-only change gets a
  new id; it also implies the file-order-independent hashing of `--stable`.
  The script pins every diff option that git config could change: no renames,
  no relative paths, Myers algorithm, indent heuristic, `--unified=3`,
  `--inter-hunk-context=0`, `--submodule=short`, `--ignore-submodules=none`,
  `--full-index`, `--binary` (binary changes affect the id), `a/` and `b/`
  prefixes, no order file, `diff.suppressBlankEmpty=false`, and no external diff
  or textconv. The verifier and OVD-845 therefore compute the same id for the
  same commits regardless of local config. OVD-845 must compute the id with
  `computePatchId` (or byte-identical options) rather than its own diff. An
  empty diff is an error. The diff is handled as raw bytes and never decoded
  as text, so two diffs that differ only in invalid UTF-8 bytes get different
  ids.
- A diff that contains a NUL byte is an error, never a `patch_id`.
  `git patch-id` hashes each line with `strlen()` and stops at its first NUL,
  so two diffs that differ only after a NUL on a line would get the same id.
  Git decides text versus binary from the first 8000 bytes of a file (or from
  `.gitattributes`), and `--binary` base85-encodes only files it classes as
  binary. A text-classified file with a later NUL therefore puts a raw NUL in
  the diff. For that input there is no byte-exact `git patch-id`, and
  `patch_id` stays git's own value (no custom hash), so `computePatchId`
  throws `computePatchId: <base>...<head> diff contains a NUL byte, which git
  patch-id cannot hash ...` before it calls `git patch-id`. Real binary files
  are unaffected: a NUL in the first 8000 bytes makes git encode the file, and
  the encoded diff has no raw NUL.
- A diff for which `git patch-id` prints anything but exactly one id is an
  error, never a `patch_id`. `git patch-id` takes any input line that starts
  with 40 hex characters for the id of the next commit: that ends the current
  patch, and git prints one output line per patch. Text hunk lines start with
  `+`, `-` or a space, but a base85 data line of a `GIT binary patch` starts
  with a length character, and `c` to `f` are hex digits, so a real, valid
  `git diff --binary` can contain such a line. Reading only the first id would
  then leave out every file after it. `computePatchId` requires exactly one
  output line of the form `<40-hex> <40-hex or zeros>` and otherwise throws
  `computePatchId: git patch-id returned N ids for <base>...<head>, which is
  one diff ...` (or `returned no id`), before any id is used.
- Exit status: the script exits 0 after printing the comment. On any error,
  including an empty diff or either `patch_id` case above (a NUL byte, or more
  than one id from `git patch-id`), it prints `emit-verdict: <message>` to
  stderr, prints no verdict to stdout and exits 1. These errors happen before
  anything is posted. OVD-845 must treat a throw from `computePatchId` as
  "cannot carry this verdict over", never as a match.

- `timestamp` is the current UTC time, to the second.
- Reviewers add `--role reviewer --findings findings.json`. The file must hold a
  JSON array. The script tags the findings with `corroborated` before printing
  them.
- The script prints the comment body to stdout. It posts only when given both
  `--post` and `--pr <n>`, and then it runs
  `gh pr comment <n> --body-file <file>` with that fixed argv. The body is
  written to `verdict.md` (mode 0600) in a fresh directory from
  `mkdtemp($TMPDIR/ovd851-verdict-)`; it never goes through argv or stdin, and
  the directory is removed afterwards whether or not `gh` succeeds. Tests
  inject the runner and never post.

The comment has one summary line, the fenced block, and a do-not-edit footer:

````markdown
**OverDrafter verdict: PASS** for `<sha>` by astra-verifier (claude).

```overdrafter-verdict
{ ...json... }
```
````

**Never edit a verdict comment.** An edited comment (`updated_at !=
created_at`) is rejected. To change a verdict, post a new comment.

### `diff_id`, and why `patch_id` is advisory only

The verdict binds to `sha`, the head SHA it was verified at. Both ids exist only
to decide whether a verdict may be reused after a rebase.

`diff_id` is the lowercase hex SHA-256 of the exact bytes of
`git diff --raw -z --no-abbrev --no-renames --full-index` over `base...head`
(with `--no-relative --ignore-submodules=none -O/dev/null --no-color` pinned,
`--end-of-options`, both ends full SHAs; `computeDiffId`). Each record holds a
changed path, its old and new mode, its full old and new blob ids and a status
letter, so two heads share a `diff_id` only when the same paths changed between
the same blobs with the same modes. It hashes no diff text, so hunk positions,
binary patches, NUL bytes and encodings cannot make two different changes
collide. A rebase onto a base that touched none of the changed paths keeps it.

`patch_id` (`git patch-id --verbatim`) is **advisory only**. It is lossy by
git's design:

- it drops hunk headers, so the same edit at two positions with identical
  context gets one id;
- it drops `index` lines for text diffs (binary diffs do hash their blob ids);
- after a `GIT binary patch`, git does not hash the next `diff --git` line, so
  an entry with no `---`/`+++` lines (an empty file added or deleted, a
  mode-only change, another binary) contributes no path at all. Different
  heads, for example `chmod +x x.sh` versus `chmod +x y.sh` after a binary
  file, get one `patch_id`.

Equal `patch_id`s therefore never show that two heads hold the same change.

**OVD-845 rebase-reuse rule (hard requirement).** A verdict for an earlier SHA
may carry over to the current head only when the `diff_id` recomputed for the
current head equals the verdict's `diff_id`. An equal `patch_id` alone is never
enough. A throw from `computeDiffId` or `computePatchId` means "cannot carry
this verdict over", never a match.

## Parsing

`parseVerdictComments(comments, { sha })` takes GitHub issue comments
(`id`, `body`, `created_at`, `updated_at`, `user.login`) and returns:

| Key | Meaning |
| --- | --- |
| `verdict` / `comment_id` | Latest valid `verifier` verdict for `sha`, ordered by comment `created_at` (as an instant) and then by block order, or `null`. **Always `null` when `conflict` is true**, so a consumer that ignores conflicts can't read a pass. |
| `conflict` | `true` when any other valid verifier verdict for `sha` disagrees with the latest one. |
| `conflicts` | Those disagreeing verifier verdicts (`verdict` or `patch_id` differs from the latest one). |
| `latest` | The latest verifier entry, `{ comment_id, block, created_at, verdict }`, kept for diagnostics even when conflicting. Never use it as gate input. |
| `reviews` | Valid advisory `reviewer` verdicts for `sha`. |
| `other_sha` | Valid verdicts for other SHAs. These are stale for this head. Under the OVD-845 rebase rule, a verdict carries over only when its `diff_id` equals the diff_id recomputed for the current head; `patch_id` is advisory only. |
| `rejected` | `{ comment_id, block, reason, errors }`, where `reason` is one of `edited_comment`, `missing_comment_timestamps`, `invalid_json`, `schema_error` or `author_mismatch`. |

The parser only reads blocks that start with a ```` ```overdrafter-verdict ````
line and end with a closing fence line. It ignores other text and fences in
other languages. A gate must treat any `conflicts` entry, or any rejected block
that may belong to the current head, as `verdict_schema_error`.

## OVD-845 merge gate (`ovd-merge-gate`)

The "OVD-845 responsibilities" this format and its parser leave to the gate
are implemented by `scripts/ovd-merge-gate.mjs` and
`.github/workflows/ovd-merge-gate.yml` (OVD-959, PR-G1). The workflow runs
only default-branch code (`pull_request_target`, `issue_comment` created,
edited and deleted, `workflow_dispatch` with `pr`, and `merge_group`), fetches
the PR head and base as git data into a separate bare repository, records
trusted blocking verdicts in the verdict history from a job named
`ovd-merge-gate-history`, and then writes one check run named
`ovd-merge-gate` on the head from a job named `ovd-merge-gate-writer`. On
`merge_group` it writes `success` on the merge group commit (the queue
no-op). It re-reads the head right before writing and writes nothing for a
head that moved.

**Trigger filter and status comment (OVD-1144).** An `issue_comment` starts
the two PR jobs only when the comment body, or for an edit its previous body,
contains a marker from `TRIGGER_COMMENT_MARKERS` (case-insensitive, like
GitHub's `contains()`): the `overdrafter-verdict` and `overdrafter-approval`
fence openers, `VERDICT: PASS` (also PASS_NOTES), `VERDICT: FAIL`, `QA PASS`
or `QA FAIL`. Both jobs' job-level `if:` is generated by
`commentFilterExpression()` and pinned by a test, so relay, progress and
status comments start no job and spend no run. After writing the check run
the writer keeps exactly one status comment per PR: the oldest
`github-actions[bot]` comment whose body starts with
`<!-- ovd-merge-gate-status -->` is edited in place with REST `PATCH`
(an unchanged body is left alone); a new comment is posted only when none
exists. The comment holds the head SHA, the conclusion, the title and the
reason codes; it is advisory (the check run is the gate), carries no trigger
marker, and a failed edit only warns. The workflow posts no other comment.

`evaluate()` is pure and reads everything for one head SHA. The gate passes
only when all of these hold:

- **(a) Verifier.** The latest trusted `role: verifier` PASS (or PASS_NOTES
  with no `high:` note) bound to the head has `readiness.checks: green`.
  Bound means `sha` is the head, or `diff_id` equals the head `diff_id` the
  gate recomputes itself with `computeDiffId` over base...head (the current
  base branch tip). `patch_id` is never used.
- **(b) Reviewer.** At least one trusted `role: reviewer` PASS or PASS_NOTES
  is bound to the head. Reviewer verdicts are gate input here.
- **(c) No outstanding FAIL, no disagreement.** Over the union of every
  verdict bound to the head SHA or the head `diff_id`, any FAIL stands and a
  PASS next to it is `verdict_conflict`. A later same-role verdict at the
  same SHA supersedes a FAIL only with `supersedes: <FAIL comment id>`,
  `reason: infra` and a `ci-run`/`verify-run` the FAIL did not cite. A FAIL
  with any finding or a `high:` note is a product FAIL and needs a new head.
  Any `high` finding or `high:` note on a bound verdict, from either role,
  blocks.
- **(d) Trusted authors.** Only comments by `TRUSTED_VERIFIERS` count, a
  constant in the default-branch script (stage A: `["optomachina"]`), never a
  repo variable or env value. `verifier.github_login` must equal the comment
  author (parser rule). Blocks from untrusted authors, author-mismatched
  blocks and other authors' malformed blocks are ignored and listed in the
  summary's `ignored`.
- **(e) Edited, deleted or malformed trusted verdicts.** A trusted verdict
  comment that may be for the head (its `sha` or `diff_id` matches, or cannot
  be read) fails the gate until a fresher trusted verdict of that role is
  posted: `edited_verdict` when it was edited, and `verdict_schema_error`
  when its block is unparseable, fails the schema, has a `model_family`
  outside ruling 4, lacks comment timestamps, or opens a
  ```` ```overdrafter-verdict ```` fence that is never closed
  (`unterminated_block`; such a block is invisible to `extractVerdictBlocks`,
  so the gate counts opening fences itself).
  Removed verdicts come from the verdict history (below), from the
  `issue_comment` deleted event, and from `deleted_verdicts` in the gate's
  own earlier check runs on the head, but **only blocking verdicts are
  carried forward**: a FAIL, or a PASS/PASS_NOTES with a `high` finding or
  `high:` note. A history entry whose block is no longer posted (the comment
  was deleted, or edited so it no longer holds that block) is removed. A
  carried deletion
  stands in the union exactly as if it were still posted (a deleted FAIL
  stays outstanding unless a later verdict supersedes it under the normal
  rules; a deleted verdict is never itself a supersede claim), and it never
  counts as a pass. A deleted clean PASS/PASS_NOTES simply disappears: it is
  not recorded, does not satisfy (a) or (b), and does not block. A deleted
  block that cannot be read (or a carried entry without a readable verdict
  snapshot) is `edited_verdict` until a fresher trusted verdict is posted.
- **(f) Sensitive changes.** The default-branch copy of the sensitive-class
  detector (`scripts/sensitive-class-detect.mjs` over
  `docs/sensitive-paths.json`) classifies the PR files. Any `.github/**`
  path, in any spelling, adds `infra_ci`. Any class, including the detector's
  fail-closed `unclassified`, needs a valid `overdrafter.approval/v1` record
  (`scripts/approval-record.mjs`) bound to the head SHA or head `diff_id`,
  posted by `TRUSTED_APPROVERS` in a comment that was never edited;
  otherwise `approval_missing:<class>` for each class.
- **(g) Independence.** Stage A (`IDENTITY = "shared-account"`, today):
  every agent posts as `optomachina`, so verifier ≠ author and verifier ≠
  merger are **not enforced**; every summary says `identity: shared-account
  (not enforced)`. Stage B (`IDENTITY = "app"`, PR-G5): only
  `overdrafter-verifier[bot]` counts, `optomachina` verdicts are ignored as
  `verifier_is_merger`, and a verdict from the PR author or any commit author
  or committer is `verifier_not_independent`.
  Ruling 1 (both stages): when a counted verifier or reviewer verdict's
  `verifier.id` (the agent id) equals a builder bot id in the PR body's
  `Built-by:` (or `Model-builder:`) line, the gate reports
  `verifier_not_independent`. The line is parsed by the maintained parser,
  `parseBuiltBy` in `scripts/agent-graph/built-by.mjs`, as
  `docs/agent-pr-tags.md` specifies (canonical `bot=<id> model=model:<pool>`
  entries and the free-text `<bot> / <family>` form; ids and display names
  match case-insensitively; a legacy `Model-builder:` line is read as a
  Built-by line). A missing body, no Built-by line, a line (or one entry of
  it) the parser cannot read, a second builder in free text, or only a
  legacy `Model:` line (`bot=unknown`) is `builder_unattributed`: the
  independence from the builder cannot be checked. Until K3 (stage A) both
  codes are **warnings** in `warnings` and in the check-run summary, not
  reasons; from K3 (stage B) both are blocking reasons. The body is read as
  data from the PR API.
- **(h) PASS evidence resolves (ruling 6).** A PASS or PASS_NOTES counts for
  (a) or (b), and a supersede's "new run id" counts for (c), only when one of
  its https `ci-run` or `verify-run` links is
  `https://github.com/<this repo>/actions/runs/<id>` (optionally
  `/job/<id>` or `/attempts/<n>`) and that Actions run reported a GitHub
  Actions (app 15368) check run on the verdict's `sha`: the revision the
  verdict is bound to the head by (the head itself, or an older SHA with an
  equal `diff_id`). The gate checks this through the Checks API
  (`details_url` of the check runs on that SHA, `filter=all`), so it needs no
  permission beyond `checks`. Anything else, such as
  `https://example.invalid/not-a-run`, another repository, a lookalike host,
  a run that never reported on that SHA, or a check-run list that cannot be
  read, is `evidence_unverified` and the pass does not count.

**Verdict history (why it is durable, and where it lives).** GitHub keeps no
readable copy of a deleted issue comment: the comments, timeline and
issue-events APIs drop it, its edit history (GraphQL `userContentEdits`)
goes with it, and the public events feed is lossy (at most 300 events over
90 days, delivered late). A deleted FAIL can therefore only be kept by
recording it while it is still readable, somewhere that optomachina cannot
delete and that no single gate run owns. A per-PR concurrency group can
replace a pending run, so the deletion run's own check run is not enough.
The gate uses check runs: the workflow already has `checks: write`, there is
no API to delete a check run, only the app that created it (GitHub Actions)
can update it, and they are listed with `filter=all`.

- Every workflow run first runs the job `ovd-merge-gate-history`
  (`node scripts/ovd-merge-gate.mjs record --pr N`). It has no concurrency
  group, so a newer run never replaces it. It appends the trusted blocking
  verdicts it sees, from the event comment (on `created`, `edited` and
  `deleted`) and from every live comment, as one check run named
  `ovd-merge-gate-history/pr-<N>` holding
  `{ "schema": "overdrafter.gate-history/v1", "pr", "event", "entries" }`.
  Recording at creation means a FAIL is kept even if the deletion run itself
  fails.
- The writer job `needs` the history job and alone is queued per PR, so
  every writer starts after its own run's record is written, and the last
  writer to run sees every record.
- Size (F1). GitHub caps a check run's `output.text` at 65535 characters.
  A snapshot never stores note text: `notes` becomes one
  `high|other: <n> note(s) omitted, sha256 <hex>` marker, so a high note
  still blocks and distinct blocks stay distinct; evidence and findings are
  bounded too. Fresh entries are split across as many records as needed.
  An entry that still cannot fit fails the history job. The writer runs with
  `if: always()` and gets `--history-result <needs.result>`: anything but
  `success` is `missing_input`, so a failed history write fails the gate
  instead of leaving an earlier result on the head. The gate's own summary
  is shrunk to fit (ignored details, then verdict snapshots, then one
  unreadable marker), never into a pass.
- The records sit on `HISTORY_ANCHOR_SHA`, the repository's root commit,
  which exists forever and is never a PR head. They are keyed on the PR, not
  a head SHA, and bound to the head like live verdicts (by `sha` or
  `diff_id`), so a new head with the same `diff_id` still sees a deleted FAIL.
- Reading fails closed: if the history list cannot be read, any record's
  provenance does not resolve, or any record is not valid JSON of that schema
  for that PR, the result is `missing_input`. Provenance is `external_id`
  (`pr-<N>:run-<id>`), not the check suite.
  The same holds for the gate's own earlier check runs on the head: a run
  without a readable JSON summary holding a `deleted_verdicts` list is
  `missing_input`, never empty history.
- Residual risk (as R3): a workflow that a PR adds runs as GitHub Actions too
  and could update a history check run. Any `.github/**` change needs
  Blaine's approval record, and the land helper recomputes the gate from main.

**Fail closed.** A missing, unparseable, error, unknown or partial input is
never a pass: no live head or a moved head (`missing_input`, `stale_sha`), a
`diff_id` that cannot be computed (`error`), unreadable comments, an
unreadable or incomplete commit list in either stage, unreadable verdict
history or earlier gate check runs (`missing_input`), and any sensitive-class result
whose `status` is not exactly `ok`, that is missing, for another SHA, or does
not cover every changed file (`classifier_error`, and `automerge:
needs_blaine`). The advisory `jev-screen` status is never read, counted or
required.

**Output.** The check-run text holds the JSON summary: `gate`, `sha`,
`diff_id`, `mode`, `identity`, `identity_note`, `verifier_comment_id`,
`reviewer_comment_ids`, `approval_comment_id`, `automerge`
(`needs_blaine` for any class or a classifier error, otherwise
`needs_release`; `eligible` waits for OVD-841), `sensitive_classes`,
`reasons` (`{ code, detail }`), `warnings`, `ignored` and
`deleted_verdicts`. `MODE = "report"` writes `success`, or `neutral` with
the title `REPORT: would block: <codes>`. In enforce mode (PR-G3) the
conclusion is only `success` or `failure`.

**Corroboration.** The `corroborated` field on findings is self-reported and
covers only the findings inside one verdict. The gate does not read it: any
`high` finding blocks whether or not it is corroborated. A consumer that needs
corroboration across separate reviewer comments must run `tagCorroborated`
over the combined findings itself.

**CLI.** From a clean default-branch checkout, with `GITHUB_TOKEN` or
`GH_TOKEN` set: `node scripts/ovd-merge-gate.mjs evaluate --pr N --sha S
--json` prints the summary and exits 0 for `gate: pass`, 1 for fail and 2 on
usage errors. It fetches `refs/pull/N/head` and the base branch, as git data
only, into `refs/ovd-merge-gate/*` of a fresh bare repository in a temporary
directory, computes `diff_id` there and removes it; nothing is fetched into
the checkout, and no PR file is checked out or run (`--no-fetch` reads
`origin/<base>` in the current repository instead). `record --pr N` appends
to the verdict history.
The land helper and merge read-back consume it in PR-G2.

## Corroboration

`tagCorroborated(findings, { lineTolerance = 0 })` sets `corroborated: true` on
a finding when another model family raised a finding on the same file at a line
within `lineTolerance`. File-level findings (`line: null`) only match other
file-level findings. When one family repeats a finding, that isn't
corroboration. The emitted field is advisory; see the OVD-845 merge gate section.

## Tests

`scripts/verdict-schema.test.mjs` and `scripts/emit-verdict.test.mjs` (vitest)
cover:

- the emit-to-validate round trip;
- one fixture per schema violation;
- patch-id stability across a no-op rebase, and a new patch-id when the content
  of the diff changes, including an indentation-only change or a change only in
  invalid UTF-8 bytes; the same id under different `diff.*` config (temporary
  git repo in `os.tmpdir()`); and, as documented above, the same id for the same
  edit at two different positions with identical context;
- NUL bytes: two commits whose text-classified files differ only after a NUL
  past byte 8000 make `computePatchId`, `buildVerdict` and the CLI fail (exit 1,
  nothing on stdout) instead of returning one shared id, while a NUL-free diff
  and a git-classified binary file with an early NUL still get distinct ids;
- split patch-id output: two commits that carry the same crafted binary file
  (its last base85 line starts with 40 hex characters, with no NUL anywhere in
  the diff) and differ only in files sorted after it. Raw `git patch-id` prints
  two lines for each, and `computePatchId`, `buildVerdict` and the CLI fail
  (exit 1, nothing on stdout) instead of returning the shared first id, while an
  ordinary diff and an ordinary binary file still get one id.
  `parsePatchIdOutput` is also tested directly: one line is accepted; no
  output, a bare newline, several lines, or a line that is not
  `<40-hex> <40-hex>` throw;
- `--base`/`--head`: both required; ref names (`main`, `origin/main`, `HEAD`),
  39- and 41-character hex, uppercase hex and values starting with `--` are
  refused, a valid SHA is accepted, and an unknown SHA is reported;
- extra fields named after `Object.prototype` members, and future timestamps;
- comment parsing: non-fenced text, latest block for a SHA, conflicts (with a
  `null` verdict), ordering by instant, edited comments and author mismatch;
- advisory reviewer verdicts;
- corroboration;
- `--findings` resolution: `../` traversal, absolute paths outside the base,
  symlinks (including one inside the repository pointing outside), and
  `$RUNNER_TEMP` as a base;
- the CLI entry guard: the script runs `main()` (and reports errors with a
  non-zero exit) when launched directly or through a symlinked path, and
  the shared [`isEntryPoint` helper](../scripts/lib/entry-point.mjs) covers
  symlink resolution, imports, and missing or unresolvable `argv[1]`;
- posting only with `--post`, through an injected runner: injected PR numbers
  are refused, the argv is fixed, the body file holds the comment during the
  call, and the temp directory is gone afterwards (also when `gh` fails).

PASS evidence must cite a successful run of `.github/workflows/ci.yml` or
`.github/workflows/verify.yml` in this repository. The Actions run API must
report `conclusion: success` and `head_sha` equal to the verdict SHA, including
when a verdict is carried across a rebase by equal `diff_id`. Failed, cancelled,
in-progress, unrelated-workflow and unreadable runs do not count.

History and prior gate checks must belong to GitHub Actions app 15368.
Provenance is `external_id` (`pr-<N>:run-<id>`) alone (OVD-1110). The writer
also sets `details_url` to `https://github.com/<this repo>/actions/runs/<id>`,
but that is informational: GitHub may replace it with the check run's own URL,
and the writer asserts it just as it asserts `external_id`. When `details_url`
is an Actions run URL it must name this repository's run `<id>`. The check suite
is not the key: a check run posted to a SHA this workflow did not run on can
land in a suite with no workflow run, or in another workflow's suite, and a
suite lookup then sticks every later read on `missing_input`. The cited Actions
run must be `.github/workflows/ovd-merge-gate.yml`, triggered by
`pull_request_target`, `issue_comment` or `workflow_dispatch` (`merge_group`
is not a trusted writer: its YAML comes from the queue ref). For
`issue_comment` and `workflow_dispatch`, `head_branch` must be the
repository's current default branch. A `pull_request_target` run executes
the base branch's YAML and its `head_branch` is the PR head, so a non-default
base could forge these records. `workflow_run.pull_requests` is computed when
the API is read, not when the run happened, so a base retargeted after the run
would still look like the default branch. A `pull_request_target` record is
therefore trusted only when all hold (OVD-1109): `pull_requests` is exactly the
PR being evaluated, based on the default branch; that PR is still based on the
default branch and was created no later than the run; the run was created after
the PR's last `base_ref_changed` event (so a PR retargeted to the default branch
is trusted again for runs after the retarget); the run's `head_branch` and
`head_repository` are that PR's head; and every PR, open or closed, from the
same head branch targets the default branch and had no `base_ref_changed`
event at or after the run (a closed sibling drops out of `pull_requests` but
could have triggered the run, and one retargeted before it closed shows only
its final base). Anything else fails closed with `missing_input`, by design:
fork PRs (empty `pull_requests`), closed PRs, PRs sharing a head branch with
another open PR, runs from another head repository or branch, records written
before a retarget of this PR or a same-head sibling, and head branches whose
PRs target another base.
Unverifiable provenance blocks with `missing_input`. Records written before the
OVD-1110 key (external id `pr-<N>` and a `/runs/<check_run_id>` details URL)
stay unverifiable. Records exposing distinct `created_at` and `updated_at` are
rejected. The Checks API does not reliably expose update history; differences
between `started_at` and `completed_at` do not prove mutation. Provenance alone
cannot detect an update by another workflow using the same Actions app token.
Nor does it stop a forged record: any workflow in this repository with
`checks: write` can post `external_id: pr-<N>:run-<id>` citing a real (public)
ovd-merge-gate run id, and the cited run is not checked to be a run for PR
`<N>` (`issue_comment` and `workflow_dispatch` runs carry no PR link). The old
suite key could not be forged this way. A stored record can only add blocking
verdicts or force `missing_input`, so a forgery can block a PR but cannot turn
it into a pass. Removal candidates dedupe only when every field the gate reads
(`comment_id`, `author`, `created_at`, `sha`, `diff_id`, `role`,
`verdict_block`) matches, so a forged copy of a genuine record cannot displace it.
