# Live Jev agent-decision evaluation

Claude Code cloud session, 2026-10-04. First **live** Jev evaluation; earlier
OVD-555/556 packages were baseline-only and simulated.

## Path and authentication

- Client: `scripts/jev-client.mjs` (`askJev`, `gatedChoice`); never throws, returns
  `{ok:false, reason}` on timeout, network, HTTP, malformed, or unexpected model.
- Auth: the Claude Code agent proxy injects the TypeSafe credential for
  `api.typesafe.ai`. No key is read, printed, or created. Node needs
  `NODE_USE_ENV_PROXY=1` (plain `fetch` gets 403 from the egress sandbox).
- API per current docs (`POST /v1/systemone`); request pins `jev-1.13.0`, client
  rejects any other returned model.

## Invocation

```bash
NODE_USE_ENV_PROXY=1 node --no-warnings scripts/jev-agent-decisions-eval.mjs
# ad hoc:
curl -sS https://api.typesafe.ai/v1/systemone -H 'Content-Type: application/json' \
  -d '{"state":"...","model":"jev-1.13.0","questions":{"q":{"type":"noul","instructions":"..."}}}'
```

Results: `jev-agent-decisions-results.json` (per-call latency and usage).

## Boundaries enforced in code

- Required items (agent contract, acceptance criteria, design guidance) are never
  sent for filtering and are always retained.
- Protected actions route to `human_owner` by a deterministic regex before any call.
- Choice answers below confidence 0.5 become `needs_review` / `ordinary_reasoning`.
- Evidence Nouls keep items at p >= 0.35 (fail toward inclusion).
- Any failure falls back to the deterministic lexical baseline.
- Inputs are synthetic; no repository or private content is sent.

## Result (one run, 11 live calls, synthetic set)

| Decision | Jev (gated) | Lexical baseline |
| --- | --- | --- |
| Evidence selection, 4 relevant optional items | 1 omission (`login_e2e`, p=0.32), 0 extra | 2 omissions, 1 extra |
| Duplicate detection, 4 cases incl. ambiguous | 4/4 (ambiguous: conf 0.38 -> review) | 2/4 |
| Routing, 6 cases incl. ambiguous + protected | 5/6 (ambiguous routed `implementer` at conf 0.61) | 6/6 |
| Failures: unreachable, 1 ms timeout, 422, unknown model (400) | all fell back | n/a |

Tokens 4,742 in / 642 out; estimated $0.0002 at $0.042/Mtok input; median latency
262 ms, max 650 ms; run wall time 4.0 s. Preparation/integration overhead: about
one hour of agent time (discovery, doc reading, client, eval); not token-counted.

## Limitations

Tiny hand-labelled synthetic set, single run, thresholds not tuned; not evidence
for adoption. The ambiguous routing miss shows 0.5 confidence is too low a floor
for routing. Not wired into the controller or any runtime path.
