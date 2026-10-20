# Migration function collisions

`npm run verify:migration-function-collisions` (`scripts/check-migration-function-collisions.mjs`)
fails when a draft under `docs/migration-drafts` would silently replace a function
that already exists in a different form. It runs as a step of the existing `lint`
job in `.github/workflows/ci.yml`, so it is part of the required `ci` result and is
not a separate check, and as part of `npm run verify`. It is offline: it reads SQL
text, never connects to a database and never runs SQL.

## Why

`create or replace function` replaces the whole body. Migrations apply in filename
order, so a migration that restates an earlier function is ordinary history. A draft
has no place in that order. When it is promoted it replaces whatever body is deployed
at that moment, including a newer body written after the draft was copied.

The case that motivated the check: the OVD-762 draft copies
`public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)`
(S4) with its fan out rule. The OVD-987 migration changes the same function to add the
lane identity and quantity re-checks. Applied unrebased after OVD-987, the OVD-762
draft would swap the new S4 for its quantity-1 copy without a single error. The OVD-987
notes (`docs/migration-drafts/ovd-987-notes.md`, on its PR) list the md5 of the seven
bodies a rebased draft must be written against; this check turns that list into a gate.

## What is compared

Every `create [or replace] function|procedure` at the top level of a file, identified
by schema (default `public`), name and input argument types (names, defaults and
`out` arguments dropped; `int`/`integer`, `timestamptz`/`timestamp with time zone`,
`integer[]`/`integer ARRAY` and similar spellings are one type; a quoted type name
keeps its case), with its body as `pg_proc.prosrc` stores it: the text between the
dollar quotes, or a single quoted body with `''` read as one quote and, in an `E'...'`
string, the backslash escapes decoded. Bodies are compared by the sha256 of that text.

- `supabase/migrations/*.sql`, in filename order. The last definition is the deployed
  body (a trailing `drop function` leaves none). Migrations restating each other are
  history and are not compared with each other (see "Not covered").
- `docs/migration-drafts/*.sql` are the promotable bodies, except:
  - `*.rollback.sql` (restores the body it replaced, runs only as the inverse of its
    own forward file);
  - a draft whose header says `SUPERSEDED` or "Do not apply this draft" (the same
    rule `scripts/ephemeral-db-apply.mjs` uses). This header is the explicit
    evidence that a draft will not be promoted;
  - a draft whose body equals the body deployed right now: an archived copy, because
    promoting it changes nothing. A body that only an older migration carried does
    not count. It would put the older body back, so it is compared like any other
    draft.

A promotable draft body fails the check when:

1. a migration defines the same function with a different body (the draft would
   replace the deployed one), or
2. another promotable draft defines it differently (whichever is promoted second
   replaces the other).

## The allowlist

`docs/migration-drafts/function-supersessions.json` documents each intended
replacement by naming the superseded body. An example entry for a draft that has been
rebased onto the OVD-987 S4 body, naming it by the md5 the OVD-987 notes list:

```json
{
  "version": 1,
  "supersessions": [
    {
      "signature": "public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)",
      "file": "docs/migration-drafts/ovd-762-xometry-fanout-scope.sql",
      "supersedesMd5": "0fef772880a4122f72475a9905b7ed19",
      "reason": "Rebased onto the OVD-987 S4 body and guarded by an md5 precondition."
    }
  ]
}
```

- `file` is the later draft (the one that replaces). The body it replaces is named by
  exactly one of:
  - `supersedesSha256`, the sha256 of the body's UTF-8 text. A failure prints the entry
    in this form. From a database:
    `select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('<signature>');`
  - `supersedesMd5`, the `md5(pg_proc.prosrc)` value that migration notes and md5
    preconditions quote, so an entry can carry the same value as the draft's
    precondition. The check computes an md5 only to match such an entry, with its own
    RFC 1321 code rather than a crypto API: it is the fingerprint the database prints,
    not a security control.
- For two drafts, an entry on either one clears the pair.
- The entry matches only while that body is still the one being replaced. When a
  newer migration changes the function, or another draft changes its body, the entry
  stops matching and the check fails again until the draft is rebased and the entry
  updated. That is the point: a documented supersession is pinned to a body.
- The same holds for an archived copy. A draft equal to the deployed body passes
  without an entry, and fails with the entry to add as soon as a newer migration
  changes the function. Retire the draft with a `SUPERSEDED` header or delete it,
  or rebase it onto the new body and add the entry.
- An entry that nothing needs any more (the draft was promoted, deleted or rebased) is
  reported as unused. Remove it in the same change.
- `reason` is required. Say why replacing that body is intended.

The first version of the file records the 24 draft restatements that existed when the
check was added, each written against the body deployed at that time and named by its
sha256.

## Fixing a failure

| Failure | What to do |
| --- | --- |
| A new draft restates a deployed function | Write the draft against the deployed body and add an entry naming it. The failure prints the entry. |
| A migration lands that changes a function a draft restates | Rebase the draft onto the new body (add an md5 precondition to the draft the way the OVD-987 migration does), then update the entry: the sha256 the failure prints, or the precondition's md5 as `supersedesMd5`. Do not change the value without rebasing: the entry is a claim that the draft was written against that body. |
| Two drafts restate one function | Decide the promotion order, rebase the second onto the first, and add the entry. |
| A draft is promoted into `supabase/migrations` | Delete its entries (reported as unused). Drafts that still restate the promoted function, including verbatim copies of the body it replaced, now fail against the new deployed body until they are rebased or retired. |

The failure message prints the sha256 of both bodies and the entry to add.

## Not covered

- Two migrations that restate one function from the same base (the concurrent
  migration form of the hazard). Base body V1, a migration on main changes it to V1
  plus A, and a second migration written against V1 and dated later changes it to V1
  plus B. Applying the second replaces the whole body and silently drops A. Every
  migration restatement is treated as history, so nothing here compares the pair, and
  the merge queue does not catch it either. The scope of this check is a draft against
  the deployed body or against another draft. For migrations, the safeguard is what
  the OVD-987 notes already require by hand: an md5 precondition inside the
  migration, so it fails on apply when the body it replaces is not the one it was
  written against, and a reviewer comparing the body with the one on main.
- Functions created through dynamic SQL (`execute` inside a `do` block), bodies in a
  form with no `AS` string (`begin atomic`), and string bodies the check cannot read
  with certainty: a `U&'...'` string, a string continued on the next line, or an
  `E'...'` string with an escape it does not decode (a backslash before a letter or
  digit other than `\b \f \n \r \t`, octal, `\x`, `\u` and `\U`; a surrogate; or bytes
  PostgreSQL rejects). A definition with no readable body is reported rather than
  skipped. Plain single quoted bodies are read with `standard_conforming_strings` on,
  the default.
- Differences other than the body (`security definer`, `set search_path`, grants).
  Two definitions with the same body compare equal.
- Rollback drafts, `alter function`, the `.inc` pgTAP fixtures that copy drafts, and the
  database itself. Whether a body is what a hosted database holds is still the job of
  the read-only md5 checks in each migration's notes.
