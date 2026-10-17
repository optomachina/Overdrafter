-- Fixture: an untagged legacy test, so the legacy entries rely on the baseline.
begin;
select plan(1);
select has_table('public', 'legacy_items', 'legacy_items exists');
select * from finish();
rollback;
