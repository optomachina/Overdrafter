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
is a conflict. New sends with an obsolete revision or head also conflict.
The client must refresh and ask for explicit reconciliation where needed;
it must not silently change a pending request's snapshot or mint another key
merely because delivery was uncertain.

| SQLSTATE | Client meaning |
| --- | --- |
| `42501` | Access or exact scoped context unavailable. |
| `22023` | Invalid identity, revision or text input. |
| `40001` | Changed context or reuse of an idempotency key for another payload. |

Future assistant writes and head advances must take the same conversation
lock, maintain monotonic revisions and reserve a unique message sequence.
No such writer is implemented here. The interpretation dispatcher, accepted
native queue/capacity limits, worker leases, artifact uploads, AI budgets and
connected UI are separate slices. No claim about browser acknowledgement
latency or completed cross-device operation follows from the SQL tests.

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
disposable container and reports their IDs. An optional second argument writes
the JSON evidence report. Repeated runs use fresh identities.

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
