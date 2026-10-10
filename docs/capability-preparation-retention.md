# Capability preparation retention

OVD-591 adds immutable pre-dispatch inputs to the existing capability runtime.
This is source implementation only. Migration execution, access-control behavior,
concurrency and durable recovery require separately authorized database evidence.
Preparing or discovering an input never grants dispatch authority.

## Records and service contract

Three private records retain the original sanitized JSONB input:

- Claim: `{request, completionKey}`, keyed by `request.requestKey`, with a globally
  unique reserved `completionKey`. Multiple requests may associate with one
  `windowKey`; the existing canonical claim determines the actual owner.
- Completion: the complete canonical completion input, keyed by `completionKey`.
  A new row must match the retained claim and the actual canonical window's full
  claim input, request owner and fence. Candidate scope and observation window
  must match. `resourceReleased` remains a service attestation, not database proof
  that a browser or profile has been disposed.
- Attention: the complete canonical attention commit input, keyed by
  `evaluationKey`. Multiple evaluations at the same scope/version are permitted.
  Static projection validation binds its scope hash to ordered metadata. No
  current ledger head, lease clock, version or transition is changed or reserved.

Preparation returns `{state: "created" | "existing", retained: originalInput}`.
Only the first insert returns `created`. JSONB semantic equality permits reordered
object keys; array order, strings, timestamps, nulls and typed values remain
significant. Changed reuse fails atomically. A previously retained exact payload
is returned before new cross-record checks, so canonical expiry or CAS progress
cannot invalidate its retention acknowledgment. The canonical completion and
attention RPCs still enforce expiry, source-head, CAS and replay rules.

The eight service-only RPCs are:

| Operation | RPC | Arguments |
| --- | --- | --- |
| Prepare claim | `api_prepare_capability_claim` | `p_input jsonb` |
| Read claim | `api_read_prepared_capability_claim` | `p_request_key text` |
| Discover claims | `api_list_prepared_capability_claims` | `p_window_key text, p_after_cursor text, p_limit integer` |
| Prepare completion | `api_prepare_capability_completion` | `p_input jsonb` |
| Read completion | `api_read_prepared_capability_completion` | `p_completion_key text` |
| Prepare attention | `api_prepare_capability_attention` | `p_input jsonb` |
| Read attention | `api_read_prepared_capability_attention` | `p_evaluation_key text` |
| Discover attention | `api_list_prepared_capability_attention` | `p_scope_key text, p_after_cursor text, p_limit integer` |

Direct reads return the original input or null. UUID strings must be canonical
lowercase. Invalid arguments and conflicts expose fixed bounded error messages;
SQLSTATE is retained for classification. No private table or validator is exposed
as a service API. Existing runtime RPC signatures remain unchanged.

## Discovery and publication order

Claims and attention use one private logged bigint sequence with `CACHE 1` and
`NO CYCLE`. All three preparation writers acquire the existing transaction-level
advisory lock `(591, 1)` before lookup, allocation and insert, holding it until
commit/rollback. There are no preallocated cursor blocks. A later committed row
cannot pass an earlier uncommitted allocation; rollback and cross-scope/kind gaps
are permitted. Callers must never reset or directly reserve sequence values.

Pages filter one exact window or scope and numerically order cursors after the
supplied lower bound. A cursor is a decimal string from `1` through
`9223372036854775807`; null starts discovery. Limit is an integer from 1 through
100. A single materialized query reads at most limit + 1 rows to determine
`hasMore`, returning at most limit entries shaped as `{cursor, input}`.
`nextCursor` is the last delivered cursor, even on a nonempty terminal page. An
empty page is exactly `{entries: [], nextCursor: null, hasMore: false}`. The
lookahead cursor and global sequence state are never continuation tokens.

History discovery is bounded reading, not a work queue, acknowledgment, cleanup,
replay or dispatch operation. Callers stop the current scan when `hasMore` is
false and may begin a later recovery scan from null. A recovery owner must not
mark unresolved history reconciled merely because its page was read. Existing
or read claim preparations never restore probe authority. Only an uninterrupted
fresh `created` acknowledgment followed by a fresh canonical `claimed` receipt
can authorize the original single probe under the current admission gates.
Separately controlled completion/attention replay must use the retained exact
key, payload, fence, timestamps and expected version.

## Bounds, access and rollback

Inputs are limited to 16,384 bytes of the database JSONB text representation,
with bounded keys, depth, arrays and sanitized canonical fields. This database
bound can be stricter than compact client JSON because JSONB adds whitespace.
Pages are capped at 2,000,000 bytes. Validators do not call runtime mutation RPCs.
Static validation does not imply provider metadata has been reviewed; the
provider still owns its explicit reviewed metadata/admission allowlist.

The three tables are postgres-owned with enabled and forced RLS, no policies and
no PUBLIC, anon, authenticated or service-role direct privileges. The sequence
and all private functions also deny those direct privileges. Public wrappers
use the established postgres executor, fixed `search_path = pg_catalog`, and
only service-role execution grants. No roles, memberships, credentials or auth
configuration are created or changed.

Operational rollback means disabling the consumers and revoking execution on
these eight new public RPCs, retaining immutable history. It must not drop the
records, reset the sequence, delete old evaluations, reuse identities or change
canonical lease/CAS behavior. Such operations are not part of this source task.

Before any database acceptance claim, qualify the exact migration and fixtures:
DDL/catalog/ACL/RLS, valid and malformed input, equal and conflicting replay,
cross-stage binding, rollback injection, paging beyond 100 rows and 2^53,
commit-order overlap, and canonical runtime regression. Source inspection or
mocked SDK checks do not establish any of those database outcomes.
