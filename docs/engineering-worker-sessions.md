# Engineering worker pairing and sessions

OVD-498 adds durable worker identity and explicit session authority to the private
engineering lane. It does not claim tasks, launch SolidWorks, qualify a runtime,
install a companion, or activate production. The Workstation target and complete
request-to-result milestone remain unchanged.

## Ownership and secrets

An allowlisted user with current organization/project access owns a worker.
Only that owner reads its metadata or creates, enables, pauses and revokes it.
The pilot permits one unrevoked worker per organization and one active pairing
per installation identity. An expired invitation still occupies that worker slot;
the owner revokes it and creates a new invitation. Revoked history is retained.

The later companion/gateway generates independent 32-byte random pairing codes
and worker tokens. Pairing expires ten minutes after the database creates the
invitation. The companion must persist its token under Windows DPAPI before
consuming the code, allowing delivery retries with the same token and request.
The server stores only SHA-256 digests in `engineering_private`, inaccessible by
direct reads even to the gateway's `service_role`. Public audit records contain an
opaque digest of transition arguments, never the individual secret hashes.

The gateway must receive raw bearer tokens over HTTPS and hash them itself. It
must never accept a caller-supplied digest as bearer authority. The database RPCs
below are server interfaces, not endpoints to expose directly to the companion.
No general database credential goes to Windows. Raw secrets, hashes and RPC
arguments must be excluded from AI context, analytics and request logging.
Rate limiting and random-secret generation require gateway qualification before
activation; hash syntax validation does not prove entropy.

## API contract

Public functions use `SECURITY INVOKER` wrappers around scoped private definers
with fixed search paths and explicit role grants. All mutation calls require an
idempotency key and expected revision. Creation expects revision zero. Every
accepted transition advances the worker revision once and appends an immutable
receipt. Changed arguments under an existing key or stale revisions return
`PT409` (HTTP 409); invalid input uses `22023`; access denial uses `42501`.

| API | Caller | Effect |
| --- | --- | --- |
| `api_create_worker_pairing` | Authenticated owner | Creates a worker and private ten-minute invitation from a canonical code digest. |
| `api_consume_worker_pairing` | Gateway only | Atomically binds the invitation to one installation and credential digest. |
| `api_register_worker_boot` | Gateway only | Authenticates the worker, records a fresh boot, clears current session eligibility. |
| `api_control_worker_session` | Authenticated owner | Applies `enabled`, `paused`, or `revoked` against an exact revision. Enable/pause require the current boot; revoke takes a null boot. |
| `api_worker_session_eligibility` | Gateway only | Checks current credential, owner access, boot, session, pause and expiry. It does not claim a task. |

Pairing consumption is single-use. Only an exact replay of the original
idempotency key, expected revision, code, installation and credential returns the
original receipt, including after its consumed invitation expires. Access and
revocation are still checked. A conflicting contender cannot substitute its own
credential. Boot identities cannot be reused with a new key. Historical boot
replay never rolls the current boot pointer backward.

## Session lifecycle

Pairing alone grants no execution eligibility. Every companion startup reports a
fresh boot identifier. Owner enablement binds that exact installation and boot to
a fixed eight-hour grant. A live unpaused grant cannot be extended in place.
After expiry or pause, explicit owner enablement creates another immutable grant.
A new boot always clears current eligibility until the owner enables it again.

Pause and revocation remain different transitions. Pause closes admission for the
current grant. Revocation invalidates worker authentication and prevents reuse of
the pairing. Neither transition asserts that native work has stopped or that an
artifact is verified. An owner can replay an old action receipt without changing
current authority; consumers must refresh worker state instead of treating an old
receipt as current enablement.

Transitions serialize on the worker and recheck current access after lock waits.
Expiration checks use the database wall clock after acquiring locks, rather than
the transaction start time. Session expiry and paused/restarted states return
`sessionEligible: false` with a structured reason. Invalid or revoked credentials
and lost owner access fail authentication instead.

The future task coordinator must call eligibility inside its claim transaction,
then separately enforce runtime qualification, one active native job, exact
verified predecessor inputs, leases, fences and confirmed process exit before
retry. Session expiry, boot changes and lost heartbeats do not prove process exit.
The eight-hour grant is an admission window; an already running job drains under
the native coordinator's own deadline and recovery policy.

## Verification and migration

The additive migration creates three public metadata/history tables, two private
secret-digest tables, scoped foreign keys, RLS, immutable identity triggers and
five API contracts. It inserts no operators, workers, credentials or sessions.
Existing quoting behavior is unchanged.

Run `npm run test:engineering-worker-sessions -- supabase_db_ovd498-worker-sessions`
against an explicitly named disposable local database with the migration applied.
The runner accepts no hosted URL or output-file argument and prints its report to
stdout. It uses synthetic identities and independently generated test secrets.
The SQL suite covers owner/tenant restrictions, private read grants, single-use
pairing, exact replay, invalid values, boot changes, session boundaries and history
immutability. Independent connections exercise duplicates, competing pairing and
enablement, access revocation during lock waits, and expiry after waiting.
Clock-boundary fixtures are inserted by the local database owner; they do not
prove actual eight-hour Windows behavior, DPAPI storage or native isolation.

Apply only through the reviewed deployment procedure. Rollback revokes API
execution and disables new worker/session admission while preserving grants,
credentials and receipts. Do not delete history or infer native shutdown from a
database rollback. Production migration, pairing and companion activation remain
separate steps with a concrete reviewed activation packet.
