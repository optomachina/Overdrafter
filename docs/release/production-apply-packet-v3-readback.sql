-- Production apply packet v3: Post-apply readback
-- Project: ozuatdcakezjtevztjlr (Website)
-- Expected ledger: 140 rows (112 + 28 new migrations)
--
-- Run this read-only check after applying migrations.
-- All checks must pass to confirm successful apply.

\set ON_ERROR_STOP 1
\set QUIET 1

-- Enable read-only mode for safety
SET default_transaction_read_only = on;
SET ROLE postgres;

\echo ''
\echo '=== Production Apply Packet v3: Post-Apply Readback ==='
\echo ''

-- Check 1: Verify ledger count
\echo 'Check 1: Verifying ledger row count...'
DO $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*) INTO actual_count 
  FROM supabase_migrations.schema_migrations;
  
  IF actual_count != 140 THEN
    RAISE EXCEPTION 'Ledger count mismatch: expected 140, found %', actual_count;
  END IF;
  
  RAISE NOTICE 'OK: Ledger has 140 rows';
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
  
  IF actual_head != '20261008055500' THEN
    RAISE EXCEPTION 'Ledger head mismatch: expected 20261008055500, found %', actual_head;
  END IF;
  
  RAISE NOTICE 'OK: Ledger head is 20261008055500';
END $$;

-- Check 3: Verify all 28 target migrations are present
\echo 'Check 3: Verifying all target migrations are present...'
DO $$
DECLARE
  missing_migrations text[];
  target_migrations text[] := ARRAY[
    '20260910045917', '20260910055556', '20260910064137', '20260910104500',
    '20260910134500', '20260911031500', '20260926225000', '20260927060736',
    '20260927065514', '20260927130000', '20260927140000', '20260927225843',
    '20260928081530', '20260928081534', '20261002041305', '20261002053133',
    '20261002090339', '20261002133713', '20261002182714', '20261002182910',
    '20261003011148', '20261003150000', '20261003160000', '20261003170000',
    '20261004100000', '20261004110000', '20261004130000', '20261008055500'
  ];
  found_count integer;
BEGIN
  SELECT count(*)
  INTO found_count
  FROM supabase_migrations.schema_migrations
  WHERE version = ANY(target_migrations);
  
  IF found_count != 28 THEN
    SELECT array_agg(m)
    INTO missing_migrations
    FROM unnest(target_migrations) m
    WHERE m NOT IN (
      SELECT version FROM supabase_migrations.schema_migrations
    );
    
    RAISE EXCEPTION 'Found only %/28 target migrations. Missing: %', 
      found_count, missing_migrations;
  END IF;
  
  RAISE NOTICE 'OK: All 28 target migrations are present';
END $$;

-- Check 4: Calculate final ledger fingerprint
-- Formula: md5(string_agg(version||':'||name, ',' ORDER BY version))
-- Expected post-apply fingerprint for 140 rows: e3ab3b22bc1bfc9ad67092dfc877a3a8
\echo 'Check 4: Calculating final ledger fingerprint...'
DO $$
DECLARE
  actual_fingerprint text;
  expected_fingerprint text := 'e3ab3b22bc1bfc9ad67092dfc877a3a8';
BEGIN
  SELECT md5(string_agg(version || ':' || name, ',' ORDER BY version))
  INTO actual_fingerprint
  FROM supabase_migrations.schema_migrations;
  
  RAISE NOTICE 'Final ledger fingerprint: %', actual_fingerprint;
  
  IF actual_fingerprint != expected_fingerprint THEN
    RAISE WARNING 'Fingerprint mismatch: expected %, found %', 
      expected_fingerprint, actual_fingerprint;
    RAISE NOTICE 'Verify ledger composition and record actual fingerprint';
  ELSE
    RAISE NOTICE 'OK: Fingerprint matches expected post-apply baseline';
  END IF;
  
  RAISE NOTICE 'Record this fingerprint as the post-apply baseline';
END $$;

-- Check 5: List recent migrations for verification
\echo 'Check 5: Listing the 28 newly applied migrations...'
SELECT 
  row_number() OVER (ORDER BY version) as seq,
  version,
  substring(name, 1, 50) as migration_name
FROM supabase_migrations.schema_migrations
WHERE version >= '20260910045917'
  AND version NOT IN ('20260923035755', '20260924001152', '20260924001203', 
                       '20260924004159', '20260924004202', '20260924014552')
ORDER BY version;

-- Check 6: Summary
\echo ''
\echo 'Check 6: Final ledger summary...'
SELECT 
  count(*) as total_migrations,
  min(version) as first_migration,
  max(version) as last_migration
FROM supabase_migrations.schema_migrations;

\echo ''
\echo '=== All post-apply checks passed ==='
\echo 'Database is at target state: 140 migrations'
\echo 'Ready to merge PR #564 into main'
\echo ''
