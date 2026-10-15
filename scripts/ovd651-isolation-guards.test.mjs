// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const releaseFile = (name) => readFileSync(path.resolve("docs/release", name), "utf8");
const normalize = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

// Source ordering checks only. Behavior under two real sessions is proven by
// scripts/ovd651-isolation-race-proof.mjs against a disposable local database.
const advisory = "select pg_advisory_xact_lock(510, 2);";
const registryLock = "lock table public.engineering_execution_attempts, public.engineering_snapshots, storage.objects, engineering_private.native_verifier_registered_objects in access exclusive mode;";
const registryIsolation = "if current_setting('transaction_isolation') <> 'read committed' then raise exception 'ovd560_reverse_requires_read_committed';";
const registryEmptiness = "(select count(*) from engineering_private.native_verifier_registered_objects) <> 0";
const stepLock = "lock table engineering_private.native_step_reviews in access exclusive mode;";
const stepIsolation = "if current_setting('transaction_isolation') <> 'read committed' then raise exception 'ovd563_reverse_requires_read_committed';";
const stepEmptiness = "select engineering_private.assert_empty_native_step_reviews();";
const isolation = (tag) => `if current_setting('transaction_isolation') <> 'read committed' then raise exception '${tag}_reverse_requires_read_committed';`;
const reverse560Lock = "lock table public.engineering_execution_attempts, public.engineering_snapshots,\n  storage.objects, engineering_private.native_verifier_registered_objects\n  in access exclusive mode;\n";
const timeouts = ["set local lock_timeout = '5s';", "set local statement_timeout = '30s';"];
const readerIsolation = "if current_setting('transaction_isolation')<>'read committed' then raise exception 'native_result_binding_read_committed_required' using errcode='42501'; end if;";
const readerFirstRead = "select * into a from public.engineering_execution_attempts";
// Every window 2 forward: READ COMMITTED (0A000), then the shared lock, first.
const forwardGuard = (tag) => [
  `if current_setting('transaction_isolation') <> 'read committed' then raise exception '${tag}_forward_read_committed_required' using errcode = '0A000';`,
  advisory,
];

// Each guard must appear exactly once, in order, before the first destructive
// or authority reading statement.
function ordered(sql, sequence) {
  const text = normalize(sql);
  let cursor = -1;
  for (const fragment of sequence) {
    const at = text.indexOf(fragment);
    if (at < 0 || at <= cursor || text.indexOf(fragment, at + 1) >= 0) return false;
    cursor = at;
  }
  return true;
}

