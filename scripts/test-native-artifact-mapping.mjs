/** Emit inert rollback-only SQL. No process, network, environment or credentials.
 * Operator applies approved real schema first; this never patches OVD558 preflight. */
import { readFileSync } from 'node:fs';
const fixture = readFileSync(new URL('../supabase/tests/engineering_native_ownership.sql', import.meta.url), 'utf8');
const marker = "select is(pg_temp.claim(),pg_temp.claim(),'same claim returns immutable original receipt');";
if (fixture.split(marker).length !== 2) throw new Error('ownership_fixture_marker_changed');
let prefix = fixture.slice(0, fixture.indexOf(marker));
const admissionMarker = 'insert into engineering_private.native_input_admissions(id,snapshot_id,organization_id,project_id,kind,context_sha256,';
if (prefix.split(admissionMarker).length !== 2) throw new Error('admission_fixture_marker_changed');
const setup = `
insert into storage.buckets(id,name,public) values('mapping-synthetic','mapping-synthetic',false),('mapping-other','mapping-other',false),('mapping-public','mapping-public',true);
insert into storage.objects(id,bucket_id,name,version)
select pg_temp.n(800+n),'mapping-synthetic','seed-'||n,'pinned-v1' from generate_series(0,2) n;
create function pg_temp.seed_manifest() returns text language sql as $m$
 select jsonb_agg(jsonb_build_object('role',(array['assembly','target','companion'])[n+1],
 'path',f->>'path','bytes',f->'bytes','sha256',f->>'sha256','storageObjectId',o.id,
 'storageVersion',o.version,'storageUpdatedAt',o.updated_at) order by n)::text
 from public.engineering_snapshots s cross join generate_series(0,2) n
 cross join lateral (select s.context_text::jsonb->'files'->n as f) files
 join storage.objects o on o.id=pg_temp.n(800+n) where s.id=pg_temp.n(20);
$m$;
`;
prefix = prefix.replace(admissionMarker, setup + admissionMarker);
const hashMarker = "context_sha256,pg_temp.h(7),pg_temp.h(8)";
if (prefix.split(hashMarker).length !== 2) throw new Error('hash_fixture_marker_changed');
prefix = prefix.replace(hashMarker, "context_sha256,encode(extensions.digest(pg_temp.seed_manifest(),'sha256'),'hex'),pg_temp.h(8)");
const preclaimMarker = "set local role service_role;\nselect is(pg_temp.claim(2,30,201)";
if (prefix.split(preclaimMarker).length !== 2) throw new Error('preclaim_fixture_marker_changed');
prefix = prefix.replace(preclaimMarker, `
create temporary table preclaim_mapping as
select engineering_private.prepare_native_artifact_inputs(pg_temp.n(70),pg_temp.n(1),pg_temp.seed_manifest()) as receipt;
select is((select count(*) from public.engineering_execution_attempts),0::bigint,'input IDs exist before any attempt');
select is((select jsonb_array_length(receipt->'inputs') from preclaim_mapping),3,'three opaque preclaim input IDs');
` + preclaimMarker);
const proof = readFileSync(new URL('../docs/release/native-artifact-mapping-proof.sql', import.meta.url), 'utf8');
const stopStart = fixture.indexOf('create function pg_temp.stop_fixture(');
const stopEnd = fixture.indexOf('create function pg_temp.stop(n integer', stopStart);
if (stopStart < 0 || stopEnd < stopStart) throw new Error('stop_fixture_marker_changed');
const stopFixture = fixture.slice(stopStart, stopEnd) + `
select throws_ok($$select engineering_private.prepare_native_artifact_outputs(pg_temp.attempt(),'mapping-synthetic')$$,
 '42501','native_mapping_authority_mismatch','unstopped attempt cannot provision outputs');
-- Synthetic admitted stop only; does not qualify observer evidence or Windows.
select pg_temp.stop_fixture(882,pg_temp.attempt());
set local role service_role;
select public.api_record_native_stop(pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),pg_temp.task(),pg_temp.attempt(),pg_temp.n(882),0,pg_temp.n(883));
reset role;
`;
process.stdout.write(prefix + '\nreset role;\n' + stopFixture + proof + '\nselect * from finish();\nrollback;\n');
