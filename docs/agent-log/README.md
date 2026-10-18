# Agent decision log

`jev-decisions.jsonl` (written to `~/work/claude-jobs/jev-decisions.jsonl`,
outside the repository) records every Jev (TypeSafe, `jev-1.13.0`) decision the
lead engineer uses to size review, one JSON object per line: PR, head SHA
(`head_sha`), deterministic tier, the matched sensitive-path classes
(`sensitiveClasses`, from `docs/sensitive-paths.json` through
`scripts/lib/sensitive-paths.mjs`), Jev's tier, confidence and incident
probability, the final tier, `latency_ms` (null on cache hits), `tokens`,
`cache_hit`, `marker_tier`, `caller`, and `screener`.

* `cache_hit` (bool) is true when a `jev-screen` marker answered and Jev was
  not called.
* `tokens` is `{ input_tokens, output_tokens }` from the Jev response's
  `usage` (each a count or null), or null on a cache hit or when the response
  has no usage. It is never estimated.
* `sha` and `marker_hit` are duplicate aliases of `head_sha` and `cache_hit`,
  kept for older readers. `replay()` accepts either name.

Dedupe: uses GitHub commit status markers (context `jev-screen`, state
`success`) keyed by (full 40-hex SHA, screener, question-set hash, model, verified-path hash). The
question-set hash covers every nested field of the questions. A marker is read
or written only when the input's `pr` is a real PR number and its `sha` is that
PR's current head SHA on GitHub, with a verified complete file list. A stale or
unknown PR head fails risky with `files-incomplete`.
Reading is fail-safe: re-screens on anything missing, mismatched or untrusted.
Only an accepted (confident) Jev answer is written, with its confidence and
incident probability, and writing fails open: a write failure is warned about
and never fails the screen. A hit replays the stored answer at its stored
confidence, and the final tier is the highest of the local deterministic tier,
the replayed Jev tier and the marker's tier (`marker_tier`), so a hit never
lowers a tier. There is no pending claim: overlapping screens both call Jev.

Rules the log encodes, and the review each tier gets:

* Jev can only raise risk. The final tier is the higher of the deterministic
  tier and Jev's tier.
* A failed or low confidence Jev call raises the tier to at least `normal`.
* An unknown deterministic tier counts as `risky`, and any changed file on the
  shared sensitive-path list raises it to `risky`.
* `low` stops after an independent QA or Sonnet review, `normal` gets an
  independent Sonnet review, `risky` gets an independent Opus review.
  Anything on Blaine's hard list (migrations, RLS, SECURITY DEFINER, CI
  workflows, secrets, auth, deploy) also needs his explicit yes to merge.
* Provider dispatch, retry, kill switch, export control and migration window
  PRs also get a Codex cross review. When the two reviews disagree, or Codex
  raises a finding the Opus review did not, a skeptic agent per finding tries
  to refute it with a running test before the merge decision. Learned on
  Oct 12: an Opus APPROVE on #699 missed a retry path that could create two
  provider quotes for one permit; Codex found it and skeptics reproduced it.

Screen a batch against the PR base's sensitive-path list, so a PR that narrows
`docs/sensitive-paths.json` cannot lower its own tier (without `--base-ref` the
working tree's copy is used; if the list cannot be loaded, including a
`--base-ref` that does not resolve, every PR screens `risky`). Caller-supplied `files` are ignored. With a PR number, the screen fetches
all REST file pages and checks their exact count against `changed_files`, with
head/base snapshots before and after. A mismatch, malformed/duplicate page,
failed read, head race, or GitHub's 3000-file cap (including exactly 3000)
screens `risky` with `filesProblem: "files-incomplete"`, without cache or Jev.
The full head/base/count identity is retained and revalidated before accepting
a cached or fresh result or writing a marker. Renamed files retain both the
current and previous path, with validated rename metadata. Counts reconcile API
records, separately from the deduplicated affected-path set used for classification
and hashing.

Without a PR number, `--base-ref` is required: the screen resolves it to a commit
SHA and obtains paths from `git diff --no-renames --name-only -z <base>...HEAD`. Failed base
resolution or an empty/failed diff fails risky. Disabling rename detection keeps
both deleted source paths and added destination paths in the affected set. Pre-PR screening never reads or
writes the PR status cache. Legacy `screen.py`/`packet.py` callers remain advisory;
this change does not activate or migrate them.

Marker v2 adds `f`, the full SHA-256 of the JSON-encoded, code-unit-sorted verified
paths, encoded as 43 base64url characters. v1, malformed and hash-mismatched
markers miss; no identity field is truncated to fit GitHub's 140-character limit.
An oversized description skips the write with a warning. Existing trusted-author,
strict parsing, status pagination/stability checks, confidence gates and tier
floors remain in force.

```bash
NODE_USE_ENV_PROXY=1 node scripts/jev-pr-screen.mjs --base-ref origin/main <input.json>
```

Replay a rule change over the log (for example a stricter confidence floor) with
`replay()` from `scripts/jev-pr-screen.mjs`, and compare `before` and `after`
against what the independent reviews actually found before adopting it.
