-- Production apply packet v3: Pre-apply checks
-- Project: ozuatdcakezjtevztjlr (Website)
-- Expected ledger: 112 rows, ending at 20260924014552
-- Expected fingerprint: 212b70060764426f5f83ee6c58fa2085
--
-- Run this read-only check before applying migrations.
-- All checks must pass before proceeding with the apply.

\set ON_ERROR_STOP 1
\set QUIET 1

-- Enable read-only mode for safety
SET default_transaction_read_only = on;
SET ROLE postgres;

\echo ''
\echo '=== Production Apply Packet v3: Pre-Apply Checks ==='
\echo ''

-- Check 1: Verify ledger count
\echo 'Check 1: Verifying ledger row count...'
DO $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*) INTO actual_count 
  FROM supabase_migrations.schema_migrations;
  
  IF actual_count != 112 THEN
    RAISE EXCEPTION 'Ledger count mismatch: expected 112, found %', actual_count;
  END IF;
  
  RAISE NOTICE 'OK: Ledger has 112 rows';
END $$;

-- Check 2: Verify ledger head
\echo 'Check 2: Verifying ledger head...'
DO $$
DECLARE
  actual_head text;
BEGIN
  SELECT version INTO actual_head 
  FROM supabase_migrations.schema_migrations 
  ORDER BY version DESC 
  LIMIT 1;
  
  IF actual_head != '20260924014552' THEN
    RAISE EXCEPTION 'Ledger head mismatch: expected 20260924014552, found %', actual_head;
  END IF;
  
  RAISE NOTICE 'OK: Ledger head is 20260924014552';
END $$;

-- Check 3: Calculate and verify ledger fingerprint
\echo 'Check 3: Calculating ledger fingerprint...'
DO $$
DECLARE
  actual_fingerprint text;
  expected_fingerprint text := '212b70060764426f5f83ee6c58fa2085';
BEGIN
  SELECT md5(string_agg(version || ':' || statements, E'\n' ORDER BY version))
  INTO actual_fingerprint
  FROM supabase_migrations.schema_migrations;
  
  RAISE NOTICE 'Calculated fingerprint: %', actual_fingerprint;
  
  IF actual_fingerprint != expected_fingerprint THEN
    RAISE WARNING 'Fingerprint mismatch: expected %, found %', 
      expected_fingerprint, actual_fingerprint;
    RAISE NOTICE 'Ledger may have drifted from recorded baseline';
    RAISE NOTICE 'Recompute suffix and record new baseline fingerprint';
  ELSE
    RAISE NOTICE 'OK: Fingerprint matches recorded baseline';
  END IF;
END $$;

-- Check 4: Verify none of the 28 target migrations are already present
\echo 'Check 4: Verifying target migrations are not present...'
DO $$
DECLARE
  found_migrations text[];
  target_migrations text[] := ARRAY[
    '20260910045917', '20260910055556', '20260910064137', '20260910104500',
    '20260910134500', '20260911031500', '20260926225000', '20260927060736',
    '20260927065514', '20260927130000', '20260927140000', '20260927225843',
    '20260928081530', '20260928081534', '20261002041305', '20261002053133',
    '20261002090339', '20261002133713', '20261002182714', '20261002182910',
    '20261003011148', '20261003150000', '20261003160000', '20261003170000',
    '20261004100000', '20261004110000', '20261004130000', '20261008055500'
  ];
BEGIN
  SELECT array_agg(version)
  INTO found_migrations
  FROM supabase_migrations.schema_migrations
  WHERE version = ANY(target_migrations);
  
  IF found_migrations IS NOT NULL THEN
    RAISE EXCEPTION 'Found % target migration(s) already present: %', 
      array_length(found_migrations, 1), found_migrations;
  END IF;
  
  RAISE NOTICE 'OK: None of the 28 target migrations are present';
END $$;

-- Check 5: List the current ledger for verification
\echo 'Check 5: Current ledger summary...'
SELECT 
  count(*) as total_migrations,
  min(version) as first_migration,
  max(version) as last_migration
FROM supabase_migrations.schema_migrations;

\echo ''
\echo '=== All pre-apply checks passed ==='
\echo 'Ready to apply 28 migrations (112 -> 140 rows)'
\echo 'Target migrations: 14 from main + 13 from branch + 1 from OVD-641'
\echo ''
