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
  "patch_id": "<git patch-id --stable of base...head>",
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
rejected.

## Emitting

```bash
node scripts/emit-verdict.mjs --role verifier --verdict PASS \
  --base origin/main --head HEAD \
  --verifier-id astra-verifier --model-family opus --github-login verifier-bot \
  --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/1 \
  --checks green --conflicts 0 --open-threads 0 \
  --note "low: rename helper for clarity"
```

- `sha` comes from `git rev-parse <head>^{commit}`.
- `patch_id` is `git patch-id --stable` over `git diff base...head`. The script
  pins the diff options (no renames, Myers algorithm, `a/` and `b/` prefixes, no
  external diff or textconv), so local git config can't change the id. An empty
  diff is an error.
- `timestamp` is the current UTC time, to the second.
- Reviewers add `--role reviewer --findings findings.json`. The script tags the
  findings with `corroborated` before printing them.
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
| `verdict` / `comment_id` | Latest valid `verifier` verdict for `sha`, ordered by comment `created_at` and then by block order, or `null`. |
| `conflicts` | Other valid verifier verdicts for `sha` whose `verdict` or `patch_id` differs from the latest one. |
| `reviews` | Valid advisory `reviewer` verdicts for `sha`. |
| `other_sha` | Valid verdicts for other SHAs. These are stale for this head. Under the OVD-845 rebase rule, a verdict carries over only when its `patch_id` equals the patch-id recomputed for the current head. |
| `rejected` | `{ comment_id, block, reason, errors }`, where `reason` is one of `edited_comment`, `missing_comment_timestamps`, `invalid_json`, `schema_error` or `author_mismatch`. |

The parser only reads blocks that start with a ```` ```overdrafter-verdict ````
line and end with a closing fence line. It ignores other text and fences in
other languages. A gate must treat any `conflicts` entry, or any rejected block
that may belong to the current head, as `verdict_schema_error`.

The parser doesn't check independence: whether the verifier also authored or
committed a commit in the PR (`verifier_not_independent`). It also doesn't
check SHA staleness against the live head. OVD-845 does both, using the PR
commits API.

## Corroboration

`tagCorroborated(findings, { lineTolerance = 0 })` sets `corroborated: true` on
a finding when another model family raised a finding on the same file at a line
within `lineTolerance`. File-level findings (`line: null`) only match other
file-level findings. When one family repeats a finding, that isn't
corroboration.

## Tests

`scripts/verdict-schema.test.mjs` and `scripts/emit-verdict.test.mjs` (vitest)
cover:

- the emit-to-validate round trip;
- one fixture per schema violation;
- patch-id stability across a no-op rebase, and a new patch-id when the diff
  changes (temporary git repo in `os.tmpdir()`);
- comment parsing: non-fenced text, latest block for a SHA, conflicts, edited
  comments and author mismatch;
- advisory reviewer verdicts;
- corroboration;
- posting only with `--post`, through an injected runner.
