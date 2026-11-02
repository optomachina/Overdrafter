-- DRAFT: stop/roll back callers first. Execute in one transaction.
-- Retain private.vendor_quote_acceptance_receipts (immutable evidence) and
-- private.quote_run_rollup_followups (including pending work), their indexes,
-- identity sequence, RLS and revoked grants. No application data is deleted.
-- The append-only trigger is removed with its function; callers must remain
-- stopped until reapply restores it. Forward IF NOT EXISTS retains these rows.
set local lock_timeout = '1s';
drop function public.drain_quote_run_rollup_followups(integer);
drop function private.aggregate_quote_run_status(public.vendor_status[]);
drop function public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb);
drop function private.vendor_quote_acceptance_request_ids(uuid);
drop function private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb);
drop trigger vendor_quote_acceptance_receipts_append_only on private.vendor_quote_acceptance_receipts;
drop function private.reject_vendor_quote_acceptance_receipt_mutation();
