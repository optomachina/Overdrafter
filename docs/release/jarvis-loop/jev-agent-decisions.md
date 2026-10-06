# Live Jev agent-decision evaluation

Claude Code cloud session, 2026-10-04. First **live** Jev evaluation; earlier
OVD-555/556 packages were baseline-only and simulated.

## Path and authentication

- Client: `scripts/jev-client.mjs` (`askJev`, `gatedChoice`); never throws, returns
  `{ok:false, reason}` on timeout, network, HTTP, malformed, or unexpected model,
  and `invalid_request` (without sending) when the input cannot be serialized.
  A body counts as malformed unless it is a JSON object and every answer has the
  asked type; a Choice also needs a numeric confidence in [0, 1] and a choice
  named in its criteria, and a Noul needs a numeric probability in [0, 1].
  `gatedChoice` fails closed on a missing or malformed answer.
- Auth: the Claude Code agent proxy injects the TypeSafe credential for
  `api.typesafe.ai`. The client reads no key (not from the environment or
  anywhere else), sends no `Authorization` header of its own, and prints, logs
  or stores none. Without a proxy that injects auth the call fails and returns
  an advisory-unavailable result. Node needs `NODE_USE_ENV_PROXY=1` (plain
  `fetch` gets 403 from the egress sandbox).
- API per current docs (`POST /v1/systemone`); request pins `jev-1.13.0`, client
  rejects any other returned model.

## Invocation

```bash
# smoke (one synthetic routing call; prints model, latency, tokens, gated answer):
NODE_USE_ENV_PROXY=1 node --no-warnings scripts/jev-client.mjs --smoke
# evaluation (writes the results JSON next to this note, from any directory):
NODE_USE_ENV_PROXY=1 node --no-warnings scripts/jev-agent-decisions-eval.mjs
# unit tests (no network; mocked fetch and a loopback stub):
npx vitest run scripts/jev-client.test.mjs scripts/jev-agent-decisions-eval.test.mjs
# ad hoc:
curl -sS https://api.typesafe.ai/v1/systemone -H 'Content-Type: application/json' \
  -d '{"state":"...","model":"jev-1.13.0","questions":{"q":{"type":"noul","instructions":"..."}}}'
```

Results: `jev-agent-decisions-results.json` (per-call latency and usage).

## Boundaries enforced in code

- Required items (agent contract, acceptance criteria, design guidance) are never
  sent for filtering and are always retained.
