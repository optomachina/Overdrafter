-- Add hidden live-quote vendor candidates.
-- These enum values are intentionally not added to the default client-request
-- vendor fallback. They become requestable only when an organization explicitly
-- enables them in org_vendor_configs and the worker opts them in through
-- WORKER_LIVE_ADAPTERS.

alter type public.vendor_name add value if not exists 'oshcut';
alter type public.vendor_name add value if not exists 'fabworks';
alter type public.vendor_name add value if not exists 'ponoko';
alter type public.vendor_name add value if not exists 'quickparts';
alter type public.vendor_name add value if not exists 'rapiddirect';
alter type public.vendor_name add value if not exists 'geomiq';
alter type public.vendor_name add value if not exists 'weerg';
alter type public.vendor_name add value if not exists 'protolabsnetwork';
