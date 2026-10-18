# Jarvis channels: adapters and the conversation service

OVD-798, part of the OVD-795 Jarvis UI front door. The code lives in
`src/features/jarvis/`. It is behind the server-side flag `JARVIS_UI_ENABLED`, which is off by
default, and nothing in the app imports it yet.

## Shape

`ChannelAdapter -> ConversationService -> DesignGraph`. Graph events come back through
`ConversationService.handleGraphEvent` and fan out to the web thread (always) and to the run's
originating channel.

- `core/types.ts`: the `ChannelAdapter`, `GraphEvent` and `DesignGraph` contracts. The graph types
  mirror the OVD-801 graph (`server/design-graph/events.ts`, `graph.ts`) field for field: every
  event carries `(runId, seq)`, decision options are strings, and `result` and `error` events are
  rendered. The core cannot import server code, so the mirror is pinned by a contract test.
- `server/jarvis/design-graph-port.ts`: adapts the OVD-801 `DesignGraph` (sync `submit`,
  three-argument `resolveDecision`, no control surface) to the core's async port. It dedupes
  `submit` on the idempotency key, reads agent availability from the graph's own registry (no second
  enabled list in the core), and reports `control` as `unsupported` until OVD-801 adds one.
  `design-graph-port.test.ts` asserts type equality with OVD-801 (it fails `npm run typecheck` on
  drift) and drives a real graph run through the service.
- `core/repo.ts`: the `JarvisRepo` port. Its row shapes mirror the OVD-797 draft tables
  (`access_grants`, `channel_settings`, `conversations`, `channel_identities`, `link_codes`,
  `messages`, `decisions`, `control_commands`, `inbound_events`, `outbound_deliveries`).
  `core/in-memory-repo.ts` is the only implementation until OVD-797 is approved. The Supabase
  implementation swaps in later with no core change.
- `core/conversation-service.ts`: the shared pipeline.
- `core/render.ts`: renders by capability. A channel without buttons or 3D gets text plus a web link.
- `core/delivery.ts`: one delivery per `(message_id, channel)`, exponential backoff, marked
  `failed` after N attempts.
- `channels/`: adapter modules plus the registry list (`channels/index.ts`).

## Pipeline order (fixed and tested)

`flag -> channel enabled -> adapter.verifyInbound -> idempotency claim -> identity resolve (linked,
not revoked) -> tier >= channel.min_tier -> rate limit -> append to conversation ->
DesignGraph.submit | resolveDecision | control`.

Up to the append, the only write is the idempotency claim. A throttled request releases its claim
so the retry works.

### Failure and retry

- Any throw after the claim releases it and rethrows. The webhook handler answers non-2xx, and the
  channel's retry is processed instead of being dropped as a duplicate.
- Every write after the claim is idempotent per event. The inbound message is insert-or-get on
  `in:<channel>:<event id>`. A retry reuses a run already attached to that row, and the graph port
  dedupes `submit` on the same key.
- A retry of an event whose first attempt was already admitted (its inbound row exists) does not
  take another rate-limit token.
- Decisions are pending -> promote. `claimDecision` marks the row pending for one inbound event, and
  the resolution is committed only after `graph.resolveDecision` accepts it. A throw or a graph
  refusal releases the claim. Another event gets `decision_in_progress` while it is pending.
  A claim older than `decisionClaimTtlMs` (default 60 s, measured on the injected `now` clock) can
  be taken over, so an attempt that crashed between the claim and the graph call cannot wedge the
  decision. The promoted row records the event that resolved it (`resolvedKey`). If the graph
  accepted the answer but a later write failed, the retry treats the graph's `unknown_decision`
  (its claim is still held) or the already-resolved row (`resolvedKey` is its own key) as success
  rather than refusing it.
- Control commands are stored `pending`, re-sent while still `pending` on a retry of the same event,
  and promoted to `queued` (or `rejected`) on the graph's answer.
- Graph events are deduped on `(runId, seq)`: the outbound message row is insert-or-get on
  `out:<runId>:<seq>`, and each `(message, channel)` delivery is claimed once. A replayed event, or
  a retry after a partial fan-out, never sends a channel the same message twice.
- The run-to-conversation link is written right after `submit` returns, but the graph may emit
  first: OVD-801 starts the run on the next microtask and fails fast (`no_agent`) without awaiting
  anything. In one process, `handleGraphEvent` holds an event for an unlinked run until every
  in-flight submit has linked its run and sent its acknowledgement, then handles it. Events for one
  run are handled in the order they were handed over.
- A skipped decision records the best guess with a rationale. The graph's own `decision_resolved`
  event then stores its authoritative rationale, and fills timeouts, which never pass through the
  core.

### Graph event contract

`handleGraphEvent(event)` resolves to `{ status: "handled" }` once the event is stored and fanned
out, or `{ status: "unknown_run" }` when no conversation is linked to `event.runId` after in-flight
submits settle. `unknown_run` stores and sends nothing. The relay must keep the event and retry it
with backoff (the link commits moments after `submit`, or on the channel's retry if that write
failed), and it may give up after a bounded time. Replays are always safe, so retrying a whole run's
log is fine. A thrown error is also retryable. The graph may call `handleGraphEvent` without
awaiting it, but must not await it from inside `submit`.