- Choice answers below confidence 0.5 become `needs_review` / `ordinary_reasoning`
  (the evaluation's floor; untuned, see Limitations).
- Evidence Nouls keep items at p >= 0.35, and keep items with no numeric
  probability (fail toward inclusion).
- A failed Jev call (`ok:false`) never becomes a Jev decision. Each decision has
  its own fallback: evidence selection uses the deterministic lexical baseline
  (plus the required items); duplicate detection returns `needs_review` (no
  merge); routing returns `ordinary_reasoning`.
- Jev accuracy in the results counts only cases whose Jev call succeeded.
  Fallback outcomes of failed calls are reported as separate counts
  (`fallbackCases`, `jevFailedCalls`), and the keyword-gated case R5, which never
  calls Jev, is reported as `deterministicGate`.
- Each evidence record names its deterministic guard (`guard`: required items
  retained, the 0.35 keep floor, the lexical baseline on failure); duplicate and
  routing records carry `gate` (the 0.5 confidence floor).
- Model names and reasons that come from the service are recorded only as
  bounded printable tokens (at most 64 characters of `[A-Za-z0-9_.-]`).

## Process rules (not enforced by the client)

- Protected actions: the evaluation's `PROTECTED` regex in
  `scripts/jev-agent-decisions-eval.mjs` is an illustrative keyword list used
  only by the evaluation (it routes the synthetic case R5 to `human_owner`). It
  is not the protected-action boundary and misses many phrasings. AGENTS.md
  protected actions are identified by ordinary reasoning against AGENTS.md
  before and after any Jev call; Jev never decides a protected action.
- The evaluation's inputs are synthetic constants. The client does not restrict
  inputs, so the public/synthetic-only rule in the adoption rule below is a
  process rule.

## Result (11 live calls, synthetic set)

Three single-pass runs. The figures below are from the third run on
2026-10-05 (`generatedAt` 2026-10-05T22:25:05Z), which is the committed results
JSON. It is the first run with the corrected scoring: Jev accuracy counts only
cases whose Jev call succeeded. In this run all 11 decision calls succeeded
(`fallbackCases` 0, `jevFailedCalls` 0), so no fallback outcome is in the Jev
figures. Earlier runs: the first run on 2026-10-04 survives only in the commit
history (2b5ae57); the second run on 2026-10-05 (`generatedAt`
2026-10-05T19:15:18Z) is in the history at bcbadb2. Both earlier runs reported
routing as 5/6 because their scoring counted the keyword-gated case R5 (no Jev
call) as a Jev result; here it is 4/5 plus the keyword gate 1/1. Across the three
runs, input tokens (4,742), the omitted/extra evidence items and the
per-decision outcomes stayed the same; output tokens were 642 in the first run
and 643 in the second and third.

| Decision | Jev (gated, successful calls only) | Lexical baseline |
| --- | --- | --- |
| Evidence selection, 2 cases, 4 relevant optional items | 2 cases scored, 0 fallbacks: 1 omission (`login_e2e`, p=0.31; first run 0.32, second run 0.31), 0 extra | 2 omissions, 1 extra |
| Duplicate detection, 4 cases incl. ambiguous | 4/4, 0 failed calls (ambiguous D4: top choice `T3` at conf 0.42 -> review; first run `none` at 0.38, second run `T3` at 0.42) | 2/4 |
| Routing, 5 Jev cases incl. ambiguous | 4/5, 0 failed calls (ambiguous R6 routed `implementer` at conf 0.69; first run 0.61, second run 0.66) | 6/6 over all 6 cases |
| Routing, keyword-gated case R5 (no Jev call) | 1/1 by the illustrative keyword gate (`deterministicGate`), not a Jev result | (included above) |
| Failure probes, 7 (below) | all returned `ok:false`; the gate reported `failed` for each and no Jev answer was used | n/a |

The failure probes record the lexical baseline route as their `fallback` field;
that is a probe check that a fallback exists, not what `route()` does (a failed
routing call in `route()` returns `ordinary_reasoning`).

Third run: tokens 4,742 in / 643 out; estimated $0.0002, which prices input
tokens only at $0.042/Mtok (output tokens are not priced; `costBasis` in the
JSON); median latency 262 ms, max 717 ms; run wall time 3.9 s. Second run:
median 269 ms, max 381 ms, wall 3.8 s. First run: median 262 ms, max 650 ms.
Preparation/integration overhead: about one hour of agent time (discovery, doc
reading, client, eval); not token-counted.

Failure handling, and where each path is exercised:

| Path | Reason returned | Exercised by |
| --- | --- | --- |
| Unreachable host (refused connection to `127.0.0.1:65530`) | `network_ECONNREFUSED` | eval probe, local: a real socket refused on loopback (labelled `live` in the JSON; it never reaches the service) |
| 1 ms client timeout | `timeout` | eval probe, local: a real client-side abort before the service answers (labelled `live` in the JSON) |
| Request rejected by the service | `http_422` | eval probe against the live service |
| Unknown model in the request | `http_400` (the service rejects it before answering) | eval probe against the live service |
| Non-JSON 200 body | `malformed_response` | eval probe against a loopback stub; unit tests |
| 200 body naming another model | `unexpected_model_version` | eval probe against a loopback stub; unit tests |
| Choice without confidence | `malformed_response` | eval probe against a loopback stub; unit tests |
| JSON `null`/array, string or out-of-range confidence, choice outside criteria, Noul without a probability, HTTP 5xx, network cause code | as above | unit tests (mocked `fetch`) |
| State that cannot be serialized (BigInt or circular) | `invalid_request` (nothing is sent) | unit tests |

The live service cannot be made to return a malformed body or another model on
demand, so those two paths run against a local stub bound to `127.0.0.1` (no
outbound traffic) inside the evaluation, and in the unit tests.

## Limitations

Tiny hand-labelled synthetic set, three single-pass runs (the first survives only in commit 2b5ae57, the second at bcbadb2), thresholds not tuned; not evidence
for adoption. The ambiguous routing miss shows 0.5 confidence is too low a floor
for routing (the evaluation ran with 0.5). Not wired into the controller or any
runtime path.

The evaluation also missed `login_e2e` (p=0.31 in the second and third runs, 0.32 in the first run; below the 0.35 floor) in
evidence case E2, and its lexical baseline is not a full agent-cost comparison:
it measures lexical overlap only, not the tokens or time an agent would spend
reading an omitted item. None of the 0.35 evidence floor, the 0.5 choice floor
or the 0.7 routing floor in the adoption rule below is a proven or tuned
threshold.

## Coordinator adoption rule (2026-10-04, second cloud session)

Availability was re-checked from a fresh cloud container with one synthetic
routing call: `jev-1.13.0` returned in 628 ms, 383 input / 44 output tokens,
`verifier` at confidence 1.0. The call used the proxy-injected credential; no
key was read, printed or exported. A later `--smoke` run from the hardened
client (2026-10-05, at commit 4afe0f2) returned `jev-1.13.0`, `verifier` at
confidence 1.0, in 785 ms with 355 input / 35 output tokens. Token counts are
the same on every smoke run; latency varies from run to run (later runs at
other heads measured between roughly 390 and 790 ms).

The coordinator also ran an advisory Jev duplicate check in that session and
recorded it as: 9 calls; 8 scored `none` at or above 0.80; 1 uncertain,
resolved by ordinary reasoning. This is advisory evidence from one session, not
a validated duplicate threshold; 0.80 was a working cut-off, not a tuned value.

Until a larger labelled set exists, coordinators use Jev only as an advisory
first pass for evidence ranking, duplicate-candidate detection and worker-role
suggestion, with these guards in code and process:

- required instructions, authority boundaries, source identity and acceptance
  evidence are never filtered by Jev;
- AGENTS.md protected actions are identified by ordinary reasoning against
  AGENTS.md before and after any Jev call, and Jev never decides a protected
  action (the evaluation's keyword regex is illustrative only, not this
  boundary);
- a Choice below 0.7 for routing, or below 0.5 elsewhere, goes to ordinary
  reasoning (both floors are untuned process rules; the 0.7 routing floor is
  not in code, and the evaluation above used 0.5 for routing);
- deterministic or already-known decisions skip the call;
- only public or synthetic inputs are sent; repository, private or customer
  content needs an explicit owner instruction recorded in the Linear issue first;
- each real use records the question, model, latency and tokens, and a Jev
  failure never stops other work.
