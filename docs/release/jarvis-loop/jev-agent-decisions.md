# Live Jev agent-decision evaluation

Claude Code cloud session, 2026-10-04. First **live** Jev evaluation; earlier
OVD-555/556 packages were baseline-only and simulated.

## Path and authentication

- Client: `scripts/jev-client.mjs` (`askJev`, `gatedChoice`); never throws, returns
  `{ok:false, reason}` on timeout, network, HTTP, malformed, or unexpected model.
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
- Protected actions route to `human_owner` by a deterministic regex before any call.
- Choice answers below confidence 0.5 become `needs_review` / `ordinary_reasoning`
  (the evaluation's floor; untuned, see Limitations).
- Evidence Nouls keep items at p >= 0.35, and keep items with no numeric
  probability (fail toward inclusion).
- Any failure falls back to the deterministic lexical baseline.
- Inputs are synthetic; no repository or private content is sent.

## Result (11 live calls, synthetic set)

Re-run on 2026-10-05 with the hardened client; the figures below match the first
run on 2026-10-04 except output tokens (642 then, 643 now), latency, and the
ambiguous routing confidence (0.61 then, 0.66 now).

| Decision | Jev (gated) | Lexical baseline |
| --- | --- | --- |
| Evidence selection, 4 relevant optional items | 1 omission (`login_e2e`, p=0.32), 0 extra | 2 omissions, 1 extra |
| Duplicate detection, 4 cases incl. ambiguous | 4/4 (ambiguous: conf 0.38 -> review) | 2/4 |
| Routing, 6 cases incl. ambiguous + protected | 5/6 (ambiguous routed `implementer` at conf 0.66; 0.61 in the first run) | 6/6 |
| Failure probes, 7 (below) | all returned `ok:false` and fell back | n/a |

Tokens 4,742 in / 643 out; estimated $0.0002 at $0.042/Mtok input; median latency
269 ms, max 381 ms; run wall time 3.8 s. Preparation/integration overhead: about
one hour of agent time (discovery, doc reading, client, eval); not token-counted.

Failure handling, and where each path is exercised:

| Path | Reason returned | Exercised by |
| --- | --- | --- |
| Unreachable host (refused connection to `127.0.0.1:65530`) | `network_ECONNREFUSED` | live eval probe |
| 1 ms client timeout | `timeout` | live eval probe |
| Request rejected by the service | `http_422` | live eval probe |
| Unknown model in the request | `http_400` (the service rejects it before answering) | live eval probe |
| Non-JSON 200 body | `malformed_response` | eval probe against a loopback stub; unit tests |
| 200 body naming another model | `unexpected_model_version` | eval probe against a loopback stub; unit tests |
| Choice without confidence | `malformed_response` | eval probe against a loopback stub; unit tests |
| JSON `null`/array, string or out-of-range confidence, choice outside criteria, Noul without a probability, HTTP 5xx, network cause code | as above | unit tests (mocked `fetch`) |

The live service cannot be made to return a malformed body or another model on
demand, so those two paths run against a local stub bound to `127.0.0.1` (no
outbound traffic) inside the evaluation, and in the unit tests.

## Limitations

Tiny hand-labelled synthetic set, single run, thresholds not tuned; not evidence
for adoption. The ambiguous routing miss shows 0.5 confidence is too low a floor
for routing (the evaluation ran with 0.5). Not wired into the controller or any
runtime path.

The evaluation also missed `login_e2e` (p=0.32, below the 0.35 floor) in
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
client (2026-10-05) returned `jev-1.13.0`, `verifier` at confidence 1.0, in
785 ms with 355 input / 35 output tokens.

The coordinator also ran an advisory Jev duplicate check in that session and
recorded it as: 9 calls; 8 scored `none` at or above 0.80; 1 uncertain,
resolved by ordinary reasoning. This is advisory evidence from one session, not
a validated duplicate threshold; 0.80 was a working cut-off, not a tuned value.

Until a larger labelled set exists, coordinators use Jev only as an advisory
first pass for evidence ranking, duplicate-candidate detection and worker-role
suggestion, with these guards in code and process:

- required instructions, authority boundaries, source identity and acceptance
  evidence are never filtered by Jev;
- a protected-action regex and ordinary reasoning decide before and after Jev;
- a Choice below 0.7 for routing, or below 0.5 elsewhere, goes to ordinary
  reasoning (both floors are untuned process rules; the 0.7 routing floor is
  not in code, and the evaluation above used 0.5 for routing);
- deterministic or already-known decisions skip the call;
- only public, synthetic or already-authorized inputs are sent;
- each real use records the question, model, latency and tokens, and a Jev
  failure never stops other work.
