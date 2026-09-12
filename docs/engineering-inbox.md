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

The conversation also observes up to 25 recent accepted changes through the
existing owner-scoped `engineering_tasks`/`engineering_decisions` read contracts.
Each change displays execution, verification and adoption separately. These are
server-recorded observations, not new native measurements; successful execution
never implies passing verification or adoption. No visible tasks does not mean
that interpretation is finished or all work is complete.

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
state. `conflict`, `access_unavailable` and server-side `invalid_request` preserve
the submission for caller handling. Transport failures, timeouts and unrecognized
or mismatched responses return `delivery_unknown`, also retaining the submission.
No failure response proves a previous attempt did not commit. Unknown delivery
must be retried with the same submission; changed context needs explicit
reconciliation, not an automatically refreshed snapshot or new idempotency key.

The adapter performs no automatic retries and exposes no raw server diagnostics.
The adapter itself does not persist pending messages across reloads, observe conversation state,
activate operators, interpret requests or dispatch native jobs. Those remain
separate integration work. Mocked transport tests run with:

```sh
npx vitest run src/features/engineering/engineering-inbox-client.test.ts
npx vitest run src/pages/EngineeringInbox.test.tsx
npx vitest run src/features/engineering/EngineeringTaskStatus.test.tsx
PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test e2e/engineering-inbox.spec.ts
```

The browser test uses synthetic session fixtures and intercepted local HTTP
responses. It records desktop/mobile interaction evidence for retry and explicit
reconciliation, not live authentication/RLS or native-execution qualification.
This source-only connection adds no migration; reverting it removes the screen
without changing durable conversation history.

## Local verification

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
