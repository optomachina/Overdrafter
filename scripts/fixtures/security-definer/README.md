# SECURITY DEFINER lint fixtures (OVD-846)

Inputs for `scripts/lint-security-definer.test.mjs`. These are not migrations:
nothing under `scripts/fixtures/` is read by the Supabase CLI, the migration
lineage verifier (which reads only `supabase/migrations/`) or the pgTAP
workflows. Several files are intentionally non-compliant.
