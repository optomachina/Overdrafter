-- OVD-199: register eMachineShop as a manual RFQ source.
--
-- PostgreSQL enum additions must commit before the new value is used by the
-- capability and admission-policy tables, so configuration lives in the next
-- migration.
--
-- Rollback is operational: keep the enum value for compatibility and remove it
-- from default selection in a reviewed forward migration.

alter type public.vendor_name add value if not exists 'emachineshop';
