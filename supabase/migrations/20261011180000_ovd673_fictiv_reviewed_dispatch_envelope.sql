-- OVD-673
-- Record the reviewed Fictiv quote-only dispatch envelope
-- (fictiv-quote-envelope.v1), matching the worker's code-reviewed list in
-- worker/src/providerDispatchEnvelope.ts.
--
-- This row alone admits nothing. Generic dispatch for Fictiv additionally
-- requires an approved private.quote_provider_admission_policies revision with
-- generic_dispatch_enabled = true (Fictiv stays 'disabled' here and is not
-- touched), the automatic_quote_collection rollout, organization enablement,
-- and a worker deployed with fictiv in WORKER_LIVE_ADAPTERS plus a Fictiv
-- session secret. Admission is an operator action recorded through the
-- registry's audited revision history, not a migration.
--
-- Permit lifetime: 7200 seconds covers one full 3600-second task ahead on the
-- single-instance, concurrency-1 worker plus the 1/5/15-minute retry schedule
-- (vendorTaskRetry.ts), so an admitted task does not expire while queued.
-- Review rows are append-only; a different lifetime needs a new envelope
-- version (withdraw this row, review the next).
--
-- Rollback (operational): set withdrawn_at on this row; new Fictiv requests
-- and previews are then denied immediately (OVD-458). Rows cannot be deleted.

insert into private.provider_dispatch_envelope_reviews (
  provider,
  envelope_id,
  envelope_version,
  evidence_reference,
  permit_ttl_seconds
)
select
  'fictiv'::public.vendor_name,
  'fictiv-quote-envelope',
  1,
  'OVD-673',
  7200
where not exists (
  select 1
  from private.provider_dispatch_envelope_reviews review
  where review.provider = 'fictiv'::public.vendor_name
    and review.withdrawn_at is null
);
