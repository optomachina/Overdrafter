# Bounded Jev browser recovery

This opt-in source capability handles missing declared configuration selectors in
`runProviderPortalKernel`. Existing deterministic successes never observe extra DOM
or call Jev. Upload, drawing-upload, navigation, offer extraction, login, CAPTCHA,
and submission failures retain their existing stop behavior. An upload exception
is never retried or used as a recovery trigger.

## Contract and activation

An authorized local caller may supply `dependencies.recovery` with `enabled: true`,
`decide: createJevRecoveryDecider(existingServerSideKey)`, optional `signal`, and an
async durable `audit` sink. No environment switch enables production. The caller
must retain the existing exact-file approval and isolated session requirements;
this dependency grants no disclosure or provider authority. A missing selector
with opted-in recovery that cannot safely complete stops with `bounded_recovery_stopped`.

Recovery uses real DOM node handles, never generated selectors or JavaScript.
The supported operations are filling a declared quantity (positive integer up to
nine digits) and selecting an already declared material/finish/thickness value
that exists exactly once in the observed native select. Other operations and
custom widgets are unsupported. It never clicks buttons, uploads files, submits,
changes origins or generates field values.

Only a fixed vocabulary of labels is projected to Jev; raw HTML, body text, values,
option values, selectors, URLs, filenames, account identifiers, cookies and errors
are excluded. Unknown or mixed private/hostile labels are rejected in full.
This deliberately limits recall. No screenshots, iframe/shadow-root traversal,
ARIA-labelled-by resolution, custom comboboxes or translated labels are supported.
Controls must be visible, enabled, in viewport and unobscured. Known label aliases
are matched again against the requested field by code after inference. Page text
cannot grant new operations even if inference follows hostile instructions.

Each session has at most two recovery decisions/actions, 16 observed controls per
attempt, a five-second decision deadline, and a cumulative 4,000 reported-token
stop. An uncertain action, stale target or failed decision exhausts the session.
Model calls and actions are not retried. The token stop is post-response and does
not promise a provider billing ceiling. The shared transport bounds request and
response bytes (8 KiB/16 KiB), options (64), time (5 seconds), redirects and retries.
Confidence >= .9 and winning probability >= .95 are conservative unevaluated
starting thresholds, not a demonstrated model-quality guarantee.

The executor retains node identities and compares control markup, values, labels,
option sets, page URL, control count and portal readiness before acting. DOM changes
can still occur during browser input; unsuccessful or uncertain outcomes are terminal
and marked mutation-possible. The independent post-action value check proves only
the local input operation. Existing anchored offer extraction still determines quote
completion; a model cannot declare completion or supply money/lead time.

Receipts contain revision, sequential attempt, field, outcome, projected-observation
hash, candidate count, selected ephemeral ID, elapsed time, model and token usage.
The caller must persist receipts; no private DOM is written. Do not infer live model
usage from injected/simulated decisions.

## Advisory exception routing

`dependencies.failureTriage` optionally categorizes unstructured kernel exceptions
as expired session, unsupported part/feature, transient vendor issue, engineering
review or unknown. It uses the same Choice transport and a closed vocabulary
projection of the error message. Structured errors (including a `code` property)
skip inference. The receipt is attached as `payload.failureTriage`; it never changes
the original error, terminal state, mutation flag, queue retry policy or permissions.
Missing, cancelled, weak, malformed and over-budget responses remain unknown.
Only one decision is attempted. Raw exception text never enters the model request.

## Reproduce

```sh
npm ci --ignore-scripts
npm --prefix worker ci --ignore-scripts
npx vitest run worker/src/jev/choice.test.ts worker/src/recovery
npm --prefix worker run compare:browser-recovery
# Only with an already authorized configured TYPESAFE_API_KEY:
npm --prefix worker run compare:browser-recovery -- --live
```

The browser harness uses installed Playwright Chromium, intercepts every browser
request, and passes only synthetic file bytes through the real kernel. It compares
stable selectors, drift, hostile controls, duplicates, missing controls, stale DOM,
and uncertain uploads. Completion means the synthetic configured quantity produced
the fixture offer through the existing normalization path. It is not a real quote.
The default decision provider is scripted and reports **no model inference**.
Timing includes fixture setup and browser launch. Live mode calls the real fixed
endpoint only for projected synthetic observations and reports actual model/usage;
billing cost is unknown unless independently reconciled with current pricing.
No speedup or semantic-accuracy claim follows from the default harness.

## References

API, Choice and function-calling contracts were checked October 1, 2026:
[HTTP API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice),
[function calling](https://docs.typesafe.ai/cookbooks/function_calling).
The [Jev Ultrafast reference](https://github.com/browser-use/jev-ultrafast) reinforced
fresh indexed targets and independent completion checks; no source was copied and
its narrow demo benchmarks are not OverDrafter evidence.