const cases = [
  // Every window 2 reverse: timeouts, READ COMMITTED refusal, the shared
  // reverse lock (also taken by the OVD-558 reverse), then relation locks.
  ["ovd-560-result-registry-reverse.sql", [
    "begin;", ...timeouts, registryIsolation, advisory, registryLock, registryEmptiness,
    "drop function engineering_private.register_native_result_object(",
    "drop column attempt_id", "commit;",
  ]],
  ["ovd-563-step-review-reverse.sql", [
    "begin;", ...timeouts, stepIsolation, advisory, stepLock, stepEmptiness,
    "drop table engineering_private.native_step_reviews;", "commit;",
  ]],
  ["ovd-561-finalization-reverse.sql", [
    "begin;", "set local lock_timeout='5s';", "set local statement_timeout='30s';",
    "if current_setting('transaction_isolation')<>'read committed' then raise exception 'ovd561_reverse_requires_read_committed';",
    advisory,
    "lock table engineering_private.native_receipt_key, engineering_private.native_finalizations in access exclusive mode;",
    "or exists(select 1 from engineering_private.native_finalizations) then raise exception 'ovd561_reverse_requires_empty_history';",
    "if to_regclass('engineering_private.native_pending_finalizations') is not null then raise exception 'ovd561_reverse_requires_pending_reverse_first';",
    "drop function engineering_private.finalize_native_result(", "drop table engineering_private.native_receipt_key;", "commit;",
  ]],
  ["ovd561-pending-reverse.sql", [
    "begin;", ...timeouts, isolation("ovd561_pending"), advisory,
    "lock table engineering_private.native_pending_finalizations in access exclusive mode;",
    "or exists (select 1 from engineering_private.native_pending_finalizations) then",
    "drop table engineering_private.native_pending_finalizations;", "commit;",
  ]],
  ["native-result-reader-reverse.sql", [
    "begin;", ...timeouts, isolation("native_result_binding"), advisory,
    "lock table engineering_private.native_result_read_bindings in access exclusive mode;",
    "or exists (select 1 from engineering_private.native_result_read_bindings) then",
    "drop table engineering_private.native_result_read_bindings;", "commit;",
  ]],
  ["private-artifact-reverse.sql", [
    "begin;", ...timeouts,
    "if current_setting('transaction_isolation') <> 'read committed' then raise exception 'Private artifact rollback requires READ COMMITTED.';",
    advisory,
    "lock table public.engineering_execution_attempts, engineering_private.native_input_admissions, storage.objects, storage.buckets, engineering_private.native_artifact_inputs, engineering_private.native_artifact_outputs in access exclusive mode;",
    "if exists (select 1 from engineering_private.native_artifact_inputs)",
    "drop table engineering_private.native_artifact_outputs;", "commit;",
  ]],
  ["private-artifact-forward.sql", [
    "begin;", ...timeouts, ...forwardGuard("private_artifact"), "create table engineering_private.native_artifact_inputs (",
  ]],
  ["native-artifact-mapping-reverse.sql", [
    "begin;", ...timeouts,
    "if current_setting('transaction_isolation') <> 'read committed' then raise exception 'native_mapping_reverse_requires_read_committed' using errcode = '0A000';",
    advisory, "raise exception 'native_mapping_reverse_preflight_failed';",
    "drop function engineering_private.write_native_artifact_mappings(uuid,text,text) restrict;", "commit;",
  ]],
  ["native-artifact-mapping-forward.sql", [
    "begin;", "set local lock_timeout='5s';", "set local statement_timeout='30s';", ...forwardGuard("native_mapping"),
    "create function engineering_private.prepare_native_artifact_inputs(",
  ]],
  ["ovd-560-result-registry-forward.sql", [
    "begin;", ...timeouts, ...forwardGuard("ovd560"),
    "lock table public.engineering_execution_attempts, public.engineering_snapshots, storage.objects in share row exclusive mode;",
    "lock table engineering_private.native_verifier_registered_objects in access exclusive mode;",
    "raise exception 'ovd560_requires_empty_ovd558_registry_owned_by_postgres';",
    "alter table engineering_private.native_verifier_registered_objects", "commit;",
  ]],
  ["ovd-561-finalization-forward.sql", [
    "begin;", ...timeouts, ...forwardGuard("ovd561"), "create table engineering_private.native_receipt_key (",
  ]],
  ["ovd561-pending-forward.sql", [
    "begin;", ...timeouts, ...forwardGuard("ovd561_pending"), "raise exception 'ovd561_pending_preflight_failed';",
    "create table engineering_private.native_pending_finalizations (",
  ]],
  ["ovd-563-step-review-forward.sql", [
    "begin;", ...timeouts, ...forwardGuard("ovd563"), "create table engineering_private.native_step_reviews (",
  ]],
  ["native-result-reader-forward.sql", [
    "begin;", "set local lock_timeout = '5s';", "set local statement_timeout = '30s';", ...forwardGuard("native_result_binding"),
    "or to_regclass('engineering_private.native_result_read_bindings') is not null then raise exception 'native_result_binding_preflight_failed';",
    "create table engineering_private.native_result_read_bindings (",
    "if current_user<>'postgres' then raise exception 'native_result_binding_owner_required'",
    readerIsolation, readerFirstRead,
    "lock table engineering_private.native_admission_revocations",
    "insert into engineering_private.native_result_read_bindings",
  ]],
];

