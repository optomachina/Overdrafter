# Hardware design graph (OVD-801, Jarvis slice 1)

Contract for turning a hardware request into artifacts. Slice 1 routes to a stub CAD agent only; it makes no worker calls.

## Flow

`DesignGraph.submit(request)` returns a `runId` at once and runs on the next microtask:

```
intake -> concept_picks -> domain_agent (cad | optics | electronics | analysis) -> verify -> result
```

- **intake** routes through `DomainAgentRegistry`. An explicit `request.domain` wins; otherwise the first agent whose `canHandle` matches is used (optics, electronics, analysis, then cad). If the routed agent is disabled, the graph emits one `error` (`agent_not_enabled`, "agent not enabled: optics") and the run ends. Nothing else runs.
- **concept_picks** asks only the key choices the agent declares through `conceptPicks()` and the request leaves open. Each `decision_requested` carries `options`, `recommended` and `bestGuess`.
- **domain_agent** calls `agent.run(ctx, emit)` once. If it throws, the graph emits one `error` (`agent_failed`) and the run ends. There is no retry, and any later emits are dropped.
- **verify** requires at least one artifact.
- **result** lists picks and artifact refs.

## Let it cook

`resolveDecision(runId, decisionId, { kind: "choose", choice } | { kind: "skip" })`. Skipping, or getting no answer within `decisionTimeoutMs` (default 5 min), records `decision_resolved` with `outcome: "skipped_best_guess"`, a `cause` (`skip` | `timeout`) and a rationale. The run then continues with the best guess. Time comes from an injectable `GraphClock`, so tests drive timeouts without waiting.

## Events

`events.ts` defines a discriminated union with these types: `status`, `decision_requested`, `decision_resolved`, `artifact` (`png` | `glb` | `step`), `result` and `error`. It also has a hand-written validator. Every event is validated before it is stored or delivered. An agent that emits a malformed event fails the run.

## Agents

| id          | slice 1                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| cad         | enabled: `StubCadAgent`, a 4-inch (101.6 mm) square plate, 6.35 mm thick, step/glb/png |
| optics      | registered, disabled stub                                                        |
| electronics | registered, disabled stub                                                        |
| analysis    | registered, disabled stub                                                        |

## Import boundary

Channel and UI code (`src/**`, `api/**`, `server/chatgpt/**`) may import only `server/design-graph` (`index.ts`). It may never import `worker/**` or graph internals. `import-boundary.ts` provides a pure scanner (`findBoundaryViolations`) plus a repo walk (`scanRepo`). `import-boundary.test.ts` runs it over the real repo and over a temporary fixture that violates the boundary. To print the report, run `npx tsx server/design-graph/import-boundary.ts` (needs `tsx`, which is not a repo dependency), or run the vitest file, which prints the same report.

## Tests

`npx vitest run server/design-graph --maxWorkers=2`. Test names G-1 through G-7 map to the OVD-801 acceptance list.
