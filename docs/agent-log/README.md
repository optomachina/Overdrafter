# Agent decision log

`jev-decisions.jsonl` (written to `~/work/claude-jobs/jev-decisions.jsonl`,
outside the repository) records every Jev (TypeSafe, `jev-1.13.0`) decision the
lead engineer uses to size review, one JSON object per line: PR, head SHA
(`head_sha`), deterministic tier, the matched sensitive-path classes
(`sensitiveClasses`, from `docs/sensitive-paths.json` through
`scripts/lib/sensitive-paths.mjs`), Jev's tier, confidence and incident
probability, the final tier, `latency_ms` (null on cache hits; renamed from
`latencyMs`, so older rows and readers that use `latencyMs` need updating), `tokens`,
`cache_hit`, `marker_tier`, `caller`, and `screener`.

* `cache_hit` (bool) is true when a `jev-screen` marker answered and Jev was
  not called.
* `tokens` is `{ input_tokens, output_tokens }` from the Jev response's
  `usage` (each a count or null), or null on a cache hit or when the response
  has no usage. It is never estimated.
* `sha` and `marker_hit` are duplicate aliases of `head_sha` and `cache_hit`,
  kept for older readers. `replay()` accepts either name.
* `fallback_source`, `fallback_reason` and `warning` are on every row and null
  when the row rests on an accepted Jev answer. Otherwise the source is
  `default_jev_blocked` (the Jev call failed with `http_401` or `http_403`),
  `jev_blocked` (any other failed call, or a screen that got no verdict with
  `files-incomplete` before Jev was asked), `safe-default` (Jev answered below
  the confidence floor) or `jev_used:false` (the answer had no usable tier). The
  reason is one sanitized token. `warning` is the same `WARN jev-fallback` line
  the screen writes to stderr and the CLI appends to the report line. This is
  logging only; the tier rules below do not change.

Dedupe: uses GitHub commit status markers (context `jev-screen`, state
`success`) keyed by (full 40-hex SHA, screener, question-set hash, model, screen
state digest). The question-set hash covers every nested field of the questions.
The screen state digest binds the marker to everything Jev was sent and to the
verified base: the files exactly as sent (verified affected paths, in acquisition
order, never sorted), the title, the notes, additions and deletions, and the
verified base commit SHA. A changed title, notes, size, base or file order is a
miss and runs Jev again; an unchanged input is a hit with no Jev call. A marker
is read or written only when the input's `pr` is a real PR number and its `sha` is
that PR's current head SHA on GitHub, with a verified complete file list and a
verified base commit. A stale or unknown PR head, or an acquisition without a
valid base commit, gets no verdict (`no_verdict`) with `files-incomplete`.
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
* A failed or low confidence Jev call fails closed: the row's `final` is
  `no_verdict` (no tier), the CLI prints `no verdict` and exits 3.
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
gets no verdict (`no_verdict`) with `filesProblem: "files-incomplete"`, without cache or Jev.
The full head/base/count identity is retained and revalidated before accepting
a cached or fresh result or writing a marker. Renamed files retain both the
current and previous path, with validated rename metadata. Counts reconcile API
records, separately from the deduplicated affected-path set used for classification
and hashing.

Without a PR number, `--base-ref` is required: the screen resolves it to a commit
SHA and obtains paths from `git diff --no-renames --name-only -z <base>...HEAD`. Failed base
resolution or an empty/failed diff gets no verdict. Disabling rename detection keeps
both deleted source paths and added destination paths in the affected set. Pre-PR screening never reads or
writes the PR status cache. Legacy `screen.py`/`packet.py` callers remain advisory;
this change does not activate or migrate them.

Marker format (version `v3`):

```text
v3 tier=<final> jev=<jev tier> c=<confidence> p=<incident|na> model=<model> q=<question hash> screener=<id> s=<digest>
```

`s` is the full SHA-256 of the canonical JSON of the verified base commit and the
screening state sent to Jev (`title`, `files` in order, `additions`, `deletions`,
`notes`), encoded as 43 base64url characters. The same digest, computed once per
PR, is used for both the marker lookup and the marker write. It replaces the v2
`f` field (a hash of the sorted paths only), which left the title, notes, sizes,
base and file order unbound. v1 and v2 markers are not read: a trusted `jev-screen`
status that fails to parse makes the whole read a miss, which is the safe direction
(Jev runs again). Other rejections that force the same whole-read miss: a status
that is not `success`, one naming another commit, a malformed or repeated field,
and a final tier below the Jev tier (`tier` lower than `jev`, which a writer never
produces; the writer refuses to send such a marker too). Markers for another key
(model, question hash or digest) are ignored, not rejections. No identity field is
truncated to fit GitHub's 140-character limit; an oversized description skips the
write with a warning. Existing trusted-author, strict parsing, status
pagination/stability checks, confidence gates and tier floors remain in force.

Prerequisite: the screen reads and writes through the `gh` CLI, so `gh` must be
installed in a trusted directory (`/usr/bin`, `/usr/local/bin` or
`/opt/homebrew/bin`; `PATH` is never searched) and authenticated (`gh auth status`)
with access to the repository. Marker writes need permission to create commit
statuses; without it the write is warned about and the screen result stands.

Options: `--base-ref <ref>` selects the PR base's sensitive-path list (and is
required without a PR number); `--caller <id>` records who ran the screen in the
`caller` field of the decision row (sanitized to one token, null when omitted).

```bash
NODE_USE_ENV_PROXY=1 node scripts/jev-pr-screen.mjs --base-ref origin/main --caller <id> <input.json>
```

Replay a rule change over the log (for example a stricter confidence floor) with
`replay()` from `scripts/jev-pr-screen.mjs`, and compare `before` and `after`
against what the independent reviews actually found before adopting it.
