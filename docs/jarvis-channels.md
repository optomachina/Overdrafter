# Jarvis channels: adapters and the conversation service

OVD-798, part of the OVD-795 Jarvis UI front door. The code lives in
`src/features/jarvis/`. It is behind the server-side flag `JARVIS_UI_ENABLED`, which is off by
default, and nothing in the app imports it yet.

## Shape

`ChannelAdapter -> ConversationService -> DesignGraph`. Graph events come back through
`ConversationService.handleGraphEvent` and fan out to the web thread (always) and to the run's
originating channel.

- `core/types.ts`: the `ChannelAdapter`, `GraphEvent` and `DesignGraph` contracts. OVD-801 supplies
  the real `DesignGraph`; the core depends only on the interface.
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
so the retry works. Denials return a generic reply. The log carries a reason code only, never an
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
     channel's event id (Slack `event_id`, Telegram `update_id`, bridge guid, web client UUID);
   - `send(userRef, rendered, deliveryKey)`: deliver the already-rendered message, using
     `deliveryKey` to dedupe on the channel side when the API supports it.
2. Add one line to `channelAdapterFactories` in `src/features/jarvis/channels/index.ts`.

Do not edit anything in `core/`. CS-9 proves a second adapter routes with only a registry entry,
and that no core source names a specific channel other than `web`. To turn the channel on, also
set its `channel_settings` row (`enabled`, `min_tier`), an admin action that requires AAL2.

## Boundary

`src/features/jarvis/import-boundary.test.ts` fails if any non-test source under
`src/features/jarvis/**` imports a worker or queue module, or anything outside the feature. Work
reaches workers only through `DesignGraph`.

## Tests

`src/features/jarvis/core/conversation-service.test.ts` covers CS-1..CS-14 from the OVD-798
architect review.

```bash
npx vitest run src/features/jarvis --maxWorkers=2
npx vitest run src/features/jarvis --maxWorkers=2 --coverage --coverage.include='src/features/jarvis/core/**'
```

## Not in this change

The Supabase `JarvisRepo` (after OVD-797 is approved), the real `DesignGraph` (OVD-801), real
channel adapters (OVD-803 web, OVD-807 Slack, OVD-808 Telegram, OVD-809 iMessage), link-code
issuance from an AAL2 session (OVD-806), resume and steer (OVD-812), and the per-user cap of 3
concurrent graph runs, which needs run-completion events from OVD-801.
