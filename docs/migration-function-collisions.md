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
`out` arguments dropped; `int`/`integer`, `timestamptz`/`timestamp with time zone` and
similar spellings are one type), with the md5 of its body. The md5 is
`md5(pg_proc.prosrc)` for a dollar quoted body, the value the staging and production
read-only checks print.

- `supabase/migrations/*.sql`, in filename order. The last definition is the deployed
  body (a trailing `drop function` leaves none). Migrations restating each other are
  history and are never compared.
- `docs/migration-drafts/*.sql` are the promotable bodies, except:
  - `*.rollback.sql` (restores the body it replaced, runs only as the inverse of its
    own forward file);
  - a draft whose header says `SUPERSEDED` or "Do not apply this draft" (the same
    rule `scripts/ephemeral-db-apply.mjs` uses);
  - a draft whose body equals a body some migration already carries: that is an
    archived copy of something promoted.

A promotable draft body fails the check when:

1. a migration defines the same function with a different body (the draft would
   replace the deployed one), or
2. another promotable draft defines it differently (whichever is promoted second
   replaces the other).

## The allowlist

`docs/migration-drafts/function-supersessions.json` documents each intended
replacement by naming the superseded body. An example entry for a draft that has been
rebased onto the OVD-987 S4 body:

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

- `file` is the later draft (the one that replaces); `supersedesMd5` is the md5 of
  the body it replaces. For two drafts, an entry on either one clears the pair.
- The entry matches only while that body is still the one being replaced. When a
  newer migration changes the function, or another draft changes its body, the entry
  stops matching and the check fails again until the draft is rebased and the md5
  updated. That is the point: a documented supersession is pinned to a body.
- An entry that nothing needs any more (the draft was promoted, deleted or rebased) is
  reported as unused. Remove it in the same change.
- `reason` is required. Say why replacing that body is intended.

The first version of the file records the 24 draft restatements that existed when the
check was added, each written against the body deployed at that time.

## Fixing a failure

| Failure | What to do |
| --- | --- |
| A new draft restates a deployed function | Write the draft against the deployed body and add an entry naming its md5. The failure prints the entry. |
| A migration lands that changes a function a draft restates | Rebase the draft onto the new body (add an md5 precondition to the draft the way the OVD-987 migration does), then update the entry's `supersedesMd5`. Do not change the md5 without rebasing: the entry is a claim that the draft was written against that body. |
| Two drafts restate one function | Decide the promotion order, rebase the second onto the first, and add the entry. |
| A draft is promoted into `supabase/migrations` | Delete its entries (reported as unused). Drafts that still restate the promoted function now fail against the new deployed body until they are rebased. |

The failure message prints the md5 of both bodies and the entry to add.

## Not covered

- Functions created through dynamic SQL (`execute` inside a `do` block) and bodies in
  a form with no `AS` string (`begin atomic`). A definition with no readable body is
  reported rather than skipped.
- Differences other than the body (`security definer`, `set search_path`, grants).
  Two definitions with the same body compare equal.
- Rollback drafts, `alter function`, the `.inc` pgTAP fixtures that copy drafts, and the
  database itself. Whether a body is what a hosted database holds is still the job of
  the read-only md5 checks in each migration's notes.
