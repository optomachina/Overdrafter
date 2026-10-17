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
with `bot=unknown`, so it gets fail-safe review. Free text such as
`Built-by: Engineer / Codex (gpt via codex exec, ChatGPT plan)` is unparseable and
also gets fail-safe review. Use a single Built-by line; it supersedes legacy
Model lines in the same body.

Optional commit trailers use the same canonical Built-by syntax. Supply commits
oldest first. A trailer takes precedence for its commit; a commit without one
uses the body history as fallback. Adjacent identical builder entries collapse.
Trailer model claims must appear in the body's declared model history in order;
a disagreement is a conflict, even though trailers determine attribution.

`parseBuiltBy` reports builders, status, and findings. Unknown bots/models,
unparseable tags, and multiple model labels on a single-builder PR produce
findings. Labels outside the body's model history produce conflicts. Builders
from multiple families produce `mixed`. Missing, unknown, mixed, conflicting,
or failed parsing/routing requests both `codex-xhigh` and `claude-sonnet`.
An `ok` tag requests a cross-family pool from `review_routing`; the family alias
`openai` resolves to `codex-xhigh`. Existing extra reviewers (including
`claude-opus` from sensitive-path/HIGH rules) are always retained. Availability
never removes required reviewers: when none of the required pools is available,
return `queue` plus extras instead of skipping review.

Tags are self-declared routing hints, never a trust signal. This module and CLI
are report-only: no live dispatch, gate, workflow, check, or status is updated.

The JSON-compatible YAML fixture at
`scripts/fixtures/agent-graph/model-routing.v2.yaml` is the stand-in until
OVD-919 PR-A pins the v2 shape in `docs/agent-graph/model-routing.yaml`. The loader
uses JSON parsing and validates this subset of YAML; general YAML syntax is not
supported. No YAML dependency is added. Import callers pass routing explicitly;
missing routing requests both reviewers.

Run a local report with:

```sh
node scripts/agent-graph/built-by.mjs --body /tmp/pr-body.txt --labels model:codex --json
```

`--routing <file>` selects another JSON-compatible YAML file; the default is the
fixture above. Output is JSON with `builders`, `status`, `findings`, and
`reviewers`, including on errors. Reports always exit zero. Raw file contents
and exception details are not echoed in error findings.
