-- OVD-677
-- Record the reviewed OSH Cut quote-only dispatch envelope
-- (oshcut-quote-envelope.v1), matching the worker's code-reviewed list in
-- worker/src/providerDispatchEnvelope.ts.
--
-- This row alone admits nothing. Generic dispatch for OSH Cut additionally
-- requires an approved private.quote_provider_admission_policies revision with
-- generic_dispatch_enabled = true (OSH Cut stays 'disabled' here and is not
-- touched), the automatic_quote_collection rollout, organization enablement,
-- and a worker deployed with oshcut in WORKER_LIVE_ADAPTERS plus an OSH Cut
-- session secret. Admission is an operator action recorded through the
-- registry's audited revision history, not a migration.
--
-- Permit lifetime: 7200 seconds, the same budget as the Fictiv, Quickparts and
-- Weerg envelopes: one full 3600-second task ahead on the single-instance,
-- concurrency-1 worker plus the 1/5/15-minute retry schedule
-- (vendorTaskRetry.ts). Review rows are append-only; a different lifetime
-- needs a new envelope version.
--
-- Rollback (operational): set withdrawn_at on this row; new OSH Cut requests
-- and previews are then denied immediately (OVD-458). Rows cannot be deleted.

insert into private.provider_dispatch_envelope_reviews (
  provider,
  envelope_id,
  envelope_version,
  evidence_reference,
  permit_ttl_seconds
)
select
  'oshcut'::public.vendor_name,
  'oshcut-quote-envelope',
  1,
  'OVD-677',
  7200
where not exists (
  select 1
  from private.provider_dispatch_envelope_reviews review
  where review.provider = 'oshcut'::public.vendor_name
    and review.withdrawn_at is null
);
