# Review verdict format (OVD-851)

The independent verifier and the model reviewers (Opus, Grok, Codex) report a
typed verdict on a pull request in one shared envelope,
`overdrafter.verdict/v1`. This document describes the format and the tools that
emit and parse it. The merge gate that consumes it is OVD-845. This format
doesn't gate anything on its own.

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
| `role` | `verifier` or `reviewer`. **Only `verifier` verdicts are gate input.** `reviewer` verdicts are advisory. |
| `findings` | Required for `reviewer` (use `[]` for none), forbidden for `verifier`. Items are `{ severity, file, line, model }` plus optional `message` and `corroborated`. `line` is an integer ≥ 1 or `null` for a file-level finding. |
| `notes` | Strings prefixed with a severity: `high: `, `medium: `, `low: ` or `info: `. `PASS_NOTES` needs at least one note. Under OVD-845, a `PASS_NOTES` verdict with a `high:` note (`hasHighNote`) can't be merged. |
| `verifier.model_family` | Lower-case family token (`opus`, `grok`, `codex`, ...). |
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
  empty diff is an error.
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
**OverDrafter verdict: PASS** for `<sha>` by astra-verifier (opus).

```overdrafter-verdict
{ ...json... }
```
````

**Never edit a verdict comment.** An edited comment (`updated_at !=
created_at`) is rejected. To change a verdict, post a new comment.

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
| `other_sha` | Valid verdicts for other SHAs. These are stale for this head. Under the OVD-845 rebase rule, a verdict carries over only when its `patch_id` equals the patch-id recomputed for the current head. |
| `rejected` | `{ comment_id, block, reason, errors }`, where `reason` is one of `edited_comment`, `missing_comment_timestamps`, `invalid_json`, `schema_error` or `author_mismatch`. |

The parser only reads blocks that start with a ```` ```overdrafter-verdict ````
line and end with a closing fence line. It ignores other text and fences in
other languages. A gate must treat any `conflicts` entry, or any rejected block
that may belong to the current head, as `verdict_schema_error`.

## OVD-845 responsibilities

This format and its parser deliberately leave the following to the OVD-845
gate. The gate must do each of them; none is enforced here.

- **Independence.** The parser only checks that `verifier.github_login`
  matches the comment author. It does not check the login against the PR
  author or against the authors and committers of the PR's commits
  (`verifier_not_independent`), against an allowlist of verifier identities,
  or `verifier.model_family` against the implementer's model family. OVD-845
  owns all of these checks.
- **Corroboration.** The `corroborated` field on findings is self-reported by
  whoever emitted the verdict and covers only the findings inside that one
  verdict. Consumers must not trust it: recompute it with `tagCorroborated`
  over the findings they use. Corroboration across separate reviewer comments
  (for example an Opus review and a Grok review posted separately) is not
  computed anywhere in this format; if OVD-845 needs it, it must collect the
  findings from every valid `reviews` entry and run `tagCorroborated` over the
  combined list.
- **Staleness.** The parser doesn't compare `sha` with the live PR head.
  OVD-845 does, using the PR commits API, and applies the rebase rule above
  with a patch-id it recomputes itself.

## Corroboration

`tagCorroborated(findings, { lineTolerance = 0 })` sets `corroborated: true` on
a finding when another model family raised a finding on the same file at a line
within `lineTolerance`. File-level findings (`line: null`) only match other
file-level findings. When one family repeats a finding, that isn't
corroboration. The emitted field is advisory; see OVD-845 responsibilities.

## Tests

`scripts/verdict-schema.test.mjs` and `scripts/emit-verdict.test.mjs` (vitest)
cover:

- the emit-to-validate round trip;
- one fixture per schema violation;
- patch-id stability across a no-op rebase, and a new patch-id when the diff
  changes, including an indentation-only change; the same id under different
  `diff.*` config (temporary git repo in `os.tmpdir()`);
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
- posting only with `--post`, through an injected runner: injected PR numbers
  are refused, the argv is fixed, the body file holds the comment during the
  call, and the temp directory is gone afterwards (also when `gh` fails).
