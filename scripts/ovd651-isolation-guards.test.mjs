// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const releaseFile = (name) => readFileSync(path.resolve("docs/release", name), "utf8");
const normalize = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

// Source ordering checks only. Behavior under two real sessions is proven by
// scripts/ovd651-isolation-race-proof.mjs against a disposable local database.
const registryLock = "lock table engineering_private.native_verifier_registered_objects in access exclusive mode;";
const registryIsolation = "if current_setting('transaction_isolation') <> 'read committed' then raise exception 'ovd560_reverse_requires_read_committed';";
const registryEmptiness = "(select count(*) from engineering_private.native_verifier_registered_objects) <> 0";
const stepLock = "lock table engineering_private.native_step_reviews in access exclusive mode;";
const stepIsolation = "if current_setting('transaction_isolation') <> 'read committed' then raise exception 'ovd563_reverse_requires_read_committed';";
const stepEmptiness = "select engineering_private.assert_empty_native_step_reviews();";
const readerIsolation = "if current_setting('transaction_isolation')<>'read committed' then raise exception 'native_result_binding_read_committed_required' using errcode='42501'; end if;";
const readerFirstRead = "select * into a from public.engineering_execution_attempts";

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
  ["ovd-560-result-registry-reverse.sql", [
    "begin;", registryLock, registryIsolation, registryEmptiness,
    "drop function engineering_private.register_native_result_object(",
    "drop column attempt_id", "commit;",
  ]],
  ["ovd-563-step-review-reverse.sql", [
    "begin;", stepLock, stepIsolation, stepEmptiness,
    "drop table engineering_private.native_step_reviews;", "commit;",
  ]],
  ["native-result-reader-forward.sql", [
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
      (sql) => sql.replace(`${registryLock}\n`, "").replace("drop function engineering_private.register_native_result_object", `${registryLock}\ndrop function engineering_private.register_native_result_object`)],
    ["560 isolation guard removed", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace("raise exception 'ovd560_reverse_requires_read_committed';", "null;")],
    ["560 isolation guard weakened", "ovd-560-result-registry-reverse.sql",
      (sql) => sql.replace("<> 'read committed' then\n    raise exception 'ovd560", "= 'serializable' then\n    raise exception 'ovd560")],
    ["563 isolation guard removed", "ovd-563-step-review-reverse.sql",
      (sql) => sql.replace("raise exception 'ovd563_reverse_requires_read_committed';", "null;")],
    ["563 isolation guard after emptiness check", "ovd-563-step-review-reverse.sql",
      (sql) => sql.replace(`${stepEmptiness}\n`, "").replace("do $isolation$", `${stepEmptiness}\ndo $isolation$`)],
    ["reader isolation guard removed", "native-result-reader-forward.sql",
      (sql) => sql.replace("raise exception 'native_result_binding_read_committed_required' using errcode='42501'; end if;", "null; end if;")],
    ["reader isolation guard after authority read", "native-result-reader-forward.sql",
      (sql) => sql.replace(/ -- SHARE locks[\s\S]*?using errcode='42501'; end if;\n/, "")
        .replace("p_task for update;\n", `p_task for update;\n ${readerIsolation}\n`)],
  ];

  it.each(mutations)("rejects %s", (_name, file, mutate) => {
    const original = releaseFile(file);
    const changed = mutate(original);
    expect(changed).not.toBe(original);
    const sequence = cases.find(([name]) => name === file)[1];
    expect(ordered(changed, sequence)).toBe(false);
  });
});
