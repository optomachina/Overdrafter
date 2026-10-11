begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

-- OVD-685: anon and public must not have EXECUTE on SECURITY DEFINER archived job deletion RPCs

select ok(
  not has_function_privilege('anon', 'public.api_delete_archived_jobs(uuid[])', 'EXECUTE'),
  'anon cannot execute api_delete_archived_jobs'
);

select ok(
  not has_function_privilege('public', 'public.api_delete_archived_jobs(uuid[])', 'EXECUTE'),
  'public cannot execute api_delete_archived_jobs'
);

select ok(
  not has_function_privilege('anon', 'public.api_delete_archived_job(uuid)', 'EXECUTE'),
  'anon cannot execute api_delete_archived_job'
);

select ok(
  not has_function_privilege('public', 'public.api_delete_archived_job(uuid)', 'EXECUTE'),
  'public cannot execute api_delete_archived_job'
);

select * from finish();

rollback;
