create temporary table preclaim_mapping as
select engineering_private.prepare_native_artifact_inputs(pg_temp.n(70),pg_temp.n(1),pg_temp.seed_manifest()) as receipt;
select is((select count(*) from public.engineering_execution_attempts),0::bigint,'input IDs exist before any attempt');
select is((select jsonb_array_length(receipt->'inputs') from preclaim_mapping),3,'three opaque preclaim input IDs');
