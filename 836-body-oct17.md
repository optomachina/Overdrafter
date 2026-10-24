OVD-804. First of four PRs split from #834 (head 969dc15e). This one is the event transport, with no gate change and no dependencies. It goes straight onto main.

## What
- `src/features/jarvis/thread/client.ts`: the `ThreadClient` interface (resolve decision, pause/cancel control). The shell bridges it to `DesignGraph.control` with the server-derived actor.
- `src/features/jarvis/thread/event-source.ts`: `createEventSource` over an owner-scoped `ConversationTransport`. It deduplicates by `runId:seq`, polls while realtime is down or the tab is hidden, and backs off from 5 s to 60 s while offline.
- `src/features/jarvis/thread/supabase-source.ts`: a private `jarvis:conversation:<id>` broadcast channel through a structural client type, so the core never imports the Supabase SDK.
- Tests: `event-source.test.ts`, `supabase-source.test.ts`.

Included review fix from 969dc15e: **catch-up poll after subscribe or reconnect.** When realtime comes back up it triggers an immediate poll, queued if a poll is in flight, so events broadcast during the gap are not lost.

Imports stay inside `src/features/jarvis/` (only `../core/types`), so the current import-boundary gate passes unchanged.

## Split
1. **This PR**: event transport (off main)
2. #837: gate-only PR, Blaine's single card (off main)
3. #838: thread UI and dev route (stacked on #837)
4. #839: 3D viewer (stacked on #838)

## Proof
`npm run preflight` passes lint and typecheck locally at the head sha. Tests: everything passes except 3 docker-only cases in `scripts/qualify-ovd417-four-migration-suffix.test.mjs`. Those fail the same way on unmodified main 947b32a1 because the box has no docker.

