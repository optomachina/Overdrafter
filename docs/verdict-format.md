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
  --base origin/main --head HEAD \
  --verifier-id astra-verifier --model-family opus --github-login verifier-bot \
  --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/1 \
  --checks green --conflicts 0 --open-threads 0 \
  --note "low: rename helper for clarity"
```

- Arguments are treated as untrusted (they may come from an LLM).
  `--base`/`--head` must be plain revisions: no leading `-`, no `..`, only
  ref characters (`A-Za-z0-9._/@{}~^+-`). `--pr` must be a positive integer,
  and the body goes to `gh` over stdin. `--findings` must resolve (after
  symlinks) to a file inside the working directory or the OS temp directory.
  `git` and `gh` are run by absolute path from `/usr/bin`, `/bin` or
  `/usr/local/bin` with `PATH` pinned to those directories.
- `sha` comes from `git rev-parse --verify --end-of-options <head>^{commit}`.
  Head is resolved once, and `patch_id` is computed from that same SHA, so the
  two always describe the same commit.
- `patch_id` is `git patch-id --verbatim` over `git diff base...head`, with both
  ends resolved to SHAs first (so `--base`/`--head` can never be read as git
  options). `--verbatim` keeps whitespace, so an indentation-only change gets a
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
  `--post` and `--pr <n>`, and then it runs `gh pr comment <n> --body-file -`.
  Tests inject the runner and never post.

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
  `diff.*` config; `--base`/`--head` values that look like git options are
  refused (temporary git repo in `os.tmpdir()`);
- extra fields named after `Object.prototype` members, and future timestamps;
- comment parsing: non-fenced text, latest block for a SHA, conflicts (with a
  `null` verdict), ordering by instant, edited comments and author mismatch;
- advisory reviewer verdicts;
- corroboration;
- posting only with `--post`, through an injected runner.
