-- Appended by scripts/test-native-artifact-mapping.mjs to the real ownership fixture.
-- Synthetic metadata only: NO uploaded bytes, Windows or storage transport proof.
create function pg_temp.write_mapping(manifest text default pg_temp.seed_manifest(),bucket text default 'mapping-synthetic')
returns jsonb language sql security invoker as $$
 select engineering_private.write_native_artifact_mappings(pg_temp.attempt(),manifest,bucket);
$$;
select throws_ok($$select pg_temp.write_mapping('[]')$$,'42501','native_mapping_seed_manifest_mismatch','wrong admitted manifest rejected');
select throws_ok($$select pg_temp.write_mapping(pg_temp.seed_manifest(),'mapping-public')$$,'42501','native_mapping_private_bucket_required','public output bucket rejected');
select is((select count(*) from engineering_private.native_artifact_inputs),3::bigint,'failed setup preserves three preclaim input rows');
select is((select count(*) from engineering_private.native_artifact_outputs),0::bigint,'failed setup has no partial output rows');
select is(engineering_private.prepare_native_artifact_outputs(pg_temp.attempt(),'mapping-synthetic')->>'outputRoles','7','postclaim outputs require no seed manifest');
create temporary table mapping_receipt as select pg_temp.write_mapping() as receipt;
select is((select receipt->'inputs' from mapping_receipt),(select receipt->'inputs' from preclaim_mapping),'claim does not change preclaim input IDs');
select is(pg_temp.write_mapping(),(select receipt from mapping_receipt),'exact replay returns original opaque IDs');
select is((select count(*) from engineering_private.native_artifact_inputs),3::bigint,'all three input mappings');
select is((select count(*) from engineering_private.native_artifact_outputs),7::bigint,'all seven output targets');
select throws_ok($$select pg_temp.write_mapping(pg_temp.seed_manifest(),'mapping-other')$$,'23505','native_mapping_output_replay_mismatch','changed output bucket replay denied');
select throws_ok($$update engineering_private.native_artifact_inputs set sha256=pg_temp.h(999)$$,'55000','Native artifact mapping is immutable.','input rows immutable');
select throws_ok($$delete from engineering_private.native_artifact_outputs$$,'55000','Native artifact mapping is immutable.','output rows immutable');
-- Preserve admitted manifest text before the storage generation changes.
create temporary table original_manifest as select pg_temp.seed_manifest() as manifest;
update storage.objects set version='replacement' where id=pg_temp.n(801);
select throws_ok($$select pg_temp.write_mapping((select manifest from original_manifest))$$,'42501','native_mapping_generation_mismatch','replacement generation denied even on exact replay');
update storage.objects set version='pinned-v1' where id=pg_temp.n(801);
insert into engineering_private.native_admission_revocations(input_admission_id,revoked_by,reason)
values(pg_temp.n(70),pg_temp.n(1),'synthetic revocation');
select throws_ok($$select pg_temp.write_mapping((select manifest from original_manifest))$$,'42501','native_mapping_authority_mismatch','revoked input denied before replay');
set local role service_role;
select throws_ok($$select engineering_private.write_native_artifact_mappings(null,null,'mapping-synthetic')$$,'42501',null,'service role cannot write mappings');
reset role;
set local role authenticated;
select throws_ok($$select engineering_private.write_native_artifact_mappings(null,null,'mapping-synthetic')$$,'42501',null,'authenticated cannot write mappings');
reset role;
set local role anon;
select throws_ok($$select engineering_private.write_native_artifact_mappings(null,null,'mapping-synthetic')$$,'42501',null,'anon cannot write mappings');
reset role;
