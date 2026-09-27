-- Reviewed literals from 20260802020349_add_commercial_rollout_controls.sql.
-- Schema-only fixtures do not copy source database control state.
insert into private.commercial_rollout_controls (capability, enabled, revision, change_reason) values
  ('commercial_admin_mutations', false, 0, 'Default-off commercial operations rollout'),
  ('automatic_quote_collection', false, 0, 'Default-off automatic quote rollout'),
  ('promotion_codes', false, 0, 'Reserved default-off promotion rollout'),
  ('order_administration', false, 0, 'Reserved default-off order administration rollout');
