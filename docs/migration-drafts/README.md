# Migration drafts

Proposed SQL that is **not** applied and is **not** part of `supabase/migrations/`.
A draft needs an approved migration window (`blaine-window` label) before it is
promoted with `npm run migration:next` and copied byte-for-byte into
`supabase/migrations/`. Nothing in CI or the Supabase CLI applies these files.

| Draft | Issue | Rollback | Notes |
| --- | --- | --- | --- |
| `ovd-462.sql` | OVD-462 provider session lease | `ovd-462.rollback.sql` | expand-only; see [provider-session-lease.md](../provider-session-lease.md) |