describe("OVD-651 staged result SQL isolation guards", () => {
  it.each(cases)("%s checks under lock in READ COMMITTED before mutating", (file, sequence) => {
    expect(ordered(releaseFile(file), sequence)).toBe(true);
  });

  const mutations = [
    ["560 emptiness check before lock", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace(reverse560Lock, "").replace("drop function engineering_private.register_native_result_object", `${registryLock}\ndrop function engineering_private.register_native_result_object`)],
    ["560 registry locked before storage.objects", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace("  storage.objects, engineering_private.native_verifier_registered_objects", "  engineering_private.native_verifier_registered_objects, storage.objects")],
    ["560 storage.objects not locked", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace("  storage.objects, engineering_private", "  engineering_private")],
    ["560 attempts not locked before storage.objects", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace("lock table public.engineering_execution_attempts, public.engineering_snapshots,\n  storage.objects", "lock table storage.objects")],
    ["560 forward without the shared lock", "ovd-560-result-registry-forward.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["560 forward registry locked before storage.objects", "ovd-560-result-registry-forward.sql",
      (sql) => sql.replace("lock table public.engineering_execution_attempts, public.engineering_snapshots, storage.objects\n  in share row exclusive mode;\nlock table engineering_private.native_verifier_registered_objects in access exclusive mode;",
        "lock table engineering_private.native_verifier_registered_objects in access exclusive mode;\nlock table public.engineering_execution_attempts, public.engineering_snapshots, storage.objects\n  in share row exclusive mode;")],
    ["561 reverse without the pending refusal", "ovd-561-finalization-reverse.sql",
      (sql) => sql.replace("raise exception 'ovd561_reverse_requires_pending_reverse_first';", "null;")],
    ["561 forward isolation guard removed", "ovd-561-finalization-forward.sql",
      (sql) => sql.replace("raise exception 'ovd561_forward_read_committed_required' using errcode = '0A000';", "null;")],
    ["pending forward without the shared lock", "ovd561-pending-forward.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["563 forward without the shared lock", "ovd-563-step-review-forward.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["mapping forward isolation guard removed", "native-artifact-mapping-forward.sql",
      (sql) => sql.replace("raise exception 'native_mapping_forward_read_committed_required' using errcode = '0A000';", "null;")],
    ["mapping reverse without the shared lock", "native-artifact-mapping-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["560 shared reverse lock removed", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["560 shared reverse lock after relation lock", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "").replace("do $preflight$", `${advisory}\ndo $preflight$`)],
    ["560 isolation guard removed", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace("raise exception 'ovd560_reverse_requires_read_committed';", "null;")],
    ["560 isolation guard weakened", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace("<> 'read committed' then\n    raise exception 'ovd560", "= 'serializable' then\n    raise exception 'ovd560")],
    ["561 statement timeout removed", "ovd-561-finalization-reverse.sql",
      (sql) => sql.replace("set local statement_timeout='30s';\n", "")],
    ["561 shared reverse lock removed", "ovd-561-finalization-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["561 isolation guard only after lock", "ovd-561-finalization-reverse.sql",
      (sql) => sql.replace(/do \$isolation\$[\s\S]*?end \$isolation\$;\n/, "")],
    ["563 shared reverse lock after relation lock", "ovd-563-step-review-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "").replace(`${stepLock}\n`, `${stepLock}\n${advisory}\n`)],
    ["pending shared reverse lock removed", "ovd561-pending-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["reader reverse shared lock removed", "native-result-reader-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["private artifact reverse timeouts removed", "private-artifact-reverse.sql",
      (sql) => sql.replace("set local lock_timeout = '5s';\n", "")],
    ["private artifact reverse shared lock removed", "private-artifact-reverse.sql",
      (sql) => sql.replace(`${advisory}\n`, "")],
    ["private artifact reverse mapping locked before storage", "private-artifact-reverse.sql",
      (sql) => sql.replace("  storage.objects, storage.buckets,\n  engineering_private.native_artifact_inputs,\n  engineering_private.native_artifact_outputs",
        "  engineering_private.native_artifact_inputs,\n  engineering_private.native_artifact_outputs, storage.objects, storage.buckets")],
    ["private artifact reverse parents not locked first", "private-artifact-reverse.sql",
      (sql) => sql.replace("lock table public.engineering_execution_attempts,\n  engineering_private.native_input_admissions,\n  storage.objects", "lock table storage.objects")],
    ["private artifact forward statement timeout removed", "private-artifact-forward.sql",
      (sql) => sql.replace("set local statement_timeout = '30s';\n", "")],
    ["563 isolation guard removed", "ovd-563-step-review-reverse.sql",
      (sql) => sql.replace("raise exception 'ovd563_reverse_requires_read_committed';", "null;")],
    ["563 isolation guard after emptiness check", "ovd-563-step-review-reverse.sql",
      (sql) => sql.replace(`${stepEmptiness}\n`, "").replace("do $isolation$", `${stepEmptiness}\ndo $isolation$`)],
    ["reader isolation guard removed", "native-result-reader-forward.sql",
      (sql) => sql.replace("raise exception 'native_result_binding_read_committed_required' using errcode='42501'; end if;", "null; end if;")],
    ["reader isolation guard after authority read", "native-result-reader-forward.sql",
      (sql) => sql.replace(/ -- SHARE locks[\s\S]*?using errcode='42501'; end if;\n/, "")
        .replace("p_task for update;\n", `p_task for update;\n ${readerIsolation}\n`)],
    ["reader forward preflight removed", "native-result-reader-forward.sql",
      (sql) => sql.replace("raise exception 'native_result_binding_preflight_failed';", "null;")],
    ["reader forward unbounded lock wait", "native-result-reader-forward.sql",
      (sql) => sql.replace("set local lock_timeout = '5s';", "")],
  ];

  it.each(mutations)("rejects %s", (_name, file, mutate) => {
    const original = releaseFile(file);
    const changed = mutate(original);
    expect(changed).not.toBe(original);
    const sequence = cases.find(([name]) => name === file)[1];
    expect(ordered(changed, sequence)).toBe(false);
  });
});
