# Private engineering conversation intake

OVD-496 implements the durable intake portion of the approved automatic
request-to-result milestone. It is additive to the existing quoting application
and is disabled by an empty server-managed operator allowlist. Applying the
migration alone enables no user, AI call, scheduler or native worker.

## Stored state and access

- `engineering_private.engineering_operators` admits a specific user and
  organization. The user must also retain current organization membership and
  existing project access. No client can read or change this allowlist.
- `engineering_snapshots` stores the exact context text and a database-generated
  SHA-256. Its identity must match its project/organization and v2 context
  envelope. Snapshot insertion is server-only. The complete v2 contract and
  provenance must be validated by the future coordinator before execution;
  a stored snapshot is not native verification evidence.
- `engineering_conversations` owns the baseline, current head and revision.
  Conversation/message/request reads are private to the conversation owner,
  even when another admitted user can access the same project. Snapshots are
  readable by admitted project users.
- `engineering_messages` preserves user, assistant and system history. User
  messages bind the authenticated author; automated messages have no user
  author. Clients cannot insert, update or delete rows directly.
- `engineering_requests` binds one user message to its exact input snapshot
  and original receipt. Its queued interpretation state does not imply an
  accepted CAD decision, successful execution, verification or adoption.

All tables use RLS, explicit grants and composite foreign keys. Authorization
uses current database membership rather than editable token metadata. The new
helper schema does not grant access to the pre-existing `private` schema.
The service role has bounded table grants for future server coordination; it
is never a browser or Windows companion credential.

## Intake API

Authenticated callers use `api_submit_engineering_message` with:

| Argument | Meaning |
| --- | --- |
| `p_organization_id`, `p_project_id` | Current allowed scope. |
| `p_conversation_id` | Client-generated UUID, retained on retries. |
| `p_input_snapshot_id` | Exact current conversation head; baseline on creation. |
| `p_expected_revision` | Zero for creation; last observed revision thereafter. |
| `p_idempotency_key` | Client-generated UUID identifying this exact Send. |
| `p_body` | Original text, 1–4,000 characters and at most 8,000 bytes, with non-whitespace content. |

In one transaction, intake checks access, locks the conversation (including
initial creation), rechecks access after any wait, checks scope/ownership and
revision, inserts the message and queued interpretation request, then advances
the conversation revision. A receipt contains `conversationId`, `messageId`,
`requestId`, `revision` and `inputSnapshotId`. Intake performs no external work.

