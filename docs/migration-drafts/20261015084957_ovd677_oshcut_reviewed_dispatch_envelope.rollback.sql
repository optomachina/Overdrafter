-- OVD-677 ROLLBACK for
-- docs/migration-drafts/20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql.
-- DRAFT ONLY. OSH Cut remains default-off; do not apply under PR #743.
--
-- Withdraw only this draft's review row. The append-only review history and
-- its mutation guard remain intact; no admission or other provider is changed.
-- Re-running is a no-op, as is running before the draft inserts its row.
-- DM-1R compares schema only: the withdrawn row remains as audit evidence.

update private.provider_dispatch_envelope_reviews
set withdrawn_at = greatest(pg_catalog.clock_timestamp(), reviewed_at)
where provider = 'oshcut'::public.vendor_name
  and envelope_id = 'oshcut-quote-envelope'
  and envelope_version = 1
  and evidence_reference = 'OVD-677'
  and withdrawn_at is null;