### Replies to the sender

`reply` on a `denied`, `throttled`, `unavailable`, `refused` or `linked` result is returned in the
synchronous webhook response (Slack response body, Telegram webhook reply, web JSON). It is never
sent through `send()`. An unlinked sender has no stored address, so this is the only way to reach
them. A replay of the same event returns `duplicate` with no reply, so the user gets exactly one.

### Identity linking

A link code typed in a channel arrives as an inbound message with `linkCode`. It goes through
`flag -> channel enabled -> verify -> claim` like every other message, then a failed-attempt limit
per channel + external-id hash (5 per 15 minutes), and only then consumes the code. A blocked
sender never reaches the code table. The linked identity stores the verified sender's external-id
hash (lookup only) and the adapter's opaque `address`, which `send()` gets back in
`UserRef.address`. Denials return a generic reply. The log carries a reason code only, never an
external id. External ids and link codes are stored only as keyed hashes (`deps.hash`).

Identity resolution lives in the core rather than in each adapter, which is a deliberate
tightening of the OVD-795 sketch: every channel then shares the hashed lookup and the revoked
check. An adapter only reports the `externalUserId` it saw.

## Flag

`JARVIS_UI_FLAG = "JARVIS_UI_ENABLED"` in `jarvis-ui-flag.ts`. Only the exact string `true`
enables it, matching the billing flags. When it is off, no real adapter routes inbound or outbound
traffic. Adapters marked `testOnly` (the `TestAdapter`) route only when `testEnvironment` is true,
whatever the flag says.

## Add a channel = one adapter module + one registry line

1. Add `src/features/jarvis/channels/<channel>-adapter.ts`, implementing `ChannelAdapter`:
   - `id` and `capabilities` (`buttons`, `images`, `model3d`, `maxText`);
   - `verifyInbound(request)`: signature, secret or session check, in constant time;
   - `normalizeInbound(request)`: map to `InboundMessage`, with `idempotencyKey` taken from the
     channel's event id (Slack `event_id`, Telegram `update_id`, bridge guid, web client UUID),
     `address` set to the opaque value `send` needs to reach this sender (Telegram `chat_id`, Slack
     DM channel id, which the adapter may encrypt), and `linkCode` set for a link command;
   - `send(userRef, rendered, deliveryKey)`: deliver the already-rendered message to
     `userRef.address`, using `deliveryKey` to dedupe on the channel side when the API supports it.
   - The webhook handler returns `InboundResult.reply` in its synchronous response, and answers
     non-2xx when `handleInbound` throws, so the channel retries.
2. Add one line to `channelAdapterFactories` in `src/features/jarvis/channels/index.ts`.

Do not edit anything in `core/`. CS-9 proves a second adapter routes with only a registry entry,
and that no core source names a specific channel other than `web`. To turn the channel on, also
set its `channel_settings` row (`enabled`, `min_tier`), an admin action that requires AAL2.

## Boundary

`src/features/jarvis/import-boundary.test.ts` fails if any non-test source under
`src/features/jarvis/**` imports a worker or queue module, or anything outside the feature. Work
reaches workers only through `DesignGraph`.

Exactly two package allowances exist (OVD-804). `react` is allowed only for files under
`src/features/jarvis/thread/`, and `@google/model-viewer` only for the single file
`src/features/jarvis/thread/model-loader.ts`. Each applies only when the raw import specifier
equals the package name, so a relative or `@/` spelling that resolves to the same string never
qualifies. Everything else stays a violation, including `react-dom`, `react/jsx-runtime`, any
other package, and every server, worker and queue import.

## Tests

`src/features/jarvis/core/conversation-service.test.ts` covers CS-1..CS-14 from the OVD-798
architect review, plus the review-fix cases (M1 failure and retry, CS-8b graph-event replay, CS-3c
synchronous replies, M3 address, M4 linking). `server/jarvis/design-graph-port.test.ts` is the
OVD-801 contract test.

```bash
npx vitest run src/features/jarvis server/jarvis --maxWorkers=2
npx vitest run src/features/jarvis --maxWorkers=2 --coverage --coverage.include='src/features/jarvis/core/**'
```

## Schema deltas for OVD-797

The in-memory repo assumes these, and the OVD-797 draft needs them before the Supabase repo lands:
`messages.dedupe_key` (UNIQUE, nullable), `channel_identities.address` (encrypted at rest),
`decisions.pending_key`, `decisions.pending_at`, `decisions.resolved_key`, and a `pending` value for `control_commands.status`.

## Not in this change

The Supabase `JarvisRepo` (after OVD-797 is approved), the production relay that forwards OVD-801
events to `handleGraphEvent` in order and retries `unknown_run` (replays are safe), real
channel adapters (OVD-803 web, OVD-807 Slack, OVD-808 Telegram, OVD-809 iMessage), link-code
issuance from an AAL2 session (OVD-806), resume and steer (OVD-812), and the per-user cap of 3
concurrent graph runs, which needs run-completion events from OVD-801.
