# RLS on new tables lint fixtures (OVD-875)

Inputs for `scripts/lint-rls-new-tables.test.mjs`. These are not migrations:
nothing under `scripts/fixtures/` is read by the Supabase CLI, the migration
lineage verifier (which reads only `supabase/migrations/`) or the pgTAP
workflows. Several files are intentionally non-compliant. Tests lint them
under a `supabase/migrations/...` name chosen at test time.
