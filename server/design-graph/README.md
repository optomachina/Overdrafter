# Hardware design graph (OVD-801, Jarvis slice 1)

Contract for turning a hardware request into artifacts. Slice 1 routes to a stub CAD agent only; it makes no worker calls.

## Flow

`DesignGraph.submit(request, { ownerId })` returns a `runId` at once and runs on the next microtask. The owner is recorded on the run and used by `control()`:

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

`events.ts` defines a discriminated union with these types: `status`, `decision_requested`, `decision_resolved`, `artifact` (`png` | `glb` | `step`), `result`, `error`, and the control events `control_requested`, `control_applied` and `control_rejected`. It also has a hand-written validator. Every event is validated before it is stored or delivered. An agent that emits a malformed event fails the run.

## Control (OVD-810)

`DesignGraph.control(runId, { kind, payload?, idempotencyKey }, actor)` with `actor = { userId, isAdmin, aal: "aal1" | "aal2" }`. The code lives in `control/`; it uses an in-memory store and makes no DB writes.

- **Kinds.** Slice 1 applies `pause` and `cancel`. `resume` and `steer` return `{ status: 501, outcome: "not_yet" }`. They change no state, queue nothing, record no key and emit no event. OVD-812 enables them.
- **Authorization.** Only the run owner (recorded at submit, never read from the request) or an admin at AAL2 may act. Anyone else gets `{ status: 403, outcome: "forbidden" }`. A denial changes no state, emits no event and does not consume the idempotency key. A run submitted without an owner can be controlled only by an admin at AAL2.
- **Idempotency.** Commands are unique on `(runId, idempotencyKey)` (`ControlCommandStore`, default `InMemoryControlCommandStore`). A repeat, including a concurrent one, returns the original response and has no further effect. Reusing a key for a different kind returns `409 idempotency_conflict`. The checks run in this order: unknown run (404), malformed (400), authorization (403), not yet (501), idempotency.
- **Safe checkpoints.** An accepted command emits `control_requested`, moves the run to `pausing` or `cancelling`, and is queued. Queued commands apply only at a checkpoint: a node boundary, an agent's `await ctx.checkpoint()`, or while the run waits on a decision (cancel only). They never apply in the middle of a STEP/GLB write, because a write is the code between two checkpoints. Agents call `ctx.checkpoint()` between artifacts; `StubCadAgent` does. An agent that never calls it is stopped at the next node boundary.
- **State machine.** `running -> pausing -> paused`; `running | pausing | paused -> cancelling -> cancelled`. A paused run blocks at its checkpoint and makes no progress. In slice 1 the only way out is cancel, which applies at once because the run is already at a checkpoint.
- **Outcomes.** Each accepted command ends in exactly one `control_applied` or `control_rejected`. Pause applies as `control_applied { state: "paused" }`. Cancel applies as `control_applied { state: "cancelled", kept: [...] }`, where `kept` lists the artifacts already published. They stay available through `getRun().artifacts`. The worker claim (`getRun().claim`) is released, `ctx.checkpoint()` throws `RunCancelledError`, and no further artifact is published. Rejection reasons are `terminal` (the run is completed, cancelled or failed; this is a no-op), `duplicate` (the same kind is already pending or applied under another key), `cancel_pending` (pause sent after cancel) and `superseded` (a queued pause overtaken by cancel). If a run fails with commands still queued, each is rejected as `terminal`.

The C-proof test prints the event log of a 4-inch plate run that is paused and then cancelled: `npx vitest run server/design-graph/control/plate-pause-cancel.test.ts`.

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

`npx vitest run server/design-graph --maxWorkers=2`. Test names G-1 through G-7 map to the OVD-801 acceptance list. C-1 through C-7 in `control/` map to the OVD-810 list; `validateStepText` (`control/step-validator.ts`) is the structural ISO-10303-21 check used by C-6.
