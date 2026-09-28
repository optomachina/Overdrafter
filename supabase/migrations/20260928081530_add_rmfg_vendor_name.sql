-- OVD-582: add RMFG as a source-only vendor identity.
-- The new enum value must commit before the separate disabled seed uses it.
-- Operational rollback retains this value for compatibility.

alter type public.vendor_name add value if not exists 'rmfg';