Identical retries return the original receipt, including after subsequent
sends. Reusing a key with different text, input snapshot or expected revision
is a conflict. New sends with an obsolete revision or head also conflict. These application conflicts use `PT409`, distinct from retryable PostgreSQL serialization failures (`40001`), following the [PostgREST custom status contract](https://docs.postgrest.org/en/stable/references/errors.html#raise-errors-with-http-status-codes).
The client must refresh and ask for explicit reconciliation where needed;
it must not silently change a pending request's snapshot or mint another key
merely because delivery was uncertain.

| SQLSTATE | Client meaning |
| --- | --- |
| `42501` | Access or exact scoped context unavailable. |
| `22023` | Invalid identity, revision or text input. |
| `PT409` (HTTP 409) | Changed context or reuse of an idempotency key for another payload. |

Future assistant writes and head advances must take the same conversation
lock, maintain monotonic revisions and reserve a unique message sequence.
No such writer is implemented here. The interpretation dispatcher, accepted
native queue/capacity limits, worker leases, artifact uploads, AI budgets and
connected UI are separate slices. No claim about browser acknowledgement
latency or completed cross-device operation follows from the SQL tests.

## Browser intake adapter

`src/features/engineering/engineering-inbox-client.ts` provides the browser
transport for this existing RPC using the application's session-aware Supabase
client. It accepts no actor identity or privileged credential; the server still
enforces operator admission, membership, project access and conversation ownership.
The development-only `/engineering?conversation=<uuid>` screen connects this
adapter to the existing bottom composer. Like the local handoff workbench, it
requires development mode, `VITE_ENABLE_ENGINEERING_WORKBENCH=1` and a loopback
host. The route is excluded from production builds. These browser gates do not
replace server authorization or enable any operator.

The screen requires a signed-in session and an already provisioned conversation.
It reads the owner's conversation scope/head/revision and up to 100 recent
messages through existing RLS-protected tables. A confirmed receipt triggers a
fresh context read; its historical revision never becomes the current head.
Unknown delivery, invalid receipts and access errors retain the exact request
for explicit retry. A conflict requires reading and reviewing the latest
conversation, selecting “Use updated context”, and a separate Send with a new
identity. Neither refresh nor context selection resubmits anything. Account or
conversation changes unmount private display and pending state.

This increment does not create conversations or provision baseline snapshots.
Recorded messages reload from the server, but drafts and unresolved submissions
remain in memory: keep the tab open until delivery resolves. Live native
qualification, automatic CAD geometry and production activation remain separate work.
The existing `/dev/engineering` manual-handoff flow is unchanged.

In the standard development presentation, screens below 768px reserve space
below the centered engineering composer while the Agentation toolbar is present.
The default annotation launcher no longer covers Send, including with an expanded
text field. Annotation focus, activation, Escape dismissal and position controls
remain available. Desktop and toolbar-free layouts retain their prior spacing.
Browser qualification uses the normal toolbar, not embedded mode or forced clicks.
The app-owned `AnnotationToolbar` wrapper supplies keyboard activation for the
focused non-native annotation launcher: Enter activates on press and Space on
release, with Space scrolling prevented. Repeats, focus loss and unmount cannot
create duplicate activation. Native controls, text entry, modified shortcuts and
composition are left to their existing handlers. The bridge uses the public
`className` hook and React portal event bubbling; development/embedded gating is
unchanged. No annotation endpoint or remote service is enabled.

Conversation refreshes use `engineering-conversation-reader.ts`: one ten-second
deadline covers both context and history reads. Only validated, matching
owner/organization/project/conversation rows are returned together; malformed,
duplicate or unordered history is unavailable. Late responses after timeout
cannot publish history or start a subsequent read. These sequential reads are
not an atomic snapshot; Send still checks its pinned revision at the server.
If a write was recorded but its follow-up read stalls, the page keeps the
recorded confirmation, blocks new Send until context reloads, and unlocks
explicit Refresh. Refresh never repeats the write or replaces an unresolved
request's retry identity. Unresolved drafts still have the tab-only limitation.

The conversation also observes up to 25 recent accepted changes through the
existing owner-scoped `engineering_tasks`/`engineering_decisions` read contracts.
Each change displays execution, verification and adoption separately. These are
server-recorded observations, not new native measurements; successful execution
never implies passing verification or adoption. No visible tasks does not mean
that interpretation is finished or all work is complete.

Each accepted change also shows **Current attempt**, following the explicit
`engineering_task_execution.current_attempt_id` through its named composite
foreign key to `engineering_execution_attempts`. It never chooses an attempt by
timestamp. The same scoped read selects only linked identities and phase, with
zero or one execution row and an object-or-null current attempt. Both linked
records must match the task, conversation, organization, project and owner; the
attempt must match the current pointer exactly. Missing fields, ambiguous rows,
unknown phases and mismatched or missing pointed attempts make the observation
unavailable. An absent execution row, or an explicit null pointer with a null
attempt, displays “No current attempt recorded.”

The phase labels are Claimed, Active, Awaiting results, Attempt failed and
Recovery required. Awaiting results means result verification is pending.
Recovery required means execution needs reconciliation; it does not prove the
process stopped or request a retry. Phase never changes the independently
observed execution, verification or adoption labels. This read does not deliver
CAD geometry, measurements, artifacts or release authority.

Status reads run five seconds after the previous read finishes, with one request
in flight and a ten-second deadline. Hidden tabs pause and cancel reads; visible
tabs resume, and unmount/account/context changes dispose of the old reader.
Failed refreshes label retained observations as historical with their last-check
time. Explicit access denial clears observations, and unknown or contradictory
state is unavailable rather than a successful result. The reader never changes
the composer, request identity, selected context or conversation revision, and
cannot dispatch or retry work. Conversation messages still refresh separately.

Call `prepareEngineeringMessage` once per Send with caller-selected identities,
the observed revision and original text. Keep that immutable submission for any
explicit retry. Local validation requires canonical lowercase nonnil UUIDs,
a safe nonnegative revision below `Number.MAX_SAFE_INTEGER`, and the text limits
above, counted as Unicode code points and UTF-8 bytes. NUL and unpaired surrogates
are rejected. Text is never trimmed, truncated or otherwise rewritten.

`submitEngineeringMessage` makes one attempt, aborting after ten seconds even
if the transport does not settle. It returns `recorded` only for an exact receipt
matching the submitted conversation, snapshot and next revision. That receipt
describes this historical Send, not the latest conversation head or execution
state. `conflict` and `access_unavailable` preserve the pinned submission for
caller handling. The inbox handles a server-side `invalid_request` by clearing
the pinned submission but keeping its draft editable so the caller can create a
corrected request. Transport failures, timeouts and unrecognized or mismatched
responses return
`delivery_unknown`, retaining the submission. No failure response proves a
previous attempt did not commit. Unknown delivery must be retried with the same
submission; changed context needs explicit reconciliation, not an automatically
refreshed snapshot or new idempotency key.

The adapter performs no automatic retries and exposes no raw server diagnostics.
The adapter itself does not persist pending messages across reloads, observe conversation state,
activate operators, interpret requests or dispatch native jobs. Those remain
separate integration work. Mocked transport tests run with:

```sh
npx vitest run src/features/engineering/engineering-inbox-client.test.ts
npx vitest run src/pages/EngineeringInbox.test.tsx
npx vitest run src/features/engineering/EngineeringTaskStatus.test.tsx
npx vitest run src/features/engineering/engineering-conversation-reader.test.ts
PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test e2e/engineering-inbox.spec.ts
```

The browser test uses synthetic session fixtures and intercepted local HTTP
responses. It records desktop/mobile interaction evidence for retry and explicit
reconciliation, not live authentication/RLS or native-execution qualification.
This source-only connection adds no migration; reverting it removes the screen
without changing durable conversation history.

## Local verification

### Maintained fixture planning contract

`scripts/engineering-inbox-fixture-plan.mjs` is the plan-only first slice of the
maintained local fixture runner. It validates a bounded JSON plan on standard
input with `--plan` and returns a deeply immutable, value-free policy description.
The plan records exact source, owner, run, cached-image and declared migration
identities, but syntax validation does not prove that a run ID is fresh, a source
checkout or image exists, migration bytes match, or any runtime behavior works.

This slice performs no command, Docker, filesystem mutation, migration, secret,
HTTP, application or cleanup operation. `--execute` fails with
`execution_unavailable_in_plan_slice`; a successful plan is never qualification
evidence. Its future-stage policy requires proved cleanup before a final success
receipt. Executable lifecycle, bootstrap/suite composition, HTTP evidence and a
fresh synthetic qualification remain separate reviewed units. They must not
reconstruct or rerun a completed disposable fixture.

`scripts/engineering-inbox-fixture-lifecycle.mjs` is the next source-only layer.
It models inventory, creation, exact-ID ownership and reverse cleanup through a
closed injected adapter, but supplies no real adapter. Only a created resource
whose exact 64-hex ID and full identity inspect match are cleanup-authoritative.
Ambiguous creation or a failed post-create inspect remains possible untracked
residue: the lifecycle never guesses an ID or calls removal for it, and cannot
report cleanup complete. Drift before removal also fails closed while cleanup of
other proven-owned resources continues.

Lifecycle deadlines and aborts are deterministic state-machine simulations, not
real process cancellation or timing evidence. Original operation failure and
cleanup failures remain separate, retry is unavailable, and a provisional result
cannot become success. A final success receipt follows cleanup and requires every
proven-owned resource to be absent. Migration/bootstrap, the existing inbox
suite, HTTP behavior and any real resource qualification remain later units.

Apply the complete migration chain to an isolated disposable local Supabase
project with project ID `ovd496-engineering-inbox`, then run:

```sh
npm run test:engineering-inbox -- supabase_db_ovd496-engineering-inbox
npm run verify
```

The test runner accepts only an explicitly named local `supabase_db_ovd496-*`
container and never connects to a hosted database. The SQL suite rolls back
its fixtures. The multi-session test retains synthetic fixture rows in that
disposable container and reports their IDs. Reports are emitted only to standard
output; extra arguments are rejected before contacting Docker. The runner
cannot overwrite a caller-selected report path. Repeated runs use fresh identities.

Evidence covers 34 pgTAP assertions for default-off admission, current access,
owner privacy, exact replay, stale context, validation, direct-write denial,
immutable history and cross-organization references. Independent database
sessions test five duplicate sends, competing different sends, and revocation
while intake waits for the conversation lock. The latter must deny the waiting
send without changing conversation history.

Generated public types come from the replayed local migration head using the
existing `scripts/generate-supabase-types.mjs`; they describe database shape,
not client write permission. Regeneration also includes the existing platform
notification RPC that was absent from the previously committed types.

The repository's PostgreSQL contract-literal exceptions are recorded for the
CLI scanner in `sonar-project.properties`. Sonar automatic analysis does not
apply that rule-filter setting from repository properties. For PR #484, the
15 `plsql:S1192` findings were individually scoped to the two SQL files and
dispositioned in Sonar as analyzer mismatches, with the reason preserved on
each finding. The separate report-path security finding was fixed in code;
its stale GitHub SARIF alert was reconciled only after Sonar marked it Fixed.
No security rule was disabled. See [Sonar automatic-analysis configuration](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis)
for the supported properties.

## Migration and rollback

`20260910045917_engineering_durable_inbox.sql` adds four public tables, the
isolated helper schema/allowlist, functions, policies, triggers and a composite
unique index on existing projects. It makes no quote-path behavior change and
inserts no operator, snapshot or business row. Local replay is evidence of
schema compatibility, not authority to apply a pending production migration
batch. Production activation remains separately reviewed and authorized.

Rollback stops admission by disabling operators or revoking authenticated
execution on both intake functions. Keep all engineering tables and evidence;
do not drop the schema to roll back application behavior. History triggers
prevent ordinary updates/deletes of snapshots/messages and identity changes
on conversations/requests, including privileged service writes. Foreign keys
deliberately prevent deleting a project or user while engineering history
references it. Any future retention/erasure workflow requires a separately
reviewed change that accounts for this history, rather than cascading through
engineering records. Superuser administration is outside these grants and
triggers' trust boundary.
