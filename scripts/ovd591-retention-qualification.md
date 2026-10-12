# Separate immutable-preparation SQL qualification

This profile is implemented source, not a claim that SQL has run. The reusable
`ovd591-retention-qualification.yml` workflow calls the same exclusively owned CI
fixture adapter with `run-retention`. Its artifact and container names identify
the retention profile separately. The original default `run` profile still owns
its unchanged six races and 28 assertions.

The closed retention profile provisions the same selected capability dependency
closure, checks its catalog, applies the exact preparation-retention migration,
then checks retention RPC ACLs, forced RLS and sequence privileges/CACHE 1. It
runs the three rollback-only capability suites and the unchanged standalone
preparation fixture before a separate concurrency protocol. It does not run the
old six-race fixture in this database: that fixture intentionally commits records,
whereas the preparation fixture requires empty canonical state.

The nine required groups are represented by eleven explicit SQL subcases:

| Group | Actual SQL evidence required |
| --- | --- |
| Duplicate claim | One created, one existing; both original envelopes; no canonical lease or revision. |
| Changed claim | One creator and one completed SQLSTATE 23505; stored winner equals that actor's original input. |
| Shared completion identity | One retained owner under concurrent distinct request keys; no second reservation. |
| Duplicate completion | Real canonical claim/fence; exact preparation replay; no observation append; changed fence rejected. |
| Duplicate attention | Identical and changed envelope subcases; exact replay or conflict; no CAS/outbox mutation. |
| Numeric ordering | Distinct same-window identities cross decimal width above JS's safe integer; two original payloads, exact string cursors, limit-one lookahead pages. |
| Commit visibility | Separate claim and attention cases: actor A retains its transaction, B is observed blocked by A; no precommit row/page, no earlier B allocation; both delivered once after commit. |
| Rollback gap | A rolls back after allocation while B waits; only B's original input is discoverable and the sequence gap is preserved. |
| Replay after authority changes | SQL-clock lease expiry and real canonical CAS advance; exact retained completion/attention replay leaves canonical state untouched and cannot bypass completion rejection or stale-version CAS. |

The phase manifest contains 76 SQL assertions. The executor adds fourteen
assertions only after validating real exact-PID blocker receipts, for a separate
90-assertion TAP stream. No sleeps alone establish overlap. The 20ms SQL polling
delay is bounded to 150 attempts and must return actual `pg_blocking_pids`
evidence. All three clients use the same admitted `postgres@postgres` Unix
socket; their distinct PID, backend-start, role and transport receipts precede
setup. Fixed operation names select fixed SQL inputs. JSON result storage reuses
the existing COPY escaping/framing primitives; transport failures never become
SQLSTATE conflict results.

The immutable SQL inputs are copied only by reference/hash. The new manifest
retains original semantic JSON including nulls, array order and timestamp text;
SQL's JSONB object ordering is immaterial. The synthetic cursor sequence restart
is confined to this exclusively owned disposable fixture. It is not a production
recovery operation. Rows committed for publication testing remain inside that
fixture until its proven destruction; no synthetic row is uploaded elsewhere.

Actor exits and SQL-observed absence of both exact actor PIDs precede helper
removal. The coordinator then closes normally; the fixture owner separately
requires no remaining client backend before destroying its exact owned container
and internal network and reconciling original inventories. A killed host CLI is
recorded as unconfirmed containment, never backend cleanup proof.

Inert Node tests simulate scheduling and failures; they do not evaluate SQL or
replace the hosted SQL receipt. The hosted run must retain all suite TAP,
per-session stdout/stderr, exact inputs, overlap receipts, SQLSTATEs, source/image
identity, catalog and cleanup evidence. No skip/TODO, timeout, malformed frame or
incomplete plan can pass. Runtime failure remains evidence and requires a scoped
correction. This profile does not qualify full-head auth/storage, PostgREST,
provider execution, the eighteen-file production transition, backup/restore or
deployment. Those remain separate gates.
