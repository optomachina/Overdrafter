-- Add eMachineShop as a hidden instant-quote vendor candidate.
-- It is not part of default client quote fan-out. Organizations must enable it
-- explicitly and the worker must opt in through WORKER_LIVE_ADAPTERS.

alter type public.vendor_name add value if not exists 'emachineshop';
alter type public.process_types add value if not exists 'waterjet_cutting';

-- Rollback: PostgreSQL enum values cannot be removed safely in place. Disable
-- eMachineShop in org_vendor_configs and worker rollout configuration instead.
