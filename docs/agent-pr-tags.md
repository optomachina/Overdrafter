# PR builder tags (report only)

Record the builder history in one PR body line, in commit order:

```text
Built-by: bot=engineer model=model:codex
```

On repair, append an entry; never replace the original builder:

```text
Built-by: bot=engineer model=model:codex; bot=architect model=model:claude-opus
```

Each entry has exactly `bot=<id> model=model:<pool-id>`. Model labels use
`model:<pool-id>` too. Known bot IDs are `engineer`, `designer`, `release`, `qa`,
`lead`, `architect`, `cursor-cloud`, and `mac-mini-claude-jobs`. The fixture's
`may_build` field records whether each bot can build; a non-builder tag produces
a finding.

The legacy body line `Model: model:codex` remains readable as model-only metadata
with `bot=unknown`, so it gets fail-safe review. The free-text form
`Built-by: <bot> / <family> (...)` is also accepted, for example
`Built-by: Engineer / Codex (gpt via codex exec, ChatGPT plan)`.
Bot IDs and display names match case-insensitively. The token after `/` is the
leading run of letters, digits, and hyphens (plus a `.` between digits, as in
`grok-4.7`); it is retained as `token` and the rest of the word is context.
Case-insensitive prefixes map to existing pools: `codex`, `gpt`, and `openai`
to `codex`; `claude` and `sonnet` to `claude-sonnet`; `opus` and
`claude-opus` to `claude-opus`; `grok` to `grok-overflow`; and `jev` to `jev`.
Missing or unknown families get fail-safe review. So does a second builder:
another family's keyword anywhere in the rest of the token (`codex-opus`), or,
outside parentheses, another family's keyword at the start of a word whatever
precedes it (`codex.opus`, `codex and opus`), a `+`, a second `/`, or a `,`
followed later by any family keyword or a known bot ID or display name. Text
inside balanced parentheses is not scanned. Free text is tried only for
noncanonical entries. Use a single Built-by line; it supersedes legacy Model
lines in the same body.

Optional commit trailers use the same canonical Built-by syntax. Supply commits
oldest first. A trailer takes precedence for its commit; a commit without one
uses the body history as fallback. Adjacent identical builder entries collapse.
Trailer model claims must appear in the body's declared model history in order.
When every commit carries a trailer, the trailers are the whole history, so each
model the body declares must also appear in them: a body that declares a Codex
build then an Opus repair is not satisfied by trailers that all name Codex, or
by one squashed commit that names only Opus. A disagreement in either direction
is a conflict, even though trailers determine attribution. When
some commits carry a trailer and others have neither a trailer nor a body
history to fall back on, the untagged commits' builder is unknown: that is a
finding, so review is never narrowed on partial attribution.

`parseBuiltBy` reports builders, status, and findings. Unknown bots/models,
unparseable tags, and multiple model labels on a single-builder PR produce
findings. Labels outside the declared builder history (the body's, or the
commit trailers' when the body declares none) produce conflicts. Builders
from multiple families produce `mixed`. Missing, unknown, mixed, conflicting,
or failed parsing/routing requests fresh-session `claude-opus` plus
`claude-sonnet`. This conservative fallback also covers `jev` builders without
a route, and never requests `codex-xhigh` when Claude is or may be a builder.
An `ok` tag requests the pool `review_routing` names for the builder's family.
A route is a pool id, or `{ "reviewer": <pool>, "fresh_session": true }` when the
review must run in a fresh session with no build context; the alias `openai`
resolves to `codex-xhigh`. Current routes: `openai` builds are reviewed by
`claude-sonnet` (sensitive-path/HIGH rules can supply an extra Opus reviewer),
`claude` builds by `claude-opus`
in a fresh session with no build context, and `grok` builds by `claude-opus`.
Routes must cross families, with one exception: a `claude` route may name a
`claude` pool only when it is marked `fresh_session: true`. Any other
same-family route fails to load. Fresh-session flags on cross-family routes
and OpenAI review routes for Claude builds also fail to load. Extra reviewers
are retained, except malformed extras and Codex extras when Claude built or may
have built become `queue`. Availability never removes required reviewers:
when none of the required pools is available,
return `queue` plus extras instead of skipping review.

`reviewFamilies` and the CLI's `reviewers` array carry fresh requirements as
`{ "reviewer": "claude-opus", "fresh_session": true }`; other entries remain
pool strings. Among the configured single-family routes, only Claude builders
receive this flag; uncertain attribution receives it through the fallback.

Before dispatch, callers must run `assertReviewDispatch(requiredEntry,
reviewRecord)` with launcher evidence, never PR-supplied claims. The record's
`reviewer` must match the required pool. For a fresh entry, the check throws
unless `session_id` is a non-empty string, `no_persistence === true`,
`inherited_transcript === false`, and `builder_session_ids` is a non-empty
array of non-empty strings, all different from the review session ID after
trimming whitespace. Missing or malformed evidence throws; queue for evidence
instead of dispatching. A `queue` entry cannot be dispatched.

Tags are self-declared routing hints, never a trust signal. This module and CLI
are report-only: the exported check validates caller-supplied evidence but
does not launch sessions or collect evidence. No live dispatch, gate, workflow,
check, or status is updated. Rule 5 (Codex critiques plans) is not encoded in
this module.

The JSON-compatible YAML fixture at
`scripts/fixtures/agent-graph/model-routing.v2.yaml` is the stand-in until
OVD-919 PR-A pins the v2 shape in `docs/agent-graph/model-routing.yaml`. The loader
uses JSON parsing and validates this subset of YAML; general YAML syntax is not
supported. No YAML dependency is added. Import callers pass routing explicitly;
missing routing requests fresh-session Opus plus Sonnet.

Run a local report with:

```sh
node scripts/agent-graph/built-by.mjs --body /tmp/pr-body.txt --labels model:codex --json
```

`--routing <file>` selects another JSON-compatible YAML file; the default is the
fixture above. Output is JSON with `builders`, `status`, `findings`, and
`reviewers`, including on errors. Reports always exit zero. Raw file contents
and exception details are not echoed in error findings.
