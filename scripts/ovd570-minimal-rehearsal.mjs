/** Synthetic 112-source-migration to OVD570 rehearsal; parent owns isolation/cleanup. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { catalogSql } from "./ovd510-catalog-sql.mjs";
const testSuites = [
  { path: "supabase/fixtures/sourcing-intent/sourcing_intent_backfill.sql", count: 5 },
  { path: "supabase/tests/sourcing_intent.sql", count: 36 },
  { path: "supabase/tests/quote_lane_eligibility.sql", count: 25 },
  { path: "supabase/tests/job_service_detail_privileges.sql", count: 27 },
  { path: "supabase/tests/ovd537_internal_reader_privileges.sql", count: 51 },
  { path: "supabase/tests/xometry_beta_dispatch_permits.sql", count: 63 },
  { path: "supabase/tests/xometry_beta_dispatch_permits_concurrency.sql", count: 3, user: "supabase_admin" },
  { path: "supabase/tests/sourcing_intent_concurrency.sql", count: 13, user: "supabase_admin" },
  // Repeat in the same database to prove committed fixture cleanup.
  { path: "supabase/tests/sourcing_intent_concurrency.sql", count: 13, user: "supabase_admin" },
];

export function rehearseSourcing({ psql, root, save }) {
  const sql = (text, _database, role = "postgres") => psql(text, 240_000, role);
  const literal = (text) => "'" + text.replaceAll("'", "''") + "'";
  const run = (command,args,input) => {
    const r = spawnSync(command,args,{cwd:root,input,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024});
    if (r.status !== 0) throw new Error("scope_comparison_process_failed");
    return r.stdout.trim();
  };
  const migration = readFileSync(join(root,"supabase/migrations/20260926225000_confirm_sourcing_intent.sql"),"utf8");
  const migrationSha256 = createHash("sha256").update(migration).digest("hex");
  if (migrationSha256 !== "249815c28c9255044413ff2e9bd2a726a0e0728cb117895b25c3bbc91c9d8ffc") throw new Error("target_hash_drift");
  sql(readFileSync(join(root,"supabase/fixtures/sourcing-intent/sourcing_intent_preexisting.sql"),"utf8"));
  const before = psql(catalogSql);
  let failedAsExpected = false;
  try { sql(`begin;${migration} do $$begin raise exception 'ovd570_atomicity_probe'; end;$$;commit;`); }
  catch (error) { failedAsExpected = String(error).includes("ovd570_atomicity_probe"); if (!failedAsExpected) throw error; }
  if (!failedAsExpected || psql(catalogSql) !== before) throw new Error("atomic_rollback_catalog_mismatch");
  sql(`begin;${migration}commit;`);
  const result = { migrationSha256, baselineMigrations:112, targetApplications:1,
    atomicFailureObserved:failedAsExpected, exactRollbackCatalogMatched:true, suites:[] };
  save("ovd570-atomicity.json", result);
  // Unlike a schema-only restore, source migrations already seed rollout rows.
  if (sql("select count(*)=4 and bool_and(not enabled and revision=0) from private.commercial_rollout_controls;") !== "t") {
    throw new Error("source_rollout_defaults_drift");
  }
  sql("create extension if not exists pgtap with schema extensions;");
  for (const suite of testSuites) {
    const tap = sql("set search_path=public,extensions; set statement_timeout='30s'; set ovd.test_conninfo='dbname=postgres user=postgres';\n"
      + readFileSync(join(root,suite.path),"utf8"),"postgres",suite.user ?? "postgres");
    const count = tap.match(/^ok\b/gm)?.length ?? 0;
    const receipt = {path:suite.path,count,expected:suite.count,tap};
    result.suites.push(receipt); save("ovd570-suite-progress.json",result);
    if (count !== suite.count || /not ok|Looks like you failed/i.test(tap)) throw new Error(`sourcing_suite_failed:${suite.path}:${count}`);
  }
  const serviceSql = (query) => sql(`set role service_role; set request.jwt.claims='{"role":"service_role"}'; ${query}`, "ovd570_fixture");
  const workerInputQuery = `select jsonb_build_object('part',to_jsonb(part),'cadFile',to_jsonb(cad),
    'drawingFile',to_jsonb(drawing),'requirement',to_jsonb(requirement),'vendor','xometry','requestedQuantity',1)
    from public.parts part join public.approved_part_requirements requirement on requirement.part_id=part.id
    left join public.job_files cad on cad.id=part.cad_file_id
    left join public.job_files drawing on drawing.id=part.drawing_file_id
    where part.id='89000000-0000-4000-8000-000000000005';`;
  const buildWorkerScope = () => {
    const input = JSON.parse(sql(workerInputQuery, "ovd570_fixture"));
    input.sourcingIntent = JSON.parse(serviceSql("select public.api_get_worker_sourcing_intent('89000000-0000-4000-8000-000000000004','89000000-0000-4000-8000-000000000005');"));
    return JSON.parse(run(process.execPath, ["--experimental-strip-types", "scripts/check-sourcing-worker-scope.mjs"], JSON.stringify(input)));
  };
  const worker = buildWorkerScope();
  if (!worker.scope) throw new Error(`worker_scope_build_failed:${worker.error}`);
  const workerScopeSql = `${literal(JSON.stringify(worker.scope))}::jsonb`;
  const parity = JSON.parse(sql(`select jsonb_build_object(
    'semanticEqual',${workerScopeSql}=private.build_quote_lane_scope_snapshot('89000000-0000-4000-8000-000000000005','xometry',1),
    'sqlFingerprint',private.quote_scope_fingerprint(private.build_quote_lane_scope_snapshot('89000000-0000-4000-8000-000000000005','xometry',1)),
    'workerFingerprint',private.quote_scope_fingerprint(${workerScopeSql}));`, "ovd570_fixture"));
  const permit = JSON.parse(sql(`select jsonb_build_object('taskId',p.work_queue_task_id,'resultId',p.vendor_quote_result_id,
    'fingerprint',p.scope_fingerprint,'claimedAt',task.locked_at) from private.xometry_beta_dispatch_permits p
    join public.work_queue task on task.id=p.work_queue_task_id
    where p.part_id='89000000-0000-4000-8000-000000000005';`, "ovd570_fixture"));
  serviceSql(`select public.api_register_quote_request_lane(${literal(permit.resultId)}::uuid,${workerScopeSql});`);
  const authorize = (scope) => JSON.parse(serviceSql(`select public.api_authorize_xometry_beta_worker_dispatch(
    ${literal(permit.taskId)}::uuid,${literal(permit.resultId)}::uuid,${literal(JSON.stringify(scope))}::jsonb,
    'ovd570-parity',${literal(permit.claimedAt)}::timestamptz);`));
  result.workerScopeParity = { ...parity, authorized: authorize(worker.scope) };
  if (!parity.semanticEqual || !result.workerScopeParity.authorized.authorized
    || result.workerScopeParity.authorized.scopeFingerprint !== permit.fingerprint) {
    throw new Error("worker_scope_or_dispatch_parity_failed");
  }
  sql("update public.organizations set shipping_zip='85702' where id='89000000-0000-4000-8000-000000000003';", "ovd570_fixture");
  result.workerScopeParity.afterAddressEdit = { worker: buildWorkerScope(), authorization: authorize(worker.scope) };
  if (!result.workerScopeParity.afterAddressEdit.worker.error
    || result.workerScopeParity.afterAddressEdit.authorization.reasonCode !== "dispatch_current_scope_changed") {
    throw new Error("edited_destination_did_not_block_worker_and_permit");
  }
  sql(`set request.jwt.claims='{"sub":"89000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
    select public.api_confirm_sourcing_destination('89000000-0000-4000-8000-000000000003',
      public.api_get_sourcing_destination('89000000-0000-4000-8000-000000000003')->'address');`, "ovd570_fixture");
  result.workerScopeParity.afterDifferentAddressConfirmation = authorize(worker.scope);
  if (result.workerScopeParity.afterDifferentAddressConfirmation.reasonCode !== "dispatch_current_scope_changed") {
    throw new Error("changed_confirmed_destination_reused_old_permit");
  }
  sql(`update public.organizations set shipping_zip='85701' where id='89000000-0000-4000-8000-000000000003';
    set request.jwt.claims='{"sub":"89000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
    select public.api_confirm_sourcing_destination('89000000-0000-4000-8000-000000000003',
      public.api_get_sourcing_destination('89000000-0000-4000-8000-000000000003')->'address');`, "ovd570_fixture");
  result.workerScopeParity.afterRestoredAddressConfirmation = authorize(worker.scope);
  if (result.workerScopeParity.afterRestoredAddressConfirmation.reasonCode !== "dispatch_current_scope_changed") {
    throw new Error("restored_confirmed_destination_resurrected_old_permit");
  }
  sql(`update public.approved_part_requirements set requested_by_date=current_date+12
      where part_id='89000000-0000-4000-8000-000000000005';
    set request.jwt.claims='{"sub":"89000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
    select public.api_confirm_part_deadline('89000000-0000-4000-8000-000000000005','A',current_date+12);`, "ovd570_fixture");
  const deadlineWorker = buildWorkerScope();
  if (!deadlineWorker.scope) throw new Error("confirmed_deadline_worker_scope_failed");
  result.workerScopeParity.confirmedDeadline = {
    scopeEqual: sql(`select ${literal(JSON.stringify(deadlineWorker.scope))}::jsonb =
      private.build_quote_lane_scope_snapshot('89000000-0000-4000-8000-000000000005','xometry',1);`, "ovd570_fixture") === "t",
    activeDate: deadlineWorker.scope.requirements.requestedDeliveryDate,
    oldPermitDecision: authorize(deadlineWorker.scope),
  };
  if (!result.workerScopeParity.confirmedDeadline.scopeEqual || !result.workerScopeParity.confirmedDeadline.activeDate
    || result.workerScopeParity.confirmedDeadline.oldPermitDecision.authorized !== false) {
    throw new Error("confirmed_deadline_scope_or_permit_binding_failed");
  }

  result.status = "passed";
  return result;
}
